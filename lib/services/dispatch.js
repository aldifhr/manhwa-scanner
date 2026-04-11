import {
  createWhitelistMatcher,
  normalizeChapterIdentity,
  normalizeSourceUrl,
  normalizeTitleKey,
} from "../domain.js";
import { fetchIkiruRecentChaptersFromLatestPage } from "../scrapers/ikiru.js";

import {
  batchGet,
  batchSet,
  getAllGuildChannels,
  loadWhitelist,
  redis,
} from "../redis.js";
import { getMangaSubscribers } from "./notifications.js";
import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
  invalidateDashboardCaches,
} from "../cacheKeys.js";
import { appendCronLog, normalizeCronLogEntry } from "../cronLogs.js";
import {
  CHAPTER_PENDING_TTL_SEC,
  CHAPTER_TTL_SEC,
  DEFAULT_CHAPTER_DISPATCH_CONCURRENCY,
  DEFAULT_DISPATCH_WRITE_TASK_BATCH,
  RECENT_LIST_TTL_SEC,
  resolvePositiveInt,
} from "../config.js";
import { chunkArray, compactArray, uniqueBy } from "../utils.js";
import { safeJsonParse } from "../dateUtils.js";
import { getLogger } from "../logger.js";
import Bottleneck from "bottleneck";
import pLimit from "p-limit";

const logger = getLogger({ scope: "dispatch" });

// ============ DISCORD RATE LIMITING (merged from discordRateLimiter.js) ============
const discordSendLimiter = new Bottleneck({
  maxConcurrent: Number(process.env.DISCORD_SEND_MAX_CONCURRENT || 10),
  minTime: Number(process.env.DISCORD_SEND_MIN_TIME_MS || 50),
});

async function scheduleDiscordSend(sendFn, item, channelId, redis, mentions = "") {
  return discordSendLimiter.schedule(() => sendFn(item, channelId, redis, mentions));
}

async function sendToChannelsLimited({
  sendFn,
  item,
  channelIds = [],
  redis = null,
  mentions = "",
  concurrency = Number(process.env.DISCORD_CHANNEL_CONCURRENCY || 10),
  onError = null,
}) {
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return { success: 0, failed: 0 };
  }
  if (channelIds.length === 1) {
    const channelId = channelIds[0];
    try {
      const res = await scheduleDiscordSend(sendFn, item, channelId, redis, mentions);
      if (res && res.success === false) {
        if (typeof onError === "function") {
          await Promise.resolve(onError(res, channelId));
        }
        return { success: 0, failed: 1 };
      }
      return { success: 1, failed: 0 };
    } catch (err) {
      if (typeof onError === "function") {
        await Promise.resolve(onError(err, channelId));
      }
      return { success: 0, failed: 1 };
    }
  }

  const limit = pLimit(Math.max(1, concurrency));
  let successCount = 0;
  let failedCount = 0;

  await Promise.all(
    channelIds.map((channelId) =>
      limit(async () => {
        try {
          const res = await scheduleDiscordSend(sendFn, item, channelId, redis, mentions);
          if (res && res.success === false) {
            failedCount++;
            if (typeof onError === "function") {
              await Promise.resolve(onError(res, channelId));
            }
          } else {
            successCount++;
          }
        } catch (err) {
          failedCount++;
          if (typeof onError === "function") {
            await Promise.resolve(onError(err, channelId));
          }
        }
      }),
    ),
  );

  return { success: successCount, failed: failedCount };
}

// Distributed locking for batch operations to prevent race conditions
const BATCH_LOCK_KEY = "dispatch:batch:lock";
const BATCH_LOCK_TTL = 30; // seconds

async function acquireBatchLock(redisClient, operation) {
  const token = `${operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await redisClient.set(
    `${BATCH_LOCK_KEY}:${operation}`,
    token,
    {
      nx: true,
      ex: BATCH_LOCK_TTL,
    },
  );
  return acquired === "OK" ? token : null;
}

async function releaseBatchLock(redisClient, operation, token) {
  const lockKey = `${BATCH_LOCK_KEY}:${operation}`;
  if (typeof redisClient.eval === "function") {
    try {
      await redisClient.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        [lockKey],
        [token],
      );
      return;
    } catch {
      // Fall through to best-effort non-atomic path.
    }
  }

  const current = await redisClient.get(lockKey);
  if (current === token) {
    await redisClient.del(lockKey);
  }
}

async function withBatchLock(redisClient, operation, fn) {
  const token = await acquireBatchLock(redisClient, operation);
  if (!token) {
    throw new Error(
      `Could not acquire batch lock for ${operation} - another process is running`,
    );
  }

  try {
    return await fn();
  } finally {
    await releaseBatchLock(redisClient, operation, token);
  }
}

export async function loadMatchedDispatchContext({
  scrapeUpdates,
  prioritizeChannels = false,
  loadWhitelistFn = loadWhitelist,
  getChannelsFn = getAllGuildChannels,
} = {}) {
  if (typeof scrapeUpdates !== "function") {
    throw new Error("loadMatchedDispatchContext requires scrapeUpdates");
  }

  const [whitelist, guildChannels] = await Promise.all([
    loadWhitelistFn(),
    getChannelsFn(),
  ]);
  const channelIds = Object.values(guildChannels ?? {});

  if (!whitelist.length) {
    return {
      status: "empty_whitelist",
      whitelist,
      allResults: [],
      guildChannels,
      channelIds,
      matched: [],
    };
  }

  if (!channelIds.length || (prioritizeChannels && !channelIds.length)) {
    return {
      status: "no_channels",
      whitelist,
      allResults: [],
      guildChannels,
      channelIds,
      matched: [],
    };
  }

  const allResults = await scrapeUpdates(whitelist);

  const isMatched = createWhitelistMatcher(whitelist);
  const matched = allResults.filter(isMatched);

  if (!matched.length) {
    return {
      status: "no_matches",
      whitelist,
      allResults,
      guildChannels,
      channelIds,
      matched,
    };
  }

  return {
    status: "ok",
    whitelist,
    allResults,
    guildChannels,
    channelIds,
    matched,
  };
}

const LOG_SUMMARY_SAMPLE_LIMIT = 3;
const CLAIM_STATUS_PENDING = "pending";
const CLAIM_STATUS_SENT = "sent";
const CROSS_SOURCE_DEDUPE_TTL_SEC = RECENT_LIST_TTL_SEC;

export const DISPATCH_HISTORY_KEY = "dispatch:history";

/**
 * Set hash field with TTL using HPEXPIRE/HEXPIRE (Redis 7.4+)
 * Falls back to no TTL on older Redis versions
 */
async function hsetWithTTL(redisClient, key, field, value, ttlMs) {
  // Set the field
  await redisClient.hset(key, { [field]: value });

  // Try to set per-field TTL
  try {
    if (typeof redisClient.hpexpire === "function") {
      await redisClient.hpexpire(key, field, ttlMs);
    } else if (typeof redisClient.hexpire === "function") {
      await redisClient.hexpire(
        key,
        Math.ceil(ttlMs / 1000),
        "FIELDS",
        1,
        field,
      );
    }
  } catch {
    // TTL not supported, entry will be cleaned up by scanAndCleanupExpired
  }
}

/**
 * Add HPEXPIRE command to pipeline
 */
function addHexpireToPipeline(pipeline, key, field, ttlMs, redisClient) {
  if (typeof redisClient.hpexpire === "function") {
    pipeline.hpexpire(key, field, ttlMs);
  } else if (typeof redisClient.hexpire === "function") {
    pipeline.hexpire(key, Math.ceil(ttlMs / 1000), "FIELDS", 1, field);
  }
}

// Parse claim state with simplified early returns
function parseClaimState(value) {
  if (!value) return null;

  const baseState = {
    status: null,
    claimedAt: null,
    sentAt: null,
    expiresAt: null,
  };

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return { ...baseState, ...parsed };
    } catch {
      // Invalid JSON string - treat as null to prevent blocking valid claims
      return null;
    }
  }

  if (typeof value === "object") {
    return {
      status: typeof value.status === "string" ? value.status : null,
      claimedAt: value.claimedAt ?? null,
      sentAt: value.sentAt ?? null,
      expiresAt: value.expiresAt ?? null,
    };
  }

  return null;
}

function isBlockingClaim(value, pendingStaleMs, nowMs = Date.now()) {
  const claim = parseClaimState(value);
  if (!claim?.status) return false;
  if (claim.status === CLAIM_STATUS_SENT) return true;
  if (claim.status !== CLAIM_STATUS_PENDING) return true;

  const claimedAtMs = claim.claimedAt
    ? new Date(claim.claimedAt).getTime()
    : NaN;
  if (!Number.isFinite(claimedAtMs)) return false;

  return nowMs - claimedAtMs < pendingStaleMs;
}

function classifyBlockingClaim(value, pendingStaleMs, nowMs = Date.now()) {
  const claim = parseClaimState(value);
  if (!claim?.status) return null;
  if (claim.status === CLAIM_STATUS_SENT) return "sent";
  if (claim.status !== CLAIM_STATUS_PENDING) return "other";

  const claimedAtMs = claim.claimedAt
    ? new Date(claim.claimedAt).getTime()
    : NaN;
  if (!Number.isFinite(claimedAtMs)) return null;
  return nowMs - claimedAtMs < pendingStaleMs ? "pending" : null;
}

async function claimPendingChapter(
  redisClient,
  key,
  nowIso,
  pendingClaimTtl,
  pendingStaleMs,
) {
  const claimPayload = {
    status: CLAIM_STATUS_PENDING,
    claimedAt: nowIso,
    expiresAt: Date.now() + pendingClaimTtl * 1000,
  };

  const claimed = await redisClient.hsetnx(
    DISPATCH_HISTORY_KEY,
    key,
    JSON.stringify(claimPayload),
  );
  if (claimed === 1 || claimed === true) {
    // Set TTL for newly claimed field
    try {
      if (typeof redisClient.hpexpire === "function") {
        await redisClient.hpexpire(
          DISPATCH_HISTORY_KEY,
          key,
          pendingClaimTtl * 1000,
        );
      } else if (typeof redisClient.hexpire === "function") {
        await redisClient.hexpire(
          DISPATCH_HISTORY_KEY,
          Math.ceil(pendingClaimTtl),
          "FIELDS",
          1,
          key,
        );
      }
    } catch {
      // TTL not supported, entry will be cleaned up by scanAndCleanupExpired
    }
    return true;
  }

  const existingStr = await redisClient.hget(DISPATCH_HISTORY_KEY, key);
  const existing = safeJsonParse(existingStr, existingStr);

  if (isBlockingClaim(existing, pendingStaleMs)) {
    return false;
  }

  await redisClient.hset(DISPATCH_HISTORY_KEY, {
    [key]: JSON.stringify(claimPayload),
  });
  // Set TTL for overwritten stale claim
  try {
    if (typeof redisClient.hpexpire === "function") {
      await redisClient.hpexpire(
        DISPATCH_HISTORY_KEY,
        key,
        pendingClaimTtl * 1000,
      );
    } else if (typeof redisClient.hexpire === "function") {
      await redisClient.hexpire(
        DISPATCH_HISTORY_KEY,
        Math.ceil(pendingClaimTtl),
        "FIELDS",
        1,
        key,
      );
    }
  } catch {
    // TTL not supported, entry will be cleaned up by scanAndCleanupExpired
  }
  return true;
}

// Build claim payload for batch operations
const buildClaimPayload = (nowIso, pendingClaimTtl) => ({
  status: CLAIM_STATUS_PENDING,
  claimedAt: nowIso,
  expiresAt: Date.now() + pendingClaimTtl * 1000,
});

// Consolidated pipeline execution helper
async function execPipeline(redisClient, buildOperations) {
  const pipeline = redisClient.pipeline();
  buildOperations(pipeline);
  return pipeline.exec();
}

/**
 * Batch claim chapters using Redis pipeline for efficiency
 * @param {Array<{key: string, nowIso: string}>} items - Items to claim
 * @param {number} pendingClaimTtl - TTL for pending claims
 * @param {number} pendingStaleMs - Stale threshold
 * @returns {Promise<Array<boolean>>} - Claim results
 */
async function batchClaimPendingChapters(
  redisClient,
  items,
  pendingClaimTtl,
  pendingStaleMs,
) {
  if (!items?.length) return [];

  return await withBatchLock(redisClient, "claim", async () => {
    // Try to claim all atomically with hsetnx
    const hsetnxResults = await execPipeline(redisClient, (pipeline) => {
      for (const { key, nowIso } of items) {
        pipeline.hsetnx(
          DISPATCH_HISTORY_KEY,
          key,
          JSON.stringify(buildClaimPayload(nowIso, pendingClaimTtl)),
        );
      }
    });

    // Set TTL for all newly claimed fields (successful hsetnx)
    const newlyClaimed = hsetnxResults
      .map((result, index) =>
        result === 1 || result === true ? items[index].key : null,
      )
      .filter(Boolean);

    if (newlyClaimed.length) {
      await execPipeline(redisClient, (pipeline) => {
        for (const key of newlyClaimed) {
          addHexpireToPipeline(
            pipeline,
            DISPATCH_HISTORY_KEY,
            key,
            pendingClaimTtl * 1000,
            redisClient,
          );
        }
      });
    }

    // Identify failed claims needing verification
    const needsCheck = hsetnxResults
      .map((result, index) =>
        result !== 1 && result !== true
          ? { index, key: items[index].key }
          : null,
      )
      .filter(Boolean);

    if (!needsCheck.length)
      return hsetnxResults.map((r) => r === 1 || r === true);

    // Batch get existing states for failed claims
    const existingStrs = await redisClient.hmget(
      DISPATCH_HISTORY_KEY,
      ...needsCheck.map((n) => n.key),
    );

    const nowMs = Date.now();
    const toOverwrite = needsCheck.filter(({ index }, i) => {
      const existing = safeJsonParse(existingStrs[i], existingStrs[i]);
      return !isBlockingClaim(existing, pendingStaleMs, nowMs);
    });

    // Batch overwrite stale claims
    if (toOverwrite.length) {
      await execPipeline(redisClient, (pipeline) => {
        for (const { index, key } of toOverwrite) {
          pipeline.hset(DISPATCH_HISTORY_KEY, {
            [key]: JSON.stringify(
              buildClaimPayload(items[index].nowIso, pendingClaimTtl),
            ),
          });
          addHexpireToPipeline(
            pipeline,
            DISPATCH_HISTORY_KEY,
            key,
            pendingClaimTtl * 1000,
            redisClient,
          );
        }
      });

      // Mark as successful in results
      for (const { index } of toOverwrite) {
        hsetnxResults[index] = 1;
      }
    }

    return hsetnxResults.map((r) => r === 1 || r === true);
  });
}

/**
 * Batch mark chapters as sent using pipeline
 * @param {Array<{key: string, nowIso: string}>} items - Items to mark sent
 */
async function batchMarkChaptersSent(redisClient, items, chapterTtl = CHAPTER_TTL_SEC) {
  if (!items?.length) return;

  await withBatchLock(redisClient, "mark-sent", async () => {
    await execPipeline(redisClient, (pipeline) => {
      for (const { key, nowIso } of items) {
        pipeline.hset(DISPATCH_HISTORY_KEY, {
          [key]: JSON.stringify({
            status: CLAIM_STATUS_SENT,
            sentAt: nowIso,
            expiresAt: Date.now() + chapterTtl * 1000,
          }),
        });
        addHexpireToPipeline(
          pipeline,
          DISPATCH_HISTORY_KEY,
          key,
          chapterTtl * 1000,
          redisClient,
        );
      }
    });
  });
}

async function flushWriteTasks(
  writeTasks = [],
  writeTaskBatch = DEFAULT_DISPATCH_WRITE_TASK_BATCH,
) {
  for (let i = 0; i < writeTasks.length; i += writeTaskBatch) {
    await Promise.all(writeTasks.slice(i, i + writeTaskBatch));
  }
}

/**
 * Optimized dispatch using batch operations
 * @param {Array} chapters - Chapters to dispatch
 * @param {Array<string>} channelIds - Channel IDs
 * @param {Object} options - Options
 * @returns {Promise<{sent: number, skipped: number, failed: number}>}
 */
export async function dispatchChaptersBatch(
  chapters,
  channelIds,
  options = {},
) {
  const {
    redis: redisClient = redis,
    pendingClaimTtl = CHAPTER_PENDING_TTL_SEC,
    pendingStaleMs = 30000,
    writeTaskBatch = DEFAULT_DISPATCH_WRITE_TASK_BATCH,
    concurrency = 5,
    chapterTtl = CHAPTER_TTL_SEC,
  } = options;

  if (!chapters?.length || !channelIds?.length) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const nowIso = new Date().toISOString();
  const results = { sent: 0, skipped: 0, failed: 0 };

  // Prepare all claim keys
  const claimItems = chapters.map((chapter) => ({
    key: normalizeChapterIdentity(chapter),
    nowIso,
    chapter,
  }));

  // Batch claim all chapters
  const claimResults = await batchClaimPendingChapters(
    redisClient,
    claimItems,
    pendingClaimTtl,
    pendingStaleMs,
  );

  // Filter successfully claimed chapters
  const claimedChapters = claimItems
    .filter((_, i) => claimResults[i])
    .map((item) => item.chapter);

  results.skipped = chapters.length - claimedChapters.length;

  if (!claimedChapters.length) return results;

  // Build send tasks
  const sendTasks = claimedChapters.flatMap((chapter) =>
    channelIds.map((channelId) => ({ chapter, channelId })),
  );

  // Use p-limit for concurrency
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(concurrency);

  const sendResults = await Promise.allSettled(
    sendTasks.map(({ chapter, channelId }) =>
      limit(async () => {
        try {
          const { sendDiscordEmbed } = await import("../discord.js");
          await sendDiscordEmbed(chapter, channelId);
          return { success: true, chapter, channelId };
        } catch (err) {
          return { success: false, chapter, channelId, error: err.message };
        }
      }),
    ),
  );

  // Process results using reduce
  const { sentItems, failed } = sendResults.reduce(
    (acc, result) => {
      if (result.status === "fulfilled" && result.value.success) {
        acc.sentItems.push({
          key: normalizeChapterIdentity(result.value.chapter),
          nowIso,
        });
      } else {
        acc.failed++;
      }
      return acc;
    },
    { sentItems: [], failed: 0 },
  );

  results.sent = sentItems.length;
  results.failed = failed;

  // Batch mark as sent
  if (sentItems.length) {
    await batchMarkChaptersSent(redisClient, sentItems, chapterTtl);
  }

  return results;
}

function buildCronLogSummary(
  items = [],
  failed = 0,
  nowIso = new Date().toISOString(),
) {
  if (!items.length && failed <= 0) return null;

  const sample = compactArray(
    items
      .slice(0, LOG_SUMMARY_SAMPLE_LIMIT)
      .map((item) => `${item.title} ${item.chapter}`.trim()),
  );
  const remainder = Math.max(0, items.length - sample.length);
  const detailText = sample.length
    ? `: ${sample.join(", ")}${remainder ? ` (+${remainder} lagi)` : ""}`
    : "";
  const failedText = failed > 0 ? ` | failed=${failed}` : "";

  return {
    ...normalizeCronLogEntry({
      time: nowIso,
      message: `Cron sent ${items.length} chapter(s)${failedText}${detailText}`,
      tag: failed > 0 ? "partial" : "sent",
      code: failed > 0 ? "dispatch_partial" : "dispatch_sent",
      type: "delivery_summary",
      source: "dispatch",
    }),
    count: items.length,
    failed,
    titles: compactArray(items.slice(0, 10).map((item) => item.title)),
  };
}

function buildCrossSourceChapterKey(item) {
  const titleKey = normalizeTitleKey(item?.title ?? "");
  const chapterKey = normalizeChapterIdentity(item?.chapter ?? "");
  if (!titleKey || !chapterKey) return null;
  return `chapter:dedupe:${titleKey}:${chapterKey}`;
}

function getUpdatedTimeMs(item) {
  const ms = new Date(item?.updatedTime ?? "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function preferDuplicateMeta(existing, candidate) {
  const existingMs = getUpdatedTimeMs(existing?.item);
  const candidateMs = getUpdatedTimeMs(candidate?.item);

  if (
    existingMs !== null &&
    candidateMs !== null &&
    candidateMs !== existingMs
  ) {
    return candidateMs < existingMs ? candidate : existing;
  }

  return existing;
}

export function buildDispatchChapterMeta(matched = []) {
  return matched.map((item) => {
    const normalizedChapterUrl = normalizeSourceUrl(item?.url);
    return {
      item,
      key: normalizedChapterUrl ? `chapter:${normalizedChapterUrl}` : null,
      duplicateKey: buildCrossSourceChapterKey(item),
    };
  });
}

// Helper: Fetch existing flags from Redis
async function fetchExistingFlags(redisClient, keys) {
  if (!keys.length) return [];

  let results = await redisClient.hmget(DISPATCH_HISTORY_KEY, ...keys);

  // Handle object response format
  if (results && typeof results === "object" && !Array.isArray(results)) {
    results = keys.map((k) => results[k]);
  }

  return (results || []).map((j) => safeJsonParse(j, j));
}

// Helper: Build duplicate flag map from Redis results
function buildDuplicateFlagMap(duplicateKeys, duplicateValues) {
  return new Map(
    duplicateKeys.map((key, index) => [key, duplicateValues[index] ?? null]),
  );
}

// Helper: Filter claimable entries (not blocking)
function filterClaimableMeta(
  validChapterMeta,
  existingFlags,
  duplicateFlagMap,
  pendingStaleMs,
  nowMs,
) {
  return validChapterMeta.filter(
    (_, i) =>
      !isBlockingClaim(existingFlags[i], pendingStaleMs, nowMs) &&
      !isBlockingClaim(
        duplicateFlagMap.get(validChapterMeta[i].duplicateKey),
        pendingStaleMs,
        nowMs,
      ),
  );
}

// Helper: Select preferred entries for each duplicate key using Map-based O(n) approach
function selectPreferredEntries(claimableMeta) {
  const preferredByDuplicateKey = new Map();
  let duplicateCount = 0;

  for (const entry of claimableMeta) {
    if (!entry.duplicateKey) continue;

    const existing = preferredByDuplicateKey.get(entry.duplicateKey);
    if (!existing) {
      preferredByDuplicateKey.set(entry.duplicateKey, entry);
      continue;
    }

    duplicateCount++;
    preferredByDuplicateKey.set(
      entry.duplicateKey,
      preferDuplicateMeta(existing, entry),
    );
  }

  return { preferredByDuplicateKey, duplicateCount };
}

// Helper: Build deduplicated queue from preferred entries
function buildDedupedQueue(claimableMeta, preferredByDuplicateKey) {
  const injectedDuplicateKeys = new Set();

  return claimableMeta.reduce((deduped, entry) => {
    if (!entry.duplicateKey) {
      deduped.push(entry);
      return deduped;
    }

    const preferred = preferredByDuplicateKey.get(entry.duplicateKey);
    if (preferred !== entry || injectedDuplicateKeys.has(entry.duplicateKey)) {
      return deduped;
    }

    injectedDuplicateKeys.add(entry.duplicateKey);
    deduped.push(entry);
    return deduped;
  }, []);
}

export async function prepareDispatchQueue(
  redisClient,
  matched = [],
  maxItems = Infinity,
  pendingStaleMs = CHAPTER_PENDING_TTL_SEC * 1000,
) {
  if (!redisClient) throw new Error("prepareDispatchQueue requires redis");

  const chapterMeta = buildDispatchChapterMeta(matched);
  const validChapterMeta = chapterMeta.filter((entry) => entry.key);

  // Fetch existing flags in parallel
  const keys = validChapterMeta.map((entry) => entry.key);
  const existingFlags = await fetchExistingFlags(redisClient, keys);

  // Fetch duplicate flags
  const duplicateKeys = [
    ...new Set(validChapterMeta.map((e) => e.duplicateKey).filter(Boolean)),
  ];
  const duplicateValues = await fetchExistingFlags(redisClient, duplicateKeys);
  const duplicateFlagMap = buildDuplicateFlagMap(
    duplicateKeys,
    duplicateValues,
  );

  // Filter claimable entries
  const nowMs = Date.now();
  const alreadyStateBreakdown = {
    sent: 0,
    pending: 0,
    other: 0,
    duplicateSent: 0,
    duplicatePending: 0,
    duplicateOther: 0,
  };
  const alreadyStateBySource = {};
  const blockedSample = [];
  const blockedSampleLimit = 8;

  for (let i = 0; i < validChapterMeta.length; i++) {
    const entry = validChapterMeta[i];
    const source = entry?.item?.source || "unknown";
    const localState = classifyBlockingClaim(existingFlags[i], pendingStaleMs, nowMs);
    const dupState = classifyBlockingClaim(
      duplicateFlagMap.get(entry.duplicateKey),
      pendingStaleMs,
      nowMs,
    );

    if (localState === "sent") alreadyStateBreakdown.sent += 1;
    else if (localState === "pending") alreadyStateBreakdown.pending += 1;
    else if (localState === "other") alreadyStateBreakdown.other += 1;

    if (dupState === "sent") alreadyStateBreakdown.duplicateSent += 1;
    else if (dupState === "pending") alreadyStateBreakdown.duplicatePending += 1;
    else if (dupState === "other") alreadyStateBreakdown.duplicateOther += 1;

    if (localState || dupState) {
      alreadyStateBySource[source] = (alreadyStateBySource[source] || 0) + 1;
      if (blockedSample.length < blockedSampleLimit) {
        blockedSample.push({
          source,
          title: entry?.item?.title || null,
          chapter: entry?.item?.chapter || null,
          key: entry?.key || null,
          duplicateKey: entry?.duplicateKey || null,
          localState: localState || null,
          duplicateState: dupState || null,
        });
      }
    }
  }

  const claimableMeta = filterClaimableMeta(
    validChapterMeta,
    existingFlags,
    duplicateFlagMap,
    pendingStaleMs,
    nowMs,
  );

  // O(n) duplicate selection using Map
  const { preferredByDuplicateKey, duplicateCount } =
    selectPreferredEntries(claimableMeta);
  const dedupedMeta = buildDedupedQueue(claimableMeta, preferredByDuplicateKey);

  // Apply limit
  const limit = Number.isFinite(maxItems)
    ? Math.max(0, Math.floor(maxItems))
    : Infinity;
  const queuedMeta = dedupedMeta.slice(0, limit);

  return {
    chapterMeta,
    validChapterMeta,
    unsentMeta: dedupedMeta,
    queuedMeta,
    invalidCount: chapterMeta.length - validChapterMeta.length,
    alreadySentCount: validChapterMeta.length - claimableMeta.length,
    alreadyStateBreakdown,
    alreadyStateBySource,
    blockedSample,
    duplicateCount,
    overLimitCount: Math.max(0, dedupedMeta.length - queuedMeta.length),
  };
}

// Validate dispatch parameters with early returns
function validateDispatchParams(params) {
  const { redis: redisClient, sendEmbed } = params;

  if (!redisClient) throw new Error("dispatchChapters requires redis");
  if (typeof sendEmbed !== "function") {
    throw new Error("dispatchChapters requires sendEmbed function");
  }

  return true;
}

// Initialize dispatch counters
function initializeCounters() {
  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    sentItems: [],
  };
}

// Calculate initial skip count from queue state
function calculateInitialSkips(queueState) {
  return (
    queueState.invalidCount +
    queueState.alreadySentCount +
    queueState.duplicateCount +
    queueState.overLimitCount
  );
}

// Log concurrency warning if needed
function logConcurrencyWarning(concurrency, log) {
  const effectiveConcurrency = Math.max(1, concurrency);
  if (effectiveConcurrency > 1) {
    log(
      `CHAPTER_DISPATCH_CONCURRENCY=${effectiveConcurrency} requested, but chapter sends stay sequential to preserve order`,
    );
  }
}

// Build mention chunks from subscribers
function buildMentionChunks(subscribers, chunkSize) {
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    return [];
  }
  return chunkArray(subscribers, chunkSize).map((chunk) =>
    chunk.map((id) => `<@${id}>`).join(" "),
  );
}

// Send extra ping mentions
async function sendExtraPings(mentionChunks, channelIds, redisClient, warn) {
  const { sendDiscordText } = await import("../discord.js");

  for (const mChunk of mentionChunks) {
    await sendToChannelsLimited({
      sendFn: (_, channelId, __, text) => sendDiscordText(channelId, text),
      item: null,
      channelIds,
      redis: redisClient,
      mentions: mChunk,
      onError: (err) => warn(`Failed extra pings: ${err.message}`),
    });
  }
}

// Handle send failure - release claims and update counters
async function handleSendFailure(
  redisClient,
  key,
  duplicateKey,
  item,
  failedCount,
  counters,
  warn,
) {
  await Promise.all([
    redisClient.hdel(DISPATCH_HISTORY_KEY, key),
    duplicateKey
      ? redisClient.hdel(DISPATCH_HISTORY_KEY, duplicateKey)
      : Promise.resolve(0),
  ]);
  warn(`All guilds failed "${item?.title ?? "unknown"}" - released`);
  counters.failed += failedCount;
}

// Build write tasks for successful send
function buildSuccessWriteTasks({
  redis: redisClient,
  item,
  key,
  duplicateKey,
  titleKey,
  index,
  nowIso,
  chapterTtl,
  crossSourceDedupeTtl,
  onDispatchSuccess,
}) {
  const expiresAt = Date.now() + chapterTtl * 1000;

  const writeTasks = [
    (async () => {
      await hsetWithTTL(
        redisClient,
        DISPATCH_HISTORY_KEY,
        key,
        JSON.stringify({
          status: CLAIM_STATUS_SENT,
          claimedAt: nowIso,
          sentAt: nowIso,
          expiresAt,
        }),
        chapterTtl * 1000,
      );
    })(),
    (async () => {
      await redisClient.hset("manga:last_updates", { [titleKey]: nowIso });
    })(),
    (async () => {
      const chapterKey = `${item.title}:${item.chapter}:${nowIso}`;
      await redisClient.hset("recent:chapters", {
        [chapterKey]: JSON.stringify({
          title: item.title,
          chapter: item.chapter,
          url: item.url,
          cover: item.cover ?? null,
          source: item.source ?? "ikiru",
          updatedTime: item.updatedTime ?? null,
          sentAt: nowIso,
          sentOrder: index,
          expiresAt: Date.now() + RECENT_LIST_TTL_SEC * 1000,
        }),
      });
      // Add field-level TTL (Redis 7.4+)
      try {
        if (typeof redisClient.hpexpire === "function") {
          await redisClient.hpexpire(
            "recent:chapters",
            chapterKey,
            RECENT_LIST_TTL_SEC * 1000,
          );
        } else if (typeof redisClient.hexpire === "function") {
          await redisClient.hexpire(
            "recent:chapters",
            Math.ceil(RECENT_LIST_TTL_SEC),
            "FIELDS",
            1,
            chapterKey,
          );
        }
      } catch {
        // TTL not supported, rely on cleanup job
      }
    })(),
  ];

  if (duplicateKey) {
    writeTasks.push(
      (async () => {
        await hsetWithTTL(
          redisClient,
          DISPATCH_HISTORY_KEY,
          duplicateKey,
          JSON.stringify({
            status: CLAIM_STATUS_SENT,
            claimedAt: nowIso,
            sentAt: nowIso,
            expiresAt: Date.now() + crossSourceDedupeTtl * 1000,
          }),
          crossSourceDedupeTtl * 1000,
        );
      })(),
    );
  }

  if (typeof onDispatchSuccess === "function") {
    const extra = onDispatchSuccess(item);
    const extraTasks = Array.isArray(extra)
      ? extra.filter((t) => t?.then)
      : [extra].filter((t) => t?.then);
    writeTasks.push(...extraTasks);
  }

  return writeTasks;
}

// Handle send success - write to Redis and update counters
async function handleSendSuccess({
  redis: redisClient,
  item,
  key,
  duplicateKey,
  titleKey,
  index,
  nowIso,
  chapterTtl,
  crossSourceDedupeTtl,
  writeTaskBatch,
  onDispatchSuccess,
  sendResult,
  counters,
}) {
  const writeTasks = buildSuccessWriteTasks({
    redis: redisClient,
    item,
    key,
    duplicateKey,
    titleKey,
    index,
    nowIso,
    chapterTtl,
    crossSourceDedupeTtl,
    onDispatchSuccess,
  });

  await flushWriteTasks(writeTasks, writeTaskBatch);
  counters.sent += 1;
  counters.failed += sendResult.failed;
  counters.sentItems.push(item);
}

// Claim chapter with duplicate handling
async function claimChapterWithDuplicate(
  redisClient,
  key,
  duplicateKey,
  nowIso,
  pendingClaimTtl,
  pendingStaleMs,
  counters,
  item,
) {
  const claimed = await claimPendingChapter(
    redisClient,
    key,
    nowIso,
    pendingClaimTtl,
    pendingStaleMs,
  );

  if (!claimed) {
    counters.skipped += 1;
    return false;
  }

  if (duplicateKey) {
    const duplicateClaimed = await claimPendingChapter(
      redisClient,
      duplicateKey,
      nowIso,
      pendingClaimTtl,
      pendingStaleMs,
    );
    if (!duplicateClaimed) {
      await redisClient.hdel(DISPATCH_HISTORY_KEY, key);
      counters.skipped += 1;
      return false;
    }
  }

  return true;
}

// Send chapter to channels with error handling
async function sendChapterToChannels(
  sendEmbed,
  item,
  channelIds,
  redisClient,
  firstMentions,
  onChannelError,
  warn,
) {
  return sendToChannelsLimited({
    sendFn: sendEmbed,
    item,
    channelIds,
    redis: redisClient,
    mentions: firstMentions,
    onError: (err, channelId) => {
      warn(`Failed ${String(channelId).slice(-4)}: ${err.message}`);
      if (typeof onChannelError === "function") {
        return onChannelError(err, channelId, item);
      }
      return null;
    },
  });
}

function isIkiruSource(source = "") {
  return String(source || "").toLowerCase() === "ikiru";
}

function isMissingStatus(status = "") {
  const s = String(status || "").trim().toLowerCase();
  return !s || s === "unknown" || s === "n/a";
}

function isMissingRating(rating = "") {
  const r = String(rating || "").trim().toLowerCase();
  return !r || r === "n/a" || r === "unknown";
}

async function hydrateIkiruMetadataIfMissing(item, redisClient, ikiruMetaCache) {
  if (!item || !isIkiruSource(item.source)) return item;
  if (!isMissingStatus(item.status) && !isMissingRating(item.rating)) return item;

  const mangaUrl = String(item.mangaUrl || "").trim();
  if (!mangaUrl) return item;

  let cached = ikiruMetaCache.get(mangaUrl);
  if (!cached) {
    const rows = await fetchIkiruRecentChaptersFromLatestPage(mangaUrl, redisClient).catch(() => []);
    const byChapter = new Map();
    for (const row of rows) {
      const chapterKey = normalizeChapterIdentity(row?.chapter);
      if (chapterKey && !byChapter.has(chapterKey)) {
        byChapter.set(chapterKey, row);
      }
    }
    cached = {
      byChapter,
      fallback: rows[0] || null,
    };
    ikiruMetaCache.set(mangaUrl, cached);
  }

  const chapterKey = normalizeChapterIdentity(item.chapter);
  const match = (chapterKey && cached.byChapter.get(chapterKey)) || cached.fallback;
  if (!match) return item;

  return {
    ...item,
    status: isMissingStatus(item.status) ? (match.status || item.status) : item.status,
    rating: isMissingRating(item.rating) ? (match.rating || item.rating) : item.rating,
    cover: item.cover || match.cover || item.cover,
  };
}

// Process a single chapter entry - decomposed into helpers
async function processChapterEntry({
  entry,
  index,
  redis: redisClient,
  channelIds,
  sendEmbed,
  nowIso,
  pendingClaimTtl,
  pendingStaleMs,
  chapterTtl,
  crossSourceDedupeTtl,
  writeTaskBatch,
  getSubscribersFn,
  onDispatchSuccess,
  onChannelError,
  log,
  warn,
  counters,
  ikiruMetaCache,
}) {
  const { key, duplicateKey } = entry;
  let item = entry.item;

  // Claim with duplicate handling
  const claimed = await claimChapterWithDuplicate(
    redisClient,
    key,
    duplicateKey,
    nowIso,
    pendingClaimTtl,
    pendingStaleMs,
    counters,
    item,
  );

  if (!claimed) return;

  // Guard against undefined/null item
  if (!item || !item.title) {
    warn("Skipping entry with missing item or title");
    return;
  }

  item = await hydrateIkiruMetadataIfMissing(item, redisClient, ikiruMetaCache);

  // Get subscribers and build mentions
  const subscribers = await getSubscribersFn(item.title).catch(() => []);
  const titleKey = normalizeTitleKey(item.title);
  const mentionChunks = buildMentionChunks(subscribers, 50);
  const firstMentions = mentionChunks.shift() ?? "";

  // Send to channels
  const sendResult = await sendChapterToChannels(
    sendEmbed,
    item,
    channelIds,
    redisClient,
    firstMentions,
    onChannelError,
    warn,
  );

  // Send extra pings if needed
  if (sendResult.success > 0 && mentionChunks.length) {
    await sendExtraPings(mentionChunks, channelIds, redisClient, warn);
  }

  // Handle failure
  if (sendResult.success === 0) {
    await handleSendFailure(
      redisClient,
      key,
      duplicateKey,
      item,
      sendResult.failed,
      counters,
      warn,
    );
    return;
  }

  // Handle success
  log(`Sent chapter "${item.title}" to ${sendResult.success} channels`);
  await handleSendSuccess({
    redis: redisClient,
    item,
    key,
    duplicateKey,
    titleKey,
    index,
    nowIso,
    chapterTtl,
    crossSourceDedupeTtl,
    writeTaskBatch,
    onDispatchSuccess,
    sendResult,
    counters,
  });
}

// Build and log summary
async function buildAndLogSummary(
  redisClient,
  sentItems,
  failed,
  nowIso,
  buildSummaryLog,
) {
  const summaryLog =
    typeof buildSummaryLog === "function"
      ? buildSummaryLog(sentItems, failed, nowIso)
      : buildCronLogSummary(sentItems, failed, nowIso);

  if (summaryLog) {
    await appendCronLog(redisClient, summaryLog);
  }

  return summaryLog;
}

// Cleanup recent chapters list
// Uses hgetall instead of hscan (hscan not available in Upstash)
async function cleanupRecentChapters(redisClient) {
  const now = Date.now();
  const maxEntries = 100;

  try {
    // Use hgetall to get all entries (simpler, works with Upstash)
    const allEntries = await redisClient.hgetall("recent:chapters");
    if (!allEntries || typeof allEntries !== "object") {
      return;
    }

    const toDelete = [];

    // Check each entry for expiration
    for (const [field, value] of Object.entries(allEntries)) {
      const parsed =
        typeof value === "object" && value !== null
          ? value
          : typeof value === "string"
            ? safeJsonParse(value, null)
            : null;

      // Delete if invalid, expired, or missing expiry.
      if (!parsed?.expiresAt || parsed.expiresAt < now) {
        toDelete.push(field);
      }
    }

    // Delete expired entries
    if (toDelete.length > 0) {
      await redisClient.hdel("recent:chapters", ...toDelete);
    }

    // If still too many entries, delete oldest ones
    const currentCount =
      typeof redisClient.hlen === "function"
        ? await redisClient.hlen("recent:chapters")
        : Object.keys(allEntries).length - toDelete.length;

    if (currentCount > maxEntries) {
      const entries = Object.entries(allEntries)
        .filter(([k]) => !toDelete.includes(k)) // Exclude already deleted
        .map(([k, v]) => ({
          key: k,
          data:
            typeof v === "object" && v !== null
              ? v
              : typeof v === "string"
                ? safeJsonParse(v, null)
                : null,
        }))
        .filter((e) => e.data)
        .sort((a, b) => (a.data.sentOrder ?? 0) - (b.data.sentOrder ?? 0));

      // Delete oldest entries beyond maxEntries
      const toTrim = entries.slice(0, entries.length - maxEntries);
      if (toTrim.length > 0) {
        await redisClient.hdel("recent:chapters", ...toTrim.map((e) => e.key));
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, "[cleanupRecentChapters] Error");
  }
}

// Invalidate dashboard caches if needed
async function invalidateCachesIfNeeded(redisClient, sentItems, summaryLog) {
  if (sentItems.length > 0 || summaryLog) {
    await invalidateDashboardCaches(redisClient, [
      RECENT_API_CACHE_KEY,
      ...(summaryLog ? [] : [LOGS_API_CACHE_KEY]),
    ]);
  }
}

// Cleanup using hscan for better scaling (prevents memory blowup on large hashes)
export async function scanAndCleanupExpired(redisClient, nowMs) {
  try {
    const toDelete = [];
    let cursor = "0";
    const batchSize = 100;

    // Iterative scan to find expired entries
    do {
      // Upstash/ioredis: [nextCursor, [key1, val1, key2, val2, ...]]
      const results = await redisClient.hscan(DISPATCH_HISTORY_KEY, cursor, {
        count: batchSize,
      });

      if (!Array.isArray(results) || results.length < 2) break;

      cursor = String(results[0]);
      const entries = results[1];

      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          const key = entries[i];
          const rawValue = entries[i + 1];
          const value =
            typeof rawValue === "string" ? safeJsonParse(rawValue) : rawValue;
          const expiresAt = value?.expiresAt || 0;

          if (!expiresAt || expiresAt < nowMs) {
            toDelete.push(key);
          }
        }
      }

      // Safeguard: Stop if we found enough to delete in one go or if we've scanned too many
      // to avoid timing out the main function (fire-and-forget will pick up next time).
    } while (cursor !== "0" && toDelete.length < 200);

    return toDelete;
  } catch (err) {
    logger.warn({ err: err.message }, "Error scanning dispatch hash");
    return [];
  }
}

// Fire-and-forget cleanup of expired entries using optimized scan
function fireAndForgetCleanup(redisClient) {
  Promise.resolve()
    .then(async () => {
      const nowMs = Date.now();
      const toDelete = await scanAndCleanupExpired(redisClient, nowMs);

      if (toDelete.length > 0) {
        await redisClient.hdel(DISPATCH_HISTORY_KEY, ...toDelete);
      }
    })
    .catch((err) => {
      // Log error at outer level too
      logger.warn({ err: err.message }, "fireAndForgetCleanup failed");
    });
}

// Main dispatch function - now clean and focused
export async function dispatchChapters({
  redis: redisClient,
  matched = [],
  channelIds = [],
  sendEmbed,
  nowIso = new Date().toISOString(),
  chapterTtl = CHAPTER_TTL_SEC,
  pendingClaimTtl = CHAPTER_PENDING_TTL_SEC,
  crossSourceDedupeTtl = CROSS_SOURCE_DEDUPE_TTL_SEC,
  chapterConcurrency = resolvePositiveInt(
    process.env.CHAPTER_DISPATCH_CONCURRENCY,
    DEFAULT_CHAPTER_DISPATCH_CONCURRENCY,
  ),
  writeTaskBatch = DEFAULT_DISPATCH_WRITE_TASK_BATCH,
  maxItems = Infinity,
  onDispatchSuccess = null,
  onChannelError = null,
  getSubscribersFn = getMangaSubscribers,
  buildSummaryLog = buildCronLogSummary,
  log = () => {},
  warn = () => {},
  startTime = Date.now(),
  deadlineMs = 0,
} = {}) {
  // Validate inputs
  validateDispatchParams({ redis: redisClient, sendEmbed });

  // Initialize state
  const counters = initializeCounters();
  const pendingStaleMs = pendingClaimTtl * 1000;
  const ikiruMetaCache = new Map();

  // Prepare queue
  const queueState = await prepareDispatchQueue(
    redisClient,
    matched,
    maxItems,
    pendingStaleMs,
  );

  const initialSkips = calculateInitialSkips(queueState);
  counters.skipped += initialSkips;
  logConcurrencyWarning(chapterConcurrency, log);

  // Early-exit / heartbeat logic
  const deadline = deadlineMs > 0 ? startTime + deadlineMs : 0;
  const HEARTBEAT_MARGIN_MS = 2000; // 2s safety buffer
  let abortedDueToDeadline = false;

  // Process chapters with limited concurrency
  const limit = pLimit(chapterConcurrency);
  await Promise.all(
    queueState.queuedMeta.map((entry, index) =>
      limit(async () => {
        // Heartbeat check: if approaching deadline, stop taking new items
        if (deadline && Date.now() > deadline - HEARTBEAT_MARGIN_MS) {
          abortedDueToDeadline = true;
          return;
        }

        return processChapterEntry({
          entry,
          index,
          redis: redisClient,
          channelIds,
          sendEmbed,
          nowIso,
          pendingClaimTtl,
          pendingStaleMs,
          chapterTtl,
          crossSourceDedupeTtl,
          writeTaskBatch,
          getSubscribersFn,
          onDispatchSuccess,
          onChannelError,
          log,
          warn,
          counters,
          ikiruMetaCache,
        });
      }),
    ),
  );

  if (abortedDueToDeadline) {
    warn(
      `Dispatch aborted early (approaching 30s deadline). Sent=${counters.sent}, Skipped remaining.`,
    );
  }

  // Finalize
  const summaryLog = await buildAndLogSummary(
    redisClient,
    counters.sentItems,
    counters.failed,
    nowIso,
    buildSummaryLog,
  );

  await cleanupRecentChapters(redisClient);
  await invalidateCachesIfNeeded(redisClient, counters.sentItems, summaryLog);
  fireAndForgetCleanup(redisClient);

  const runtimeSkips = Math.max(0, counters.skipped - initialSkips);
  const skipBreakdown = {
    invalid: queueState.invalidCount,
    alreadySentOrPending: queueState.alreadySentCount,
    alreadyStateBreakdown: queueState.alreadyStateBreakdown || null,
    alreadyStateBySource: queueState.alreadyStateBySource || null,
    blockedSample: queueState.blockedSample || null,
    duplicate: queueState.duplicateCount,
    overLimit: queueState.overLimitCount,
    runtimeClaimOrSend: runtimeSkips,
    total: counters.skipped,
  };

  return {
    sent: counters.sent,
    skipped: counters.skipped,
    failed: counters.failed,
    sentItems: counters.sentItems,
    skipBreakdown,
  };
}
