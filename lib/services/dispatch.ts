import { normalizeSourceUrl, normalizeTitleKey } from "../domain.js";
import { redis, flushWriteTasks, withDistributedLock } from "../redis.js";
import {
  RECENT_API_CACHE_KEY,
  LOGS_API_CACHE_KEY,
  NOTIFICATION_QUEUE_KEY,
  NOTIFICATION_PROCESSING_QUEUE_KEY,
} from "../constants/redis.js";
import { batchClaimPendingChapters, invalidateDashboardCaches, recordDispatchToSupabase } from "./storage.js";
import { ATOMIC_BATCH_QUEUE_MOVE_SCRIPT } from "../redisScripts.js";
import { requeueStaleNotifications } from "./notificationQueue.js";
import { RedisClient, CronLogEntry, ChapterItem, SendToChannelsOptions, DispatchChaptersOptions } from "../types.js";
import { buildDispatchChapterMeta, DispatchChapterMeta } from "./dispatch/meta.js";
import { prepareDispatchQueue, DispatchQueueState } from "./dispatch/deduplication.js";
import { buildCronLogSummary, LOG_SUMMARY_SAMPLE_LIMIT } from "./dispatch/history.js";
import { getMangaSubscribers } from "./notifications.js";
import { getSubscribersBatchWithCache } from "./notifications-batch.js";
import { appendCronLog } from "../cronLogs.js";
import { sendDiscordEmbedsChannelBatch } from "../discord.js";
import {
  CHAPTER_TTL_SEC,
  CHAPTER_PENDING_TTL_SEC,
  CROSS_SOURCE_DEDUPE_TTL_SEC,
  DEFAULT_CHAPTER_DISPATCH_CONCURRENCY,
  DEFAULT_DISPATCH_WRITE_TASK_BATCH,
} from "../config.js";
import { getLogger } from "../logger.js";
import { env } from "../config/env.js";
import { chunkArray } from "../utils.js";
import pLimit from "p-limit";
import { scheduleDiscordSend, buildMentionChunks } from "./dispatch/sender.js";
import {
  IkiruMetaCacheEntry,
  hydrateIkiruMetadataIfMissing,
  batchPreHydrateMetadata,
} from "./dispatch/hydration.js";
import {
  addSuccessWriteCommandsToPipeline,
  cleanupRecentChapters,
  fireAndForgetCleanup,
} from "./dispatch/pipeline.js";

const logger = getLogger({ scope: "dispatch" });


export type { SendToChannelsOptions, DispatchChaptersOptions } from "../types.js";
export { hydrateIkiruMetadataIfMissing, batchPreHydrateMetadata } from "./dispatch/hydration.js";

// Distributed lock constants
const BATCH_LOCK_KEY = "dispatch:batch:lock";
const BATCH_LOCK_TTL = 30; // seconds

function calculateInitialSkips(queueState: DispatchQueueState): number {
  return (
    queueState.invalidCount +
    queueState.alreadySentCount +
    queueState.duplicateCount +
    queueState.overLimitCount
  );
}

function logConcurrencyWarning(concurrency: number, log: (m: string) => void): void {
  const effectiveConcurrency = Math.max(1, concurrency);
  if (effectiveConcurrency > 1) {
    log(
      `CHAPTER_DISPATCH_CONCURRENCY=${effectiveConcurrency} requested, but chapter sends stay sequential to preserve order`,
    );
  }
}

async function buildAndLogSummary(
  redisClient: RedisClient,
  sentItems: ChapterItem[],
  failed: number,
  skipped: number,
  nowIso: string,
  buildSummaryLog: ((sentItems: ChapterItem[], failed: number, nowIso: string) => CronLogEntry | null) | null,
) {
  const summaryLog =
    typeof buildSummaryLog === "function"
      ? buildSummaryLog(sentItems, failed, nowIso)
      : buildCronLogSummary(sentItems, failed, nowIso);

  if (summaryLog) {
    await appendCronLog(redisClient, { ...summaryLog, skipped });
  }

  return summaryLog;
}

async function invalidateCachesIfNeeded(
  redisClient: RedisClient,
  sentItems: ChapterItem[],
  summaryLog: CronLogEntry | null,
): Promise<void> {
  if (sentItems.length > 0 || summaryLog) {
    await invalidateDashboardCaches(redisClient, [
      RECENT_API_CACHE_KEY,
      ...(summaryLog ? [LOGS_API_CACHE_KEY] : []),
    ]);
  }
}

/**
 * Dispatch manga chapter notifications to Discord channels
 * 
 * This is the core notification dispatch function that:
 * 1. Deduplicates chapters (same chapter, cross-source duplicates)
 * 2. Claims chapters in Redis (PENDING state) to prevent race conditions
 * 3. Enriches metadata (covers, descriptions) from cache or scraping
 * 4. Sends Discord embeds with buttons (follow/unfollow)
 * 5. Marks chapters as SENT in Redis
 * 6. Handles user subscriptions and mentions
 * 
 * @param options - Dispatch configuration
 * @param options.redis - Redis client (required)
 * @param options.matched - Array of matched chapters to dispatch
 * @param options.channelIds - Discord channel IDs to send to
 * @param options.sendEmbed - Function to send single embed
 * @param options.sendEmbedsBatch - Function to send batch of embeds
 * @param options.nowIso - Current timestamp (ISO format)
 * @param options.chapterTtl - Chapter TTL in seconds (default: 86400)
 * @param options.pendingClaimTtl - Pending claim TTL in seconds (default: 600)
 * @param options.crossSourceDedupeTtl - Cross-source dedupe TTL in seconds (default: 86400)
 * @param options.chapterConcurrency - Concurrent dispatch limit (default: 8)
 * @param options.maxItems - Maximum items to dispatch (default: Infinity)
 * @param options.getSubscribersFn - Function to get manga subscribers
 * @param options.buildSummaryLog - Function to build summary log
 * @param options.log - Logging function
 * @param options.warn - Warning logging function
 * @param options.appendLiveEvent - Function to append live events
 * @param options.startTime - Start timestamp for timing metrics
 * @param options.deadlineMs - Deadline timestamp (0 = no deadline)
 * 
 * @returns Dispatch result with counters and skip breakdown
 * 
 * @example
 * ```typescript
 * const result = await dispatchChapters({
 *   redis: redisClient,
 *   matched: chapters,
 *   channelIds: ["123456789"],
 *   sendEmbed: sendDiscordEmbed,
 *   sendEmbedsBatch: sendDiscordEmbedsChannelBatch,
 * });
 * 
 * console.log(`Sent: ${result.sent}, Skipped: ${result.skipped}`);
 * ```
 */
export async function dispatchChapters({
  redis: redisClient,
  matched = [],
  channelIds = [],
  sendEmbed,
  sendEmbedsBatch,
  nowIso = new Date().toISOString(),
  chapterTtl = CHAPTER_TTL_SEC,
  pendingClaimTtl = CHAPTER_PENDING_TTL_SEC,
  crossSourceDedupeTtl = CROSS_SOURCE_DEDUPE_TTL_SEC,
  chapterConcurrency = env.CHAPTER_DISPATCH_CONCURRENCY ?? DEFAULT_CHAPTER_DISPATCH_CONCURRENCY,
  writeTaskBatch = DEFAULT_DISPATCH_WRITE_TASK_BATCH,
  maxItems = Infinity,
  onDispatchSuccess = null,
  onChannelError = null,
  getSubscribersFn = getMangaSubscribers,
  buildSummaryLog = buildCronLogSummary,
  log = () => {},
  warn = () => {},
  appendLiveEvent = null,
  startTime = Date.now(),
  deadlineMs = 0,
}: DispatchChaptersOptions) {
  if (!redisClient) throw new Error("dispatchChapters requires redis");
  if (typeof sendEmbed !== "function") {
    throw new Error("dispatchChapters requires sendEmbed function");
  }

  const counters = {
    sent: 0,
    skipped: 0,
    failed: 0,
    sentItems: [] as ChapterItem[],
  };
  const pendingStaleMs = pendingClaimTtl * 1000;
  const ikiruMetaCache = new Map<string, IkiruMetaCacheEntry>();
  const subscriberCache = new Map<string, string[]>();

  const queueState = await prepareDispatchQueue(
    redisClient,
    matched,
    maxItems,
    pendingStaleMs,
  );

  const initialSkips = calculateInitialSkips(queueState);
  counters.skipped += initialSkips;
  logConcurrencyWarning(chapterConcurrency, log);

  const deadline = deadlineMs > 0 ? startTime + deadlineMs : 0;
  const HEARTBEAT_MARGIN_MS = 6500;
  const FINAL_ABORT_MARGIN_MS = 1500;
  let abortedDueToDeadline = false;

  const claimItems = queueState.queuedMeta.map((entry) => ({
    key: entry.key as string,
    duplicateKey: entry.duplicateKey,
    nowIso,
  }));

  const claimResults = await batchClaimPendingChapters(
    redisClient,
    claimItems,
    pendingClaimTtl,
  );

  const claimedMeta = queueState.queuedMeta.filter((_, i) => claimResults[i]);
  const failedClaimsCount = queueState.queuedMeta.length - claimedMeta.length;
  counters.skipped += failedClaimsCount;

  if (claimedMeta.length > 0) {
    const notificationTasks: { 
      chapter: ChapterItem; 
      channelIds: string[]; 
      mentions: string[]; 
      primaryKey: string | null | undefined; 
      duplicateKey: string | null | undefined;
      writeMeta?: {
        index: number;
        titleKey: string;
        nowIso: string;
      }
    }[] = [];
    const allWriteTasks: (() => Promise<unknown>)[] = [];

    // Pre-fetch metadata caches for all claimed items in one round-trip
    await batchPreHydrateMetadata(
      claimedMeta.map(m => m.item),
      redisClient,
      ikiruMetaCache
    );

  // Pre-fetch all subscribers in batch to avoid N+1 query pattern
  const allTitles = claimedMeta.map((entry) => entry.item.title);
  const subscribersMap = await getSubscribersBatchWithCache(
    redisClient,
    allTitles,
    subscriberCache,
  );

  // Process chapters and build notification tasks (no Redis writes yet)
  const processLimit = pLimit(chapterConcurrency);
  await Promise.all(
    claimedMeta.map((entry, index) =>
      processLimit(async () => {
        if (deadline && Date.now() > deadline - HEARTBEAT_MARGIN_MS) {
          abortedDueToDeadline = true;
          return;
        }

        let item = entry.item;

        // Hydrate metadata in background; don't block dispatch if deadline is tight
        const hydrationPromise = hydrateIkiruMetadataIfMissing(item, redisClient, ikiruMetaCache, deadline)
          .then(updated => { item = updated; });

        // If we have time, wait for hydration; otherwise proceed with cached data
        if (!deadline || Date.now() < deadline - 3000) {
          await hydrationPromise;
        }

        const subscribers = subscribersMap.get(item.title) || [];
        const titleKey = normalizeTitleKey(item.title);
        const mentionChunks = buildMentionChunks(subscribers, 50);

        notificationTasks.push({
          chapter: item,
          channelIds,
          mentions: mentionChunks,
          primaryKey: entry.key ?? undefined,
          duplicateKey: entry.duplicateKey,
          writeMeta: {
            index,
            titleKey,
            nowIso,
          }
        });

        if (typeof onDispatchSuccess === "function") {
          const extra = onDispatchSuccess(item);
          if (extra) {
            const extraPromises = (Array.isArray(extra) ? extra : [extra])
              .filter((t) => t && typeof t.then === "function");
            await Promise.all(extraPromises);
          }
        }
      }),
    ),
  );

    // Sort tasks by original index to preserve intended order (e.g., ascending chapter numbers)
    // even though they were processed in parallel.
    notificationTasks.sort((a, b) => (a.writeMeta?.index ?? 0) - (b.writeMeta?.index ?? 0));

    // Send notifications in batches to Discord (10 embeds per message)
    if (notificationTasks.length > 0) {
      // Pre-group tasks by channel once (avoids O(n*m) filter inside nested loop)
      const tasksByChannel = new Map<string, typeof notificationTasks>();
      for (const task of notificationTasks) {
        for (const cid of task.channelIds) {
          if (!tasksByChannel.has(cid)) tasksByChannel.set(cid, []);
          tasksByChannel.get(cid)!.push(task);
        }
      }
      const allChannelIds = [...tasksByChannel.keys()];
      const CHANNEL_BATCH_SIZE = 10;

      for (let channelBatchIdx = 0; channelBatchIdx < allChannelIds.length; channelBatchIdx += CHANNEL_BATCH_SIZE) {
        const channelBatch = allChannelIds.slice(channelBatchIdx, channelBatchIdx + CHANNEL_BATCH_SIZE);
        const statusWritePipeline = redisClient.pipeline();

        for (const channelId of channelBatch) {
          const channelTasks = tasksByChannel.get(channelId) ?? [];
          
          // Chunk tasks for this channel into groups of 10 (Discord limit)
          const taskChunks = chunkArray(channelTasks, 10);
          
          for (const chunk of taskChunks) {
            const taskKeys = chunk.map(t => `${t.chapter.title}:${t.chapter.chapter}`);
            
            // 1. Atomically move from pending to processing using Lua script (prevents race conditions)
            try {
              await redisClient.eval(
                ATOMIC_BATCH_QUEUE_MOVE_SCRIPT,
                [NOTIFICATION_QUEUE_KEY, NOTIFICATION_PROCESSING_QUEUE_KEY],
                taskKeys
              );
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              logger.warn({ err: message, count: taskKeys.length }, "Failed to move tasks to processing queue");
            }

            // 2. Consolidate mentions for the whole chunk
            const combinedMentions = [...new Set(chunk.flatMap(t => t.mentions || []))].join(" ");
            const safeMentions = combinedMentions.length > 1000 ? combinedMentions.substring(0, 997) + "..." : combinedMentions;
            
            try {
              const results = typeof sendEmbedsBatch === "function" 
                ? await sendEmbedsBatch(chunk.map(t => t.chapter), channelId, redisClient, safeMentions)
                : (typeof sendEmbed === "function"
                  ? await (async () => {
                      let success = true;
                      for (const t of chunk) {
                        try {
                          const res = await sendEmbed(t.chapter, channelId, redisClient, safeMentions);
                          if (!res || res.success === false) success = false;
                        } catch (err) {
                          success = false;
                        }
                      }
                      return { success };
                    })()
                  : await sendDiscordEmbedsChannelBatch(
                    chunk.map(t => t.chapter),
                    channelId,
                    redisClient,
                    safeMentions
                  )
                );

              if (results.success) {
                // 3. EAGER COMMIT: Mark all as SENT in batch pipeline
                for (const task of chunk) {
                  if (task.primaryKey && task.writeMeta) {
                    addSuccessWriteCommandsToPipeline({
                      pipeline: statusWritePipeline,
                      item: task.chapter,
                      key: task.primaryKey,
                      duplicateKey: task.duplicateKey ?? null,
                      titleKey: task.writeMeta.titleKey,
                      index: task.writeMeta.index,
                      nowIso: task.writeMeta.nowIso,
                      chapterTtl,
                      crossSourceDedupeTtl,
                      redisClient,
                    });

                    // Record to Supabase permanently (only if metadata is available)
                    recordDispatchToSupabase(task.chapter, task.writeMeta.titleKey).catch(err => {
                      logger.warn({ err: err.message, url: task.chapter.url }, "Failed to record dispatch to Supabase");
                    });
                  }

                  // Count as sent only after successful Discord delivery
                  counters.sent += 1;
                  counters.sentItems.push(task.chapter);

                  if (appendLiveEvent) {
                    await appendLiveEvent(redisClient, {
                      message: `Sent: ${task.chapter.title} ${task.chapter.chapter}`,
                      type: "success",
                    });
                  }
                }
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              logger.error({ err: message, channelId, count: chunk.length }, "Failed to send batched Discord notification");
            }

            // 4. Remove from processing queue
            for (const taskKey of taskKeys) {
              statusWritePipeline.lrem(NOTIFICATION_PROCESSING_QUEUE_KEY, 0, taskKey);
            }
          }
        }

        // Execute pipeline for this channel batch
        const pipelineResults = await statusWritePipeline.exec();
        if (pipelineResults) {
          const errors = pipelineResults
            .filter((item: unknown) => Array.isArray(item) && item[0] !== null)
            .map((item: unknown) => (item as [Error, unknown])[0]);
          if (errors.length > 0) {
            const errorMessage = `Pipeline execution failed with ${errors.length} errors`;
            logger.error({ errors: errors.map(e => e instanceof Error ? e.message : String(e)) }, "Channel batch pipeline failed");
            throw new Error(errorMessage);
          }
        }
      }
    }
  }

  if (abortedDueToDeadline) {
    warn(
      `Dispatch aborted early (approaching 30s deadline). Sent=${counters.sent}, Skipped remaining.`,
    );
  }

  const summaryLog = await buildAndLogSummary(
    redisClient,
    counters.sentItems,
    counters.failed,
    counters.skipped,
    nowIso,
    buildSummaryLog,
  );

  await invalidateCachesIfNeeded(redisClient, counters.sentItems, summaryLog);

  const withinDeadline = !deadline || Date.now() < deadline - FINAL_ABORT_MARGIN_MS;
  if (withinDeadline) {
    await cleanupRecentChapters(redisClient);
    await requeueStaleNotifications(10 * 60 * 1000, redisClient);
    fireAndForgetCleanup(redisClient);
  } else {
    warn("Skipped non-essential cleanup tasks due to critical time limit (Final Abort Margin).");
  }

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
    enqueued: counters.sent,
    sentItems: counters.sentItems,
    skipBreakdown,
  };
}
