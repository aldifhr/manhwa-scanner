import type { Request, Response } from "express";
import { Receiver } from "@upstash/qstash";
import { redis } from "../lib/redis.js";
import { sendDiscordEmbedsChannelBatch } from "../lib/discord.js";
import { getLogger } from "../lib/logger.js";
import { QStashNotificationTask, isQStashEnabled } from "../lib/services/qstash.js";
import { mangaProviderRegistry } from "../lib/providers/registry.js";
import { setMangaMetadata } from "../lib/services/storage.js";
import { isMetadataEmpty } from "../lib/services/metadata-enrichment.js";
import { normalizeSource } from "../lib/scrapers/shared.js";
import { MangaMetadata } from "../lib/types.js";
import {
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
  CLAIM_STATUS,
  CHAPTER_TTL_SEC,
  RECENT_LIST_TTL_SEC,
  RECENT_LIST_MAX_SIZE,
  CROSS_SOURCE_DEDUPE_TTL_SEC,
} from "../lib/config.js";
import {
  DISPATCH_HISTORY_KEY,
  MANGA_LAST_UPDATES_KEY,
  RECENT_CHAPTERS_KEY,
  MANGA_LAST_CHAPTERS_KEY,
} from "../lib/constants/redis.js";
import { ATOMIC_DISPATCH_SCRIPT } from "../lib/redisScripts.js";
import { getChapterNumber } from "../lib/domain.js";

const logger = getLogger({ scope: "qstash-worker" });

export const config = { api: { bodyParser: true } };

const receiver = new Receiver({
  currentSigningKey: QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: QSTASH_NEXT_SIGNING_KEY || "",
});

export default async function handler(req: Request, res: Response) {
  // Verify this is a QStash webhook using official Receiver
  const qstashSignature = req.headers["upstash-signature"] as string | undefined;
  
  if (!qstashSignature && process.env.NODE_ENV !== "development") {
    logger.warn("No QStash signature provided");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const isValid = await receiver.verify({
      signature: qstashSignature || "",
      body: JSON.stringify(req.body),
    });

    if (!isValid && process.env.NODE_ENV !== "development") {
      logger.warn("Invalid QStash signature");
      return res.status(401).json({ error: "Unauthorized" });
    }
  } catch (err) {
    logger.error({ err }, "Signature verification error");
    if (process.env.NODE_ENV !== "development") {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const task = req.body as QStashNotificationTask;

    if (!task || !task.chapter || !task.channelIds) {
      logger.warn({ task }, "Invalid task payload");
      return res.status(400).json({ error: "Invalid payload" });
    }

    // Deduplicate channel IDs for this task
    const uniqueChannelIds = [...new Set(task.channelIds)];
    if (uniqueChannelIds.length < task.channelIds.length) {
      logger.info({
        chapter: task.chapter.title,
        original: task.channelIds.length,
        unique: uniqueChannelIds.length
      }, "Deduplicated channel IDs in worker");
    }

    // Safety check: skip if already sent (handles QStash retries)
    const keysToCheck = [task.chapter.key, task.chapter.duplicateKey].filter(Boolean) as string[];
    if (keysToCheck.length > 0) {
      const values = await redis.hmget(DISPATCH_HISTORY_KEY, ...keysToCheck);
      const valArray = Array.isArray(values) ? values : keysToCheck.map((k) => (values as any)?.[k] ?? null);
      for (let i = 0; i < keysToCheck.length; i++) {
        const raw = valArray[i];
        if (!raw) continue;
        try {
          const parsed = typeof raw === "string" ? JSON.parse(raw) : (raw as any);
          if (parsed.s === CLAIM_STATUS.SENT || parsed.status === CLAIM_STATUS.SENT) {
            const reason = i === 0 ? "already_sent" : "cross_source_duplicate";
            logger.info({ chapter: task.chapter.title, reason }, "Skipping notification (safety check)");
            return res.status(200).json({ success: true, reason });
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    logger.info({ 
      chapter: task.chapter.title, 
      channels: task.channelIds.length 
    }, "Processing QStash notification");

    // 1. ASYNC METADATA ENRICHMENT (New)
    // If chapter is missing metadata, try to fetch it now before sending
    const currentDescription = (task.chapter as any).description;
    const isMissingDesc = !currentDescription || 
                         currentDescription.toLowerCase() === "unknown" || 
                         currentDescription.toLowerCase() === "n/a" ||
                         currentDescription.length < 10;
                         
    if (!task.chapter.cover || isMissingDesc) {
      const source = normalizeSource(task.chapter.source);
      const titleKey = task.chapter.titleKey;
      const mangaUrl = task.chapter.mangaUrl;

      if (source && titleKey && mangaUrl) {
        try {
          const provider = mangaProviderRegistry.getProvider(source);
          if (provider && provider.fetchMetadata) {
            logger.info({ titleKey, source }, "Worker: Fetching missing metadata");
            const meta = await provider.fetchMetadata(mangaUrl, redis);
            
            if (meta && !isMetadataEmpty(meta as any)) {
              // Update task object so the embed uses the new data
              task.chapter.cover = meta.cover || task.chapter.cover;
              (task.chapter as any).description = meta.description;
              (task.chapter as any).rating = meta.rating || (task.chapter as any).rating;
              (task.chapter as any).genres = meta.genres || (task.chapter as any).genres;
              (task.chapter as any).status = meta.status || (task.chapter as any).status;
              
              // Cache for future use
              await setMangaMetadata(redis, titleKey, meta as MangaMetadata);
              logger.info({ titleKey }, "Worker: Metadata enriched and cached");
            }
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message, titleKey }, "Worker: Metadata fetch failed, sending basic notification");
        }
      }
    }

    // Send to all channels
    let successCount = 0;
    let failCount = 0;

    for (const channelId of uniqueChannelIds) {
      try {
        await sendDiscordEmbedsChannelBatch(
          [task.chapter as any],
          channelId,
          redis,
          task.mentions?.join(" ")
        );
        successCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ channelId, err: message }, "Failed to send to channel");
        failCount++;
      }
    }

    // Mark as SENT in Redis history
    if (successCount > 0 && task.chapter.key) {
      try {
        const nowIso = new Date().toISOString();
        const chapterTtlMs = CHAPTER_TTL_SEC * 1000;
        const crossTtlMs = CROSS_SOURCE_DEDUPE_TTL_SEC * 1000;
        
        const historyPayload = JSON.stringify({
          s: CLAIM_STATUS.SENT,
          ca: nowIso,
          ea: nowIso,
          e: Date.now() + chapterTtlMs,
        });

        const recentPayload = JSON.stringify({
          t: task.chapter.title,
          c: task.chapter.chapter,
          u: task.chapter.url,
          cv: task.chapter.cover ?? null,
          s: task.chapter.source,
          ut: task.chapter.updatedTime ?? null,
          sa: nowIso,
          ea: nowIso,
          so: 0, 
          e: Date.now() + RECENT_LIST_TTL_SEC * 1000,
        });

        const dupPayload = task.chapter.duplicateKey ? JSON.stringify({
          s: CLAIM_STATUS.SENT,
          ca: nowIso,
          ea: nowIso,
          e: Date.now() + crossTtlMs,
        }) : "";

        await redis.eval(
          ATOMIC_DISPATCH_SCRIPT,
          [DISPATCH_HISTORY_KEY, MANGA_LAST_UPDATES_KEY, RECENT_CHAPTERS_KEY, MANGA_LAST_CHAPTERS_KEY],
          [
            task.chapter.key,
            task.chapter.titleKey || "",
            nowIso,
            historyPayload,
            recentPayload,
            String(chapterTtlMs),
            String(RECENT_LIST_MAX_SIZE),
            task.chapter.duplicateKey || "",
            dupPayload,
            String(getChapterNumber(task.chapter.chapter) || "")
          ]
        );
        logger.info({ chapter: task.chapter.title }, "Updated Redis history");
        
        // 5. RECORD TO SUPABASE (New: for Winner/Source stats)
        const titleKey = task.chapter.titleKey || "";
        if (titleKey) {
          import("../lib/services/storage.js").then(({ recordDispatchToSupabase }) => {
             recordDispatchToSupabase(task.chapter as any, titleKey).catch(() => {});
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message, chapter: task.chapter.title }, "Failed to update Redis history in worker");
      }
    }

    logger.info({ 
      chapter: task.chapter.title,
      success: successCount,
      failed: failCount 
    }, "Notification processed");

    return res.status(200).json({ 
      success: true, 
      sent: successCount,
      failed: failCount 
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Worker error");
    // Return 200 to prevent QStash retry on parsing errors
    return res.status(200).json({ error: "Processed with errors" });
  }
}

// Health check endpoint for the worker
export async function workerHealth(req: Request, res: Response) {
  return res.status(200).json({
    status: "healthy",
    qstashEnabled: isQStashEnabled(),
    timestamp: new Date().toISOString(),
  });
}