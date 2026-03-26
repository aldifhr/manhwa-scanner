import { getChapterNumber, normalizeTitleKey, normalizeChapterIdentity } from "../domain/manga.js";
import { normalizeSourceUrl } from "../domain/source.js";
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
} from "../runtimeConfig.js";
import { sendToChannelsLimited } from "./discordRateLimiter.js";

const LOG_SUMMARY_SAMPLE_LIMIT = 3;
const CLAIM_STATUS_PENDING = "pending";
const CLAIM_STATUS_SENT = "sent";
const CROSS_SOURCE_DEDUPE_TTL_SEC = RECENT_LIST_TTL_SEC;

function parseClaimState(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return { status: value, claimedAt: null, sentAt: null };
  }
  if (typeof value === "object") {
    return {
      status: typeof value.status === "string" ? value.status : null,
      claimedAt: value.claimedAt || null,
      sentAt: value.sentAt || null,
    };
  }
  return null;
}

function isBlockingClaim(value, pendingStaleMs, nowMs = Date.now()) {
  const claim = parseClaimState(value);
  if (!claim?.status) return false;
  if (claim.status === CLAIM_STATUS_SENT) return true;
  if (claim.status !== CLAIM_STATUS_PENDING) return true;
  const claimedAtMs = claim.claimedAt ? new Date(claim.claimedAt).getTime() : NaN;
  if (!Number.isFinite(claimedAtMs)) return false;
  return nowMs - claimedAtMs < pendingStaleMs;
}

async function claimPendingChapter(redis, key, nowIso, pendingClaimTtl, pendingStaleMs) {
  const claimPayload = {
    status: CLAIM_STATUS_PENDING,
    claimedAt: nowIso,
  };
  const claimed = await redis.set(key, claimPayload, {
    ex: pendingClaimTtl,
    nx: true,
  });
  if (claimed) return true;

  const existing = await redis.get(key);
  if (isBlockingClaim(existing, pendingStaleMs)) {
    return false;
  }

  await redis.del(key);
  const retried = await redis.set(key, claimPayload, {
    ex: pendingClaimTtl,
    nx: true,
  });
  return Boolean(retried);
}

async function flushWriteTasks(writeTasks = [], writeTaskBatch = DEFAULT_DISPATCH_WRITE_TASK_BATCH) {
  for (let i = 0; i < writeTasks.length; i += writeTaskBatch) {
    await Promise.all(writeTasks.slice(i, i + writeTaskBatch));
  }
}

function buildCronLogSummary(items = [], failed = 0) {
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
      time: new Date().toISOString(),
      message: `Cron sent ${items.length} chapter(s)${failedText}${detailText}`,
      tag: failed > 0 ? "partial" : "sent",
      code: failed > 0 ? "dispatch_partial" : "dispatch_sent",
      type: "delivery_summary",
      source: "dispatch",
    }),
    count: items.length,
    failed,
    titles: items.slice(0, 10).map((item) => item.title).filter(Boolean),
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

  if (existingMs !== null && candidateMs !== null && candidateMs !== existingMs) {
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

  const existingFlags = validChapterMeta.length
    ? await redis.mget(...validChapterMeta.map((entry) => entry.key))
    : [];
  const duplicateKeys = [...new Set(
    validChapterMeta.map((entry) => entry.duplicateKey).filter(Boolean),
  )];
  const duplicateValues = duplicateKeys.length
    ? await redis.mget(...duplicateKeys)
    : [];
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
    if (preferred !== entry || injectedDuplicateKeys.has(entry.duplicateKey)) continue;
    injectedDuplicateKeys.add(entry.duplicateKey);
    dedupedMeta.push(entry);
  }

  const limit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : Infinity;
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
      await redis.del(key);
      log(`Skip (dedupe): ${item.title} ${item.chapter}`);
      skipped += 1;
      continue;
    }

    const sendResult = await sendToChannelsLimited({
      sendFn: sendEmbed,
      item,
      channelIds,
      redis,
      onError: (err, channelId) => {
        warn(`Failed ${String(channelId).slice(-4)}: ${err.message}`);
        if (typeof onChannelError === "function") {
          return onChannelError(err, channelId, item);
        }
        return null;
      },
    });
    const success = sendResult.success > 0;

    if (!success) {
      await Promise.all([
        redis.del(key),
        duplicateKey ? redis.del(duplicateKey) : Promise.resolve(0),
      ]);
      warn(`All guilds failed "${item.title}" - released`);
      failed += sendResult.failed;
      continue;
    }

    log(`Sent chapter "${item.title}" to ${sendResult.success} channels`);
    const titleKey = normalizeTitleKey(item.title);
    const writeTasks = [
      redis.set(key, {
        status: CLAIM_STATUS_SENT,
        claimedAt: nowIso,
        sentAt: nowIso,
      }, {
        ex: chapterTtl,
      }),
      redis.set(`manga:last_update:${titleKey}`, nowIso),
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
        redis.set(duplicateKey, {
          status: CLAIM_STATUS_SENT,
          claimedAt: nowIso,
          sentAt: nowIso,
        }, {
          ex: crossSourceDedupeTtl,
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

  const summaryLog = typeof buildSummaryLog === "function"
    ? buildSummaryLog(sentItems, failed)
    : buildCronLogSummary(sentItems, failed);
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

  return {
    sent,
    skipped,
    failed,
    processed: queueState.queuedMeta.length,
    matched: matched.length,
    wouldSend: queueState.unsentMeta.length,
  };
}
