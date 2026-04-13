import { redis, NOTIFICATION_QUEUE_KEY } from "../redis.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "notification-queue" });

/**
 * Enqueue a batch of notification tasks
 * @param {Array<Object>} tasks - Array of task objects { chapter, channelIds, mentions }
 * @param {Object} redisClient - Optional redis client
 */
export async function enqueueNotifications(tasks, redisClient = redis) {
  if (!tasks || tasks.length === 0) return 0;

  try {
    const payloads = tasks.map(task => JSON.stringify({
      ...task,
      enqueuedAt: new Date().toISOString(),
    }));

    // rpush can take multiple values in Upstash/ioredis
    const result = await redisClient.rpush(NOTIFICATION_QUEUE_KEY, ...payloads);
    logger.info({ count: tasks.length, queueLength: result }, "Enqueued notification tasks");
    return result;
  } catch (err) {
    logger.error({ err: err.message }, "Failed to enqueue notifications");
    throw err;
  }
}

/**
 * Pop a batch of notification tasks from the queue
 * @param {number} batchSize - Number of items to pop
 * @param {Object} redisClient - Optional redis client
 * @returns {Promise<Array<Object>>} - Array of parsed task objects
 */
export async function dequeueNotifications(batchSize = 10, redisClient = redis) {
  try {
    const tasks = [];

    // Upstash Redis lpop can take a count argument in recent versions,
    // but for compatibility we can use a loop or lrange+ltrim if needed.
    // However, Upstash supports lpop(key, count)
    const rawItems = await redisClient.lpop(NOTIFICATION_QUEUE_KEY, batchSize);

    if (!rawItems) return [];

    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    for (const item of items) {
      try {
        // Upstash may return already-parsed objects or raw JSON strings
        const parsed = typeof item === "string" ? JSON.parse(item) : item;
        if (parsed && typeof parsed === "object") tasks.push(parsed);
      } catch (parseErr) {
        logger.error({ item, err: parseErr.message }, "Failed to parse queue item");
      }
    }

    if (tasks.length > 0) {
      logger.info({ count: tasks.length }, "Dequeued notification tasks");
    }

    return tasks;
  } catch (err) {
    logger.error({ err: err.message }, "Failed to dequeue notifications");
    return [];
  }
}

/**
 * Get current queue length
 */
export async function getQueueLength(redisClient = redis) {
  try {
    return await redisClient.llen(NOTIFICATION_QUEUE_KEY);
  } catch (err) {
    return 0;
  }
}
