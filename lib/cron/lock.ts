/**
 * Cron job locking mechanism to prevent concurrent executions
 */

import { getLogger } from "../logger.js";
import type { RedisClient } from "../types.js";

const logger = getLogger({ scope: "cron:lock" });

const CRON_LOCK_KEY = "cron:lock";
const LOCK_TTL_SECONDS = 35; // Slightly above the 26s timeout — prevents stuck lock on crash

export interface LockResult {
  acquired: boolean;
  release: () => Promise<void>;
}

/**
 * Attempt to acquire cron lock
 * Returns release function if acquired, or failed status
 */
export async function acquireCronLock(
  redis: RedisClient,
  options: { skipIfLocked?: boolean } = {},
): Promise<LockResult> {
  const lockValue = await redis.set(CRON_LOCK_KEY, "1", {
    nx: true,
    ex: LOCK_TTL_SECONDS,
  });

  const acquired = lockValue === "OK";

  if (!acquired && options.skipIfLocked) {
    logger.warn("Cron is already running in another instance, skipping");
  }

  const release = async (): Promise<void> => {
    try {
      await redis.del(CRON_LOCK_KEY);
      logger.debug("Cron lock released");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Failed to release cron lock");
    }
  };

  return { acquired, release };
}

/**
 * Force release cron lock (for emergency cleanup)
 */
export async function forceReleaseCronLock(redis: RedisClient): Promise<void> {
  try {
    await redis.del(CRON_LOCK_KEY);
    logger.info("Cron lock force-released");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to force-release cron lock");
  }
}

/**
 * Check if cron lock is held
 */
export async function isCronLocked(redis: RedisClient): Promise<boolean> {
  const lockValue = await redis.get(CRON_LOCK_KEY);
  return lockValue !== null;
}
