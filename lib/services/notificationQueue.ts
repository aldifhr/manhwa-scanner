import { redis } from "../redis.js";
import { NOTIFICATION_QUEUE_KEY, NOTIFICATION_PROCESSING_QUEUE_KEY } from "../constants/redis.js";
import { RedisClient, NotificationTask } from "../types.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "notification-queue" });

/**
 * Enqueue a batch of notification tasks
 * @param tasks - Array of task objects { chapter, channelIds, mentions }
 * @param redisClient - Optional redis client
 */
export async function enqueueNotifications(
  tasks: Partial<NotificationTask>[],
  redisClient: RedisClient = redis,
): Promise<number> {
  if (!tasks || tasks.length === 0) return 0;

  try {
    const payloads = tasks.map((task) =>
      JSON.stringify({
        ...task,
        enqueuedAt: new Date().toISOString(),
      }),
    );

    // rpush can take multiple values in Upstash/ioredis
    const result = await redisClient.rpush(NOTIFICATION_QUEUE_KEY, ...payloads);
    logger.info(
      { count: tasks.length, queueLength: result },
      "Enqueued notification tasks",
    );
    return result;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to enqueue notifications");
    throw err;
  }
}

/**
 * Pop a batch of notification tasks from the queue reliably.
 * Uses LMOVE to transfer items to a processing queue.
 * @param batchSize - Number of items to pop
 * @param redisClient - Optional redis client
 * @returns Array of parsed task objects
 */
export async function dequeueNotificationsReliable(
  batchSize = 5,
  redisClient: RedisClient = redis,
): Promise<{ task: NotificationTask; raw: string }[]> {
  try {
    const pipeline = redisClient.pipeline();
    for (let i = 0; i < batchSize; i++) {
      pipeline.lmove(NOTIFICATION_QUEUE_KEY, NOTIFICATION_PROCESSING_QUEUE_KEY, "LEFT", "RIGHT");
    }
    const rawResults = ((await pipeline.exec()) || []) as (string | null)[];

    const tasks: { task: NotificationTask; raw: string }[] = [];
    for (const raw of rawResults) {
      if (!raw) continue;
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") {
          tasks.push({ task: parsed as NotificationTask, raw: typeof raw === "string" ? raw : JSON.stringify(raw) });
        }
      } catch (parseErr: unknown) {
        logger.error({ raw, err: parseErr instanceof Error ? parseErr.message : String(parseErr) }, "Failed to parse queue item");
      }
    }

    if (tasks.length > 0) {
      logger.info({ count: tasks.length }, "Dequeued notification tasks (reliable)");
    }

    return tasks;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to dequeue notifications reliably");
    return [];
  }
}

/**
 * Acknowledge a notification task by removing it from the processing queue.
 */
export async function acknowledgeNotification(
  rawTask: string,
  redisClient: RedisClient = redis,
): Promise<boolean> {
  try {
    const removed = await redisClient.lrem(NOTIFICATION_PROCESSING_QUEUE_KEY, 1, rawTask);
    return removed > 0;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to acknowledge notification");
    return false;
  }
}

/**
 * Move stale items from the processing queue back to the main queue.
 */
export async function requeueStaleNotifications(
  maxAgeMs = 10 * 60 * 1000, // 10 minutes
  redisClient: RedisClient = redis,
): Promise<number> {
  try {
    const items = await redisClient.lrange(NOTIFICATION_PROCESSING_QUEUE_KEY, 0, -1);
    if (!items || items.length === 0) return 0;

    let movedCount = 0;
    const now = Date.now();

    for (const item of items) {
      try {
        const parsed = JSON.parse(item);
        const enqueuedAt = parsed.enqueuedAt ? new Date(parsed.enqueuedAt).getTime() : 0;

        if (!enqueuedAt || now - enqueuedAt > maxAgeMs) {
          // Remove from processing and push back to main
          const removed = await redisClient.lrem(NOTIFICATION_PROCESSING_QUEUE_KEY, 1, item);
          if (removed > 0) {
            await redisClient.lpush(NOTIFICATION_QUEUE_KEY, item);
            movedCount++;
          }
        }
      } catch (err) {
        // Corrupted item, maybe delete it? For now just skip
      }
    }

    if (movedCount > 0) {
      logger.warn({ movedCount }, "Requeued stale notifications from processing queue");
    }

    return movedCount;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to requeue stale notifications");
    return 0;
  }
}

/**
 * Get current queue length
 */
export async function getQueueLength(
  redisClient: RedisClient = redis,
): Promise<number> {
  try {
    return await redisClient.llen(NOTIFICATION_QUEUE_KEY);
  } catch (err) {
    return 0;
  }
}

