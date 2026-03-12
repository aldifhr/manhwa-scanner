import pLimit from "p-limit";
import { normalizeSourceUrl } from "../domain/source.js";
import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
  SOURCE_COMPARE_CACHE_KEY,
  invalidateDashboardCaches,
} from "../cacheKeys.js";
import { normalizeCronLogEntry } from "../cronLogs.js";
import { refreshSourceCompareStateFromRecent } from "../sourceCompareState.js";
import {
  CHAPTER_TTL_SEC,
  CHAPTER_PENDING_TTL_SEC,
  CRON_LOG_LIST_TTL_SEC,
  DEFAULT_CHAPTER_DISPATCH_CONCURRENCY,
  DEFAULT_DISPATCH_WRITE_TASK_BATCH,
  RECENT_LIST_TTL_SEC,
  resolvePositiveInt,
} from "../runtimeConfig.js";
import { sendToChannelsLimited } from "./discordRateLimiter.js";

const LOG_SUMMARY_SAMPLE_LIMIT = 3;
const CLAIM_STATUS_PENDING = "pending";
const CLAIM_STATUS_SENT = "sent";

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

export function buildDispatchChapterMeta(matched = []) {
  return matched.map((item) => {
    const normalizedChapterUrl = normalizeSourceUrl(item?.url);
    return {
      item,
      key: normalizedChapterUrl ? `chapter:${normalizedChapterUrl}` : null,
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
  const nowMs = Date.now();
  const unsentMeta = validChapterMeta.filter((_, i) => !isBlockingClaim(existingFlags[i], pendingStaleMs, nowMs));
  const limit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : Infinity;
  const queuedMeta = unsentMeta.slice(0, limit);

  return {
    chapterMeta,
    validChapterMeta,
    unsentMeta,
    queuedMeta,
    invalidCount: chapterMeta.length - validChapterMeta.length,
    alreadySentCount: validChapterMeta.length - unsentMeta.length,
    overLimitCount: Math.max(0, unsentMeta.length - queuedMeta.length),
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

  const queueState = await prepareDispatchQueue(
    redis,
    matched,
    maxItems,
    pendingClaimTtl * 1000,
  );
  skipped += queueState.invalidCount;
  skipped += queueState.alreadySentCount;
  skipped += queueState.overLimitCount;
  const limit = pLimit(Math.max(1, chapterConcurrency));
  const itemResults = await Promise.all(
    queueState.queuedMeta.map((entry, index) =>
      limit(async () => {
        const { item, key } = entry;
        const claimPayload = {
          status: CLAIM_STATUS_PENDING,
          claimedAt: nowIso,
        };
        const claimed = await redis.set(key, claimPayload, {
          ex: pendingClaimTtl,
          nx: true,
        });

        if (!claimed) {
          log(`Skip (TTL): ${item.title} ${item.chapter}`);
          return {
            sent: 0,
            skipped: 1,
            failed: 0,
            sentItem: null,
            writeTasks: [],
          };
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
          await redis.del(key);
          warn(`All guilds failed "${item.title}" - released`);
          return {
            sent: 0,
            skipped: 0,
            failed: sendResult.failed,
            sentItem: null,
            writeTasks: [],
          };
        }

        log(`Sent chapter "${item.title}" to ${sendResult.success} channels`);
        const queuedWriteTasks = [
          redis.set(key, {
            status: CLAIM_STATUS_SENT,
            claimedAt: nowIso,
            sentAt: nowIso,
          }, {
            ex: chapterTtl,
          }),
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

        if (typeof onDispatchSuccess === "function") {
          const extra = onDispatchSuccess(item);
          if (Array.isArray(extra)) {
            for (const task of extra) {
              if (task && typeof task.then === "function") queuedWriteTasks.push(task);
            }
          } else if (extra && typeof extra.then === "function") {
            queuedWriteTasks.push(extra);
          }
        }

        return {
          sent: 1,
          skipped: 0,
          failed: sendResult.failed,
          sentItem: item,
          writeTasks: queuedWriteTasks,
        };
      }),
    ),
  );

  const writeTasks = itemResults.flatMap((result) => result.writeTasks);
  for (const result of itemResults) {
    sent += result.sent;
    skipped += result.skipped;
    failed += result.failed;
    if (result.sentItem) sentItems.push(result.sentItem);
  }

  for (let i = 0; i < writeTasks.length; i += writeTaskBatch) {
    await Promise.all(writeTasks.slice(i, i + writeTaskBatch));
  }

  const summaryLog = typeof buildSummaryLog === "function"
    ? buildSummaryLog(sentItems, failed)
    : buildCronLogSummary(sentItems, failed);
  if (summaryLog) {
    await redis.lpush("cron:logs", summaryLog);
  }

  await Promise.all([
    redis.ltrim("recent:chapters", 0, 99),
    redis.expire("recent:chapters", RECENT_LIST_TTL_SEC),
    redis.ltrim("cron:logs", 0, 499),
    redis.expire("cron:logs", CRON_LOG_LIST_TTL_SEC),
  ]);

  if (sentItems.length > 0 || summaryLog) {
    if (sentItems.length > 0) {
      await refreshSourceCompareStateFromRecent(redis).catch(() => {});
    }
    await invalidateDashboardCaches(redis, [
      RECENT_API_CACHE_KEY,
      LOGS_API_CACHE_KEY,
      SOURCE_COMPARE_CACHE_KEY,
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
