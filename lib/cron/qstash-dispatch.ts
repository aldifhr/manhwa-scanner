import { normalizeTitleKey } from "../domain.js";
import { batchClaimPendingChapters } from "../services/storage.js";
import { prepareDispatchQueue } from "../services/dispatch/deduplication.js";
import { dispatchChapters } from "../services/dispatch.js";
import { isQStashEnabled, publishBatchToQStash, QStashNotificationTask } from "../services/qstash.js";
import { resolvePositiveInt } from "../config.js";
import { env } from "../config/env.js";
import { batchPreHydrateMetadata, hydrateIkiruMetadataIfMissing, IkiruMetaCacheEntry } from "../services/dispatch/hydration.js";
import type { ChapterItem, RedisClient, SendEmbedFn } from "../types.js";
import type { Logger } from "pino";

export interface QStashDispatchOptions {
  redisClient: RedisClient;
  matched: ChapterItem[];
  activeChannelIds: string[];
  channelToGuild: Map<string, string>;
  nowIso: string;
  start: number;
  deadlineMs: number;
  sendEmbedFn: (...args: any[]) => any;
  deleteGuildChannelFn: (guildId: string) => Promise<unknown>;
  appendLiveEvent: (r: RedisClient, e: { message: string; type: string }) => Promise<unknown>;
  log: (msg: string, obj?: Record<string, unknown>) => void;
  warn: (msg: string, obj?: Record<string, unknown>) => void;
  cronLogger: Logger;
}

export interface DispatchResult {
  sent: number;
  skipped: number;
  failed: number;
  enqueued: number;
  skipBreakdown: any | null;
}

export async function runDispatch(opts: QStashDispatchOptions): Promise<DispatchResult> {
  const {
    redisClient, matched, activeChannelIds, channelToGuild,
    nowIso, start, deadlineMs, sendEmbedFn, deleteGuildChannelFn,
    appendLiveEvent, log, warn, cronLogger,
  } = opts;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let enqueued = 0;
  let skipBreakdown: any | null = null;

  const qstashEnabled = isQStashEnabled();
  cronLogger.info({ qstashEnabled }, "QStash status check");

  if (qstashEnabled) {
    const pendingClaimTtl = resolvePositiveInt(env.CHAPTER_PENDING_TTL_SEC, 600);
    const queueState = await prepareDispatchQueue(
      redisClient,
      matched,
      Infinity,
      pendingClaimTtl * 1000,
    );

    const claimItems = queueState.queuedMeta.map((entry) => ({
      key: entry.key as string,
      duplicateKey: entry.duplicateKey,
      nowIso,
    }));

    const claimResults = await batchClaimPendingChapters(redisClient, claimItems, pendingClaimTtl);
    const claimedMeta = queueState.queuedMeta.filter((_, i) => claimResults[i]);
    const claimedItems = claimedMeta.map(m => m.item);

    // --- NEW: Hydrate Metadata before QStash ---
    const ikiruMetaCache = new Map<string, IkiruMetaCacheEntry>();
    await batchPreHydrateMetadata(claimedItems, redisClient, ikiruMetaCache);
    // -------------------------------------------

    const tasks: QStashNotificationTask[] = await Promise.all(
      claimedMeta.map(async (entry) => {
        // Hydrate each item using the pre-populated cache
        const chapter = await hydrateIkiruMetadataIfMissing(
          entry.item,
          redisClient,
          ikiruMetaCache,
          deadlineMs > 0 ? start + deadlineMs : 0
        );

        return {
          chapter: {
            title: chapter.title,
            chapter: chapter.chapter ?? "",
            source: chapter.source,
            url: chapter.url ?? "",
            cover: chapter.cover ?? (chapter as any).image ?? undefined,
            updatedTime: chapter.updatedTime ?? undefined,
            mangaUrl: chapter.mangaUrl ?? undefined,
            status: chapter.status ?? undefined,
            rating: chapter.rating ?? undefined,
            genres: chapter.genres,
            description: chapter.description ?? undefined,
            key: entry.key ?? undefined,
            duplicateKey: entry.duplicateKey ?? undefined,
            titleKey: normalizeTitleKey(chapter.title),
          },
          channelIds: activeChannelIds,
        };
      })
    );

    let queuedCount = 0;
    if (tasks.length > 0) {
      queuedCount = await publishBatchToQStash(tasks);
      if (queuedCount === 0) {
        cronLogger.warn({ count: tasks.length }, "QStash publish failed, falling back to direct dispatch");
      }
    }

    if (tasks.length > 0 && queuedCount === 0) {
      const dispatchResult = await dispatchChapters({
        redis: redisClient,
        matched: claimedMeta.map((m) => m.item),
        channelIds: activeChannelIds,
        sendEmbed: sendEmbedFn as SendEmbedFn,
        nowIso,
        log,
        warn,
        appendLiveEvent,
        startTime: start,
        deadlineMs,
      });
      sent = dispatchResult.sent;
      enqueued = 0;
    } else {
      enqueued = queuedCount;
      sent = queuedCount;
    }

    skipped = matched.length - sent;
    skipBreakdown = {
      invalid: queueState.invalidCount,
      alreadySentOrPending: queueState.alreadySentCount,
      stale: queueState.staleCount,
      duplicate: queueState.duplicateCount,
      overLimit: queueState.overLimitCount,
      runtimeClaimOrSend: matched.length - sent - (queueState.invalidCount + queueState.alreadySentCount + queueState.staleCount + queueState.duplicateCount + queueState.overLimitCount),
      total: matched.length - sent,
      alreadyStateBreakdown: queueState.alreadyStateBreakdown,
      alreadyStateBySource: queueState.alreadyStateBySource,
      blockedSample: queueState.blockedSample,
    };

    cronLogger.info({ queuedCount, totalMatched: matched.length, skipped }, "Pushed to QStash queue with deduplication");
  } else {
    const dispatchResult = await dispatchChapters({
      redis: redisClient,
      matched,
      channelIds: activeChannelIds,
      sendEmbed: sendEmbedFn as SendEmbedFn,
      nowIso,
      log,
      warn,
      appendLiveEvent,
      onChannelError: async (result: unknown, channelId: string) => {
        const errResult = result as { error?: { issues?: { message: string }[]; message?: string }; message?: string; status?: number };
        const message =
          errResult.error?.issues?.map((i) => i.message).join(", ") ||
          errResult.error?.message ||
          errResult.message ||
          "Unknown discord error";
        const status = errResult?.status;
        if (status !== 403 && status !== 404) return;
        const guildId = channelToGuild.get(channelId);
        if (!guildId) return;
        warn(`DISCONNECTED (Dispatch): guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status}) - DELETING.`);
        await (deleteGuildChannelFn(guildId) as Promise<void>).catch((err) => {
          warn(`Failed to delete stale channel ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      startTime: start,
      deadlineMs,
    });

    sent = dispatchResult.sent;
    skipped = dispatchResult.skipped;
    failed = dispatchResult.failed;
    skipBreakdown = dispatchResult.skipBreakdown || null;
  }

  return { sent, skipped, failed, enqueued, skipBreakdown };
}
