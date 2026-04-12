import { dequeueNotifications, getQueueLength } from "../lib/services/notificationQueue.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import { redis, hsetWithTTL, DISPATCH_HISTORY_KEY } from "../lib/redis.js";
import { getLogger } from "../lib/logger.js";
import { normalizeChapterIdentity } from "../lib/domain.js";
import { CHAPTER_TTL_SEC, CLAIM_STATUS, CROSS_SOURCE_DEDUPE_TTL_SEC } from "../lib/config.js";

const logger = getLogger({ scope: "worker" });
const WORKER_TIMEOUT_MS = 25000; // 25s limit for Vercel
const BATCH_SIZE = 5;

async function markAsSent(task, nowIso) {
  const { chapter, primaryKey, duplicateKey } = task;
  const ttlMs = CHAPTER_TTL_SEC * 1000;
  const duplicateTtlMs = CROSS_SOURCE_DEDUPE_TTL_SEC * 1000;

  const statusJson = JSON.stringify({
    status: CLAIM_STATUS.SENT,
    sentAt: nowIso,
    expiresAt: Date.now() + ttlMs,
  });

  const tasks = [];

  if (primaryKey) {
    tasks.push(hsetWithTTL(redis, DISPATCH_HISTORY_KEY, primaryKey, statusJson, ttlMs));
  }

  if (duplicateKey) {
    tasks.push(
      hsetWithTTL(
        redis,
        DISPATCH_HISTORY_KEY,
        duplicateKey,
        JSON.stringify({
          status: CLAIM_STATUS.SENT,
          sentAt: nowIso,
          expiresAt: Date.now() + duplicateTtlMs,
        }),
        duplicateTtlMs,
      ),
    );
  }

  // Update recent:chapters with actual sentAt time for dashboard visibility
  const chapterKeyPre = `${chapter.title}:${chapter.chapter}:`;
  tasks.push(
    (async () => {
      try {
        const recent = await redis.hgetall("recent:chapters");
        const foundKey = Object.keys(recent || {}).find((k) => k.startsWith(chapterKeyPre));
        if (foundKey) {
          const data = JSON.parse(recent[foundKey]);
          data.sentAt = nowIso;
          data.status = CLAIM_STATUS.SENT;
          await redis.hset("recent:chapters", { [foundKey]: JSON.stringify(data) });
        }
      } catch (err) {
        logger.warn({ err: err.message }, "Failed to update recent:chapters in worker");
      }
    })(),
  );

  await Promise.all(tasks);
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
          await markAsSent(task, new Date().toISOString());
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
