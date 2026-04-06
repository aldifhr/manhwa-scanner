import {
  normalizeTitleKey,
  normalizeChapterIdentity,
  createWhitelistMatcher,
  normalizeSourceUrl,
} from "../domain.js";

import {
  getAllGuildChannels,
  loadWhitelist,
  redis,
  batchGet,
  batchSet,
} from "../redis.js";
import { getMangaSubscribers } from "./notifications.js";
import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
  invalidateDashboardCaches,
} from "../cacheKeys.js";
import { appendCronLog, normalizeCronLogEntry } from "../cronLogs.js";
import {
  CHAPTER_TTL_SEC,
  CHAPTER_PENDING_TTL_SEC,
  DEFAULT_CHAPTER_DISPATCH_CONCURRENCY,
  DEFAULT_DISPATCH_WRITE_TASK_BATCH,
  RECENT_LIST_TTL_SEC,
  resolvePositiveInt,
} from "../config.js";
import { sendToChannelsLimited } from "./discordRateLimiter.js";

// Distributed locking for batch operations to prevent race conditions
const BATCH_LOCK_KEY = "dispatch:batch:lock";
const BATCH_LOCK_TTL = 30; // seconds

async function acquireBatchLock(redis, operation) {
  const token = `${operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(`${BATCH_LOCK_KEY}:${operation}`, token, {
    nx: true,
    ex: BATCH_LOCK_TTL,
  });
  return acquired === "OK" ? token : null;
}

async function releaseBatchLock(redis, operation, token) {
  const current = await redis.get(`${BATCH_LOCK_KEY}:${operation}`);
  if (current === token) {
    await redis.del(`${BATCH_LOCK_KEY}:${operation}`);
  }
}

async function withBatchLock(redis, operation, fn) {
  const token = await acquireBatchLock(redis, operation);
  if (!token) {
    throw new Error(
      `Could not acquire batch lock for ${operation} - another process is running`,
    );
  }

  try {
    return await fn();
  } finally {
    await releaseBatchLock(redis, operation, token);
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
  const channelIds = Object.values(guildChannels || {});
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

  if (!channelIds.length) {
    return {
      status: "no_channels",
      whitelist,
      allResults: [],
      guildChannels,
      channelIds,
      matched: [],
    };
  }

  if (prioritizeChannels && !channelIds.length) {
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

function parseClaimState(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return {
        status: parsed.status,
        claimedAt: parsed.claimedAt || null,
        sentAt: parsed.sentAt || null,
        expiresAt: parsed.expiresAt,
      };
    } catch {
      return { status: value, claimedAt: null, sentAt: null, expiresAt: null };
    }
  }
  if (typeof value === "object") {
    return {
      status: typeof value.status === "string" ? value.status : null,
      claimedAt: value.claimedAt || null,
      sentAt: value.sentAt || null,
      expiresAt: value.expiresAt || null,
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

async function claimPendingChapter(
  redis,
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

  // Attempt to claim atomically
  const claimed = await redis.hsetnx(
    DISPATCH_HISTORY_KEY,
    key,
    JSON.stringify(claimPayload),
  );
  if (claimed === 1 || claimed === true) return true;

  const existingStr = await redis.hget(DISPATCH_HISTORY_KEY, key);
  const existing =
    existingStr && typeof existingStr === "string"
      ? JSON.parse(existingStr)
      : existingStr;

  if (isBlockingClaim(existing, pendingStaleMs)) {
    return false;
  }

  // It's stale, overwrite it
  await redis.hset(DISPATCH_HISTORY_KEY, {
    [key]: JSON.stringify(claimPayload),
  });
  return true;
}

/**
 * Batch claim chapters using Redis pipeline for efficiency
 * @param {Array<{key: string, nowIso: string}>} items - Items to claim
 * @param {number} pendingClaimTtl - TTL for pending claims
 * @param {number} pendingStaleMs - Stale threshold
 * @returns {Promise<Array<boolean>>} - Claim results
 */
async function batchClaimPendingChapters(
  redis,
  items,
  pendingClaimTtl,
  pendingStaleMs,
) {
  if (!items || items.length === 0) return [];

  // Use distributed locking to prevent race conditions
  return await withBatchLock(redis, "claim", async () => {
    // Use pipeline for batch operations
    const pipeline = redis.pipeline();
    const claimPayload = {
      status: CLAIM_STATUS_PENDING,
      expiresAt: Date.now() + pendingClaimTtl * 1000,
    };

    // First, try to claim all atomically with hsetnx
    for (const item of items) {
      const payload = {
        ...claimPayload,
        claimedAt: item.nowIso,
      };
      pipeline.hsetnx(DISPATCH_HISTORY_KEY, item.key, JSON.stringify(payload));
    }

    const hsetnxResults = await pipeline.exec();

    // Check which ones need to verify existing state
    const needsCheck = [];
    for (let i = 0; i < items.length; i++) {
      const claimed = hsetnxResults[i];
      if (claimed !== 1 && claimed !== true) {
        needsCheck.push({ index: i, key: items[i].key });
      }
    }

    // Batch get existing states for failed claims
    if (needsCheck.length > 0) {
      const existingStrs = await redis.hmget(
        DISPATCH_HISTORY_KEY,
        ...needsCheck.map((n) => n.key),
      );

      const nowMs = Date.now();
      const toOverwrite = [];

      for (let i = 0; i < needsCheck.length; i++) {
        const { index, key } = needsCheck[i];
        const existingStr = existingStrs[i];
        const existing =
          existingStr && typeof existingStr === "string"
            ? JSON.parse(existingStr)
            : existingStr;

        if (!isBlockingClaim(existing, pendingStaleMs, nowMs)) {
          // Not blocking, can overwrite
          toOverwrite.push({
            index,
            key,
            payload: {
              ...claimPayload,
              claimedAt: items[index].nowIso,
            },
          });
        }
      }

      // Batch overwrite stale claims
      if (toOverwrite.length > 0) {
        const overwritePipeline = redis.pipeline();
        for (const { key, payload } of toOverwrite) {
          overwritePipeline.hset(DISPATCH_HISTORY_KEY, {
            [key]: JSON.stringify(payload),
          });
          // Mark as successful in results
          hsetnxResults[items.findIndex((it) => it.key === key)] = 1;
        }
        await overwritePipeline.exec();
      }
    }

    // Return boolean results
    return hsetnxResults.map((result) => result === 1 || result === true);
  });
}

/**
 * Batch mark chapters as sent using pipeline
 * @param {Array<{key: string, nowIso: string}>} items - Items to mark sent
 */
async function batchMarkChaptersSent(redis, items) {
  if (!items || items.length === 0) return;

  // Use distributed locking to prevent race conditions with claim operations
  await withBatchLock(redis, "mark-sent", async () => {
    const pipeline = redis.pipeline();
    for (const { key, nowIso } of items) {
      const sentPayload = {
        status: CLAIM_STATUS_SENT,
        sentAt: nowIso,
      };
      pipeline.hset(DISPATCH_HISTORY_KEY, {
        [key]: JSON.stringify(sentPayload),
      });
    }
    await pipeline.exec();
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
  } = options;

  if (
    !chapters ||
    chapters.length === 0 ||
    !channelIds ||
    channelIds.length === 0
  ) {
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

  if (claimedChapters.length === 0) {
    return results;
  }

  // Send to channels with concurrency control
  const sendTasks = [];
  for (const chapter of claimedChapters) {
    for (const channelId of channelIds) {
      sendTasks.push({ chapter, channelId });
    }
  }

  // Use p-limit for concurrency
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(concurrency);

  const writeTasks = [];
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

  // Process results
  const sentItems = [];
  for (let i = 0; i < sendResults.length; i++) {
    const result = sendResults[i];
    if (result.status === "fulfilled" && result.value.success) {
      results.sent++;
      sentItems.push({
        key: normalizeChapterIdentity(result.value.chapter),
        nowIso,
      });
    } else {
      results.failed++;
    }
  }

  // Batch mark as sent
  if (sentItems.length > 0) {
    await batchMarkChaptersSent(redisClient, sentItems);
  }

  return results;
}

function buildCronLogSummary(
  items = [],
  failed = 0,
  nowIso = new Date().toISOString(),
) {
  if (!items.length && failed <= 0) return null;

  const sample = items
    .slice(0, LOG_SUMMARY_SAMPLE_LIMIT)
    .map((item) => `${item.title} ${item.chapter}`.trim())
    .filter(Boolean);
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
    titles: items
      .slice(0, 10)
      .map((item) => item.title)
      .filter(Boolean),
  };
}

function buildCrossSourceChapterKey(item) {
  const titleKey = normalizeTitleKey(item?.title || "");
  const chapterKey = normalizeChapterIdentity(item?.chapter || "");
  if (!titleKey || !chapterKey) return null;
  return `chapter:dedupe:${titleKey}:${chapterKey}`;
}

function getUpdatedTimeMs(item) {
  const ms = new Date(item?.updatedTime || "").getTime();
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
    const duplicateKey = buildCrossSourceChapterKey(item);
    return {
      item,
      key: normalizedChapterUrl ? `chapter:${normalizedChapterUrl}` : null,
      duplicateKey,
    };
  });
}

export async function prepareDispatchQueue(
  redis,
  matched = [],
  maxItems = Infinity,
  pendingStaleMs = CHAPTER_PENDING_TTL_SEC * 1000,
) {
  if (!redis) throw new Error("prepareDispatchQueue requires redis");

  const chapterMeta = buildDispatchChapterMeta(matched);
  const validChapterMeta = chapterMeta.filter((entry) => entry.key);

  let existingFlagsJson = validChapterMeta.length
    ? await redis.hmget(
        DISPATCH_HISTORY_KEY,
        ...validChapterMeta.map((entry) => entry.key),
      )
    : [];
  if (
    existingFlagsJson &&
    typeof existingFlagsJson === "object" &&
    !Array.isArray(existingFlagsJson)
  ) {
    existingFlagsJson = validChapterMeta.map((e) => existingFlagsJson[e.key]);
  }
  const existingFlags = (existingFlagsJson || []).map((j) =>
    typeof j === "string" ? JSON.parse(j) : j,
  );

  const duplicateKeys = [
    ...new Set(
      validChapterMeta.map((entry) => entry.duplicateKey).filter(Boolean),
    ),
  ];
  let duplicateValuesJson = duplicateKeys.length
    ? await redis.hmget(DISPATCH_HISTORY_KEY, ...duplicateKeys)
    : [];
  if (
    duplicateValuesJson &&
    typeof duplicateValuesJson === "object" &&
    !Array.isArray(duplicateValuesJson)
  ) {
    duplicateValuesJson = duplicateKeys.map((k) => duplicateValuesJson[k]);
  }
  const duplicateValues = (duplicateValuesJson || []).map((j) =>
    typeof j === "string" ? JSON.parse(j) : j,
  );
  const duplicateFlagMap = new Map(
    duplicateKeys.map((key, index) => [key, duplicateValues[index] ?? null]),
  );
  const nowMs = Date.now();
  const claimableMeta = validChapterMeta.filter(
    (_, i) =>
      !isBlockingClaim(existingFlags[i], pendingStaleMs, nowMs) &&
      !isBlockingClaim(
        duplicateFlagMap.get(validChapterMeta[i].duplicateKey),
        pendingStaleMs,
        nowMs,
      ),
  );

  let duplicateCount = 0;
  const preferredByDuplicateKey = new Map();
  for (const entry of claimableMeta) {
    if (!entry.duplicateKey) continue;
    const existing = preferredByDuplicateKey.get(entry.duplicateKey);
    if (!existing) {
      preferredByDuplicateKey.set(entry.duplicateKey, entry);
      continue;
    }
    duplicateCount += 1;
    preferredByDuplicateKey.set(
      entry.duplicateKey,
      preferDuplicateMeta(existing, entry),
    );
  }

  const dedupedMeta = [];
  const injectedDuplicateKeys = new Set();
  for (const entry of claimableMeta) {
    if (!entry.duplicateKey) {
      dedupedMeta.push(entry);
      continue;
    }

    const preferred = preferredByDuplicateKey.get(entry.duplicateKey);
    if (preferred !== entry || injectedDuplicateKeys.has(entry.duplicateKey))
      continue;
    injectedDuplicateKeys.add(entry.duplicateKey);
    dedupedMeta.push(entry);
  }

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
    duplicateCount,
    overLimitCount: Math.max(0, dedupedMeta.length - queuedMeta.length),
  };
}

export async function dispatchChapters({
  redis,
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
} = {}) {
  if (!redis) throw new Error("dispatchChapters requires redis");
  if (typeof sendEmbed !== "function") {
    throw new Error("dispatchChapters requires sendEmbed function");
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const sentItems = [];
  const pendingStaleMs = pendingClaimTtl * 1000;

  const queueState = await prepareDispatchQueue(
    redis,
    matched,
    maxItems,
    pendingStaleMs,
  );
  skipped += queueState.invalidCount;
  skipped += queueState.alreadySentCount;
  skipped += queueState.duplicateCount;
  skipped += queueState.overLimitCount;
  const effectiveChapterConcurrency = Math.max(1, chapterConcurrency);
  if (effectiveChapterConcurrency > 1) {
    log(
      `CHAPTER_DISPATCH_CONCURRENCY=${effectiveChapterConcurrency} requested, but chapter sends stay sequential to preserve order`,
    );
  }

  for (const [index, entry] of queueState.queuedMeta.entries()) {
    const { item, key, duplicateKey } = entry;
    const claimed = await claimPendingChapter(
      redis,
      key,
      nowIso,
      pendingClaimTtl,
      pendingStaleMs,
    );

    if (!claimed) {
      log(`Skip (TTL): ${item.title} ${item.chapter}`);
      skipped += 1;
      continue;
    }

    const duplicateClaimed = duplicateKey
      ? await claimPendingChapter(
          redis,
          duplicateKey,
          nowIso,
          pendingClaimTtl,
          pendingStaleMs,
        )
      : true;

    if (!duplicateClaimed) {
      await redis.hdel(DISPATCH_HISTORY_KEY, key);
      log(`Skip (dedupe): ${item.title} ${item.chapter}`);
      skipped += 1;
      continue;
    }

    const subscribers = await getSubscribersFn(item.title).catch(() => []);
    const mentionChunks = [];
    const chunkSize = 50;

    for (let i = 0; i < subscribers.length; i += chunkSize) {
      const chunk = subscribers.slice(i, i + chunkSize);
      mentionChunks.push(chunk.map((id) => `<@${id}>`).join(" "));
    }

    const firstMentions = mentionChunks.shift() || "";

    const sendResult = await sendToChannelsLimited({
      sendFn: sendEmbed,
      item,
      channelIds,
      redis,
      mentions: firstMentions,
      onError: (err, channelId) => {
        warn(`Failed ${String(channelId).slice(-4)}: ${err.message}`);
        if (typeof onChannelError === "function") {
          return onChannelError(err, channelId, item);
        }
        return null;
      },
    });

    // Kirim sisa pings jika ada lebih dari 50 pengikut
    if (sendResult.success > 0 && mentionChunks.length > 0) {
      const { sendDiscordText } = await import("../discord.js");
      for (const mChunk of mentionChunks) {
        await sendToChannelsLimited({
          sendFn: (_, channelId, __, text) => sendDiscordText(channelId, text),
          item: null,
          channelIds,
          redis,
          mentions: mChunk,
          onError: (err) => warn(`Failed extra pings: ${err.message}`),
        });
      }
    }
    const success = sendResult.success > 0;

    if (!success) {
      await Promise.all([
        redis.hdel(DISPATCH_HISTORY_KEY, key),
        duplicateKey
          ? redis.hdel(DISPATCH_HISTORY_KEY, duplicateKey)
          : Promise.resolve(0),
      ]);
      warn(`All guilds failed "${item.title}" - released`);
      failed += sendResult.failed;
      continue;
    }

    log(`Sent chapter "${item.title}" to ${sendResult.success} channels`);
    const titleKey = normalizeTitleKey(item?.title || "");
    const writeTasks = [
      redis.hset(DISPATCH_HISTORY_KEY, {
        [key]: JSON.stringify({
          status: CLAIM_STATUS_SENT,
          claimedAt: nowIso,
          sentAt: nowIso,
          expiresAt: Date.now() + chapterTtl * 1000,
        }),
      }),
      redis.hset("manga:last_updates", { [titleKey]: nowIso }),
      redis.lpush("recent:chapters", {
        title: item.title,
        chapter: item.chapter,
        url: item.url,
        cover: item.cover ?? null,
        source: item.source ?? "ikiru",
        updatedTime: item.updatedTime ?? null,
        sentAt: nowIso,
        sentOrder: index,
      }),
    ];

    if (duplicateKey) {
      writeTasks.push(
        redis.hset(DISPATCH_HISTORY_KEY, {
          [duplicateKey]: JSON.stringify({
            status: CLAIM_STATUS_SENT,
            claimedAt: nowIso,
            sentAt: nowIso,
            expiresAt: Date.now() + crossSourceDedupeTtl * 1000,
          }),
        }),
      );
    }

    if (typeof onDispatchSuccess === "function") {
      const extra = onDispatchSuccess(item);
      if (Array.isArray(extra)) {
        for (const task of extra) {
          if (task && typeof task.then === "function") writeTasks.push(task);
        }
      } else if (extra && typeof extra.then === "function") {
        writeTasks.push(extra);
      }
    }

    await flushWriteTasks(writeTasks, writeTaskBatch);
    sent += 1;
    failed += sendResult.failed;
    sentItems.push(item);
  }

  const summaryLog =
    typeof buildSummaryLog === "function"
      ? buildSummaryLog(sentItems, failed, nowIso)
      : buildCronLogSummary(sentItems, failed, nowIso);
  if (summaryLog) {
    await appendCronLog(redis, summaryLog);
  }

  await Promise.all([
    redis.ltrim("recent:chapters", 0, 99),
    redis.expire("recent:chapters", RECENT_LIST_TTL_SEC),
  ]);

  if (sentItems.length > 0 || summaryLog) {
    await invalidateDashboardCaches(redis, [
      RECENT_API_CACHE_KEY,
      ...(summaryLog ? [] : [LOGS_API_CACHE_KEY]),
    ]);
  }

  // Cleanup expired items from hash — fire-and-forget so it doesn't block the response.
  // The cleanup still completes within the same serverless invocation.
  Promise.resolve()
    .then(async () => {
      try {
        const allFields = await redis.hgetall(DISPATCH_HISTORY_KEY);
        if (allFields && typeof allFields === "object") {
          const toDelete = [];
          const nowMs = Date.now();
          for (const [k, statStr] of Object.entries(allFields)) {
            try {
              const stat =
                typeof statStr === "string" ? JSON.parse(statStr) : statStr;
              if (stat && stat.expiresAt && stat.expiresAt < nowMs) {
                toDelete.push(k);
              }
            } catch {
              /* ignore */
            }
          }
          if (toDelete.length > 0) {
            await redis.hdel(DISPATCH_HISTORY_KEY, ...toDelete);
          }
        }
      } catch (err) {
        console.warn("Error cleaning up dispatch hash:", err);
      }
    })
    .catch(() => {});

  return {
    sent,
    skipped,
    failed,
    processed: queueState.queuedMeta.length,
    matched: matched.length,
    wouldSend: queueState.unsentMeta.length,
  };
}
