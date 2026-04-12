import { dequeueNotifications, getQueueLength } from "../lib/services/notificationQueue.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import { redis, hsetWithTTL, DISPATCH_HISTORY_KEY } from "../lib/redis.js";
import { getLogger } from "../lib/logger.js";
import { normalizeChapterIdentity } from "../lib/domain.js";
import { CHAPTER_TTL_SEC, CLAIM_STATUS } from "../lib/config.js";

const logger = getLogger({ scope: "worker" });
const WORKER_TIMEOUT_MS = 25000; // 25s limit for Vercel
const BATCH_SIZE = 5;

async function markAsSent(chapter, nowIso) {
  const key = normalizeChapterIdentity(chapter);
  const ttlMs = CHAPTER_TTL_SEC * 1000;

  await hsetWithTTL(
    redis,
    DISPATCH_HISTORY_KEY,
    key,
    JSON.stringify({
      status: CLAIM_STATUS.SENT,
      sentAt: nowIso,
      expiresAt: Date.now() + ttlMs,
    }),
    ttlMs,
  );

  // Also update recent:chapters with sentAt
  const chapterKeyPre = `${chapter.title}:${chapter.chapter}:`;
  // Since we don't know the exact enqueuedAt key, we might need a better way
  // to sync these, but for now we'll just ensure dispatch:history is the source of truth.
}

export default async function handler(req, res) {
  const start = Date.now();
  const workerToken = process.env.WORKER_TOKEN;
  const incomingToken = req.headers["authorization"] || req.query.token;

  if (workerToken && incomingToken !== workerToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  logger.info("Worker started processing queue");

  let processedCount = 0;
  let failedCount = 0;

  try {
    while (Date.now() - start < WORKER_TIMEOUT_MS) {
      const tasks = await dequeueNotifications(BATCH_SIZE);

      if (!tasks || tasks.length === 0) {
        logger.info("Queue empty, worker finishing");
        break;
      }

      for (const task of tasks) {
        const { chapter, channelIds, mentions = [] } = task;
        const firstMentions = Array.isArray(mentions) ? (mentions[0] || "") : (mentions || "");

        let success = false;
        for (const channelId of channelIds) {
          try {
            await sendDiscordEmbed(chapter, channelId, redis, firstMentions);
            success = true;
          } catch (err) {
            logger.error({ channelId, err: err.message }, "Worker failed to send to channel");
          }
        }

        if (success) {
          await markAsSent(chapter, new Date().toISOString());
          processedCount++;
        } else {
          failedCount++;
        }
      }
    }

    const duration = (Date.now() - start) / 1000;
    return res.status(200).json({
      ok: true,
      processed: processedCount,
      failed: failedCount,
      duration: `${duration.toFixed(1)}s`,
      remaining: await getQueueLength(),
    });

  } catch (err) {
    logger.error({ err: err.message }, "Worker fatal error");
    return res.status(500).json({ error: err.message });
  }
}
