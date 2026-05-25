/**
 * Dashboard login throttling to prevent brute force
 */

import { getLogger } from "../logger.js";
import { getClientAddress } from "./ip.js";
import {
  getDashboardLoginWindowSeconds,
  getDashboardLoginMaxAttempts,
} from "./config.js";
import type { RedisClient } from "../types.js";
import type { RequestLike } from "./http.js";

const logger = getLogger({ scope: "auth:throttle" });

export interface ThrottleSnapshot {
  count: number;
  limited: boolean;
  retryAfterSec: number;
}

/**
 * Build throttle snapshot from raw Redis values
 */
function buildThrottleSnapshot(
  count: number | null | undefined,
  retryAfterSec: number | null | undefined,
): ThrottleSnapshot {
  const safeCount = Number(count || 0);
  const safeRetryAfter = Number(retryAfterSec || 0);

  if (safeCount <= 0 || safeRetryAfter <= 0) {
    return {
      count: 0,
      limited: false,
      retryAfterSec: 0,
    };
  }

  return {
    count: safeCount,
    limited: safeCount >= getDashboardLoginMaxAttempts(),
    retryAfterSec: Math.max(1, Math.ceil(safeRetryAfter)),
  };
}

/**
 * Get Redis key for login throttle
 */
function getDashboardLoginThrottleKey(req: RequestLike): string {
  return `auth:dashboard:login:${getClientAddress(req) || "unknown"}:count`;
}

/**
 * Read current throttle status
 */
export async function readDashboardLoginThrottle(
  redis: RedisClient,
  req: RequestLike,
): Promise<ThrottleSnapshot> {
  if (!redis) return buildThrottleSnapshot(null, 0);
  const key = getDashboardLoginThrottleKey(req);

  const [countRaw, ttlRaw] = await Promise.all([
    redis.get(key),
    redis.ttl(key),
  ]);
  return buildThrottleSnapshot(Number(countRaw), Number(ttlRaw));
}

/**
 * Register a login failure (increment counter)
 */
export async function registerDashboardLoginFailure(
  redis: RedisClient,
  req: RequestLike,
): Promise<ThrottleSnapshot> {
  const windowSec = getDashboardLoginWindowSeconds();

  if (!redis) {
    return {
      count: 1,
      limited: false,
      retryAfterSec: windowSec,
    };
  }

  const key = getDashboardLoginThrottleKey(req);

  const count = Number(
    await redis.incr(key).catch((err: unknown) => {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, "Redis incr failed");
      return 0;
    }),
  );

  const ttl = await redis.ttl(key).catch((err: unknown) => {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMessage }, "Redis ttl failed");
    return -1;
  });

  if (ttl < 0) {
    await redis.expire(key, windowSec).catch((err: unknown) => {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, "Redis expire failed");
    });
  }

  return buildThrottleSnapshot(count, windowSec);
}

/**
 * Clear login throttle (after successful login)
 */
export async function clearDashboardLoginThrottle(
  redis: RedisClient,
  req: RequestLike,
): Promise<void> {
  if (!redis) return;
  await redis.del(getDashboardLoginThrottleKey(req)).catch((err: unknown) => {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMessage }, "Redis del failed");
  });
}
