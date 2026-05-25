/**
 * Safe dispatch history lookup utilities
 * Prevents memory bombs by using targeted queries instead of hgetall
 */

import { RedisClient } from "../types.js";

export const DISPATCH_HISTORY_KEY = "dispatch:history";
export const MAX_HISTORY_BATCH_SIZE = 100;

/**
 * Lookup dispatch status for specific titles (safe alternative to hgetall)
 */
export async function getDispatchStatusForTitles(
  redis: RedisClient,
  titleKeys: string[],
): Promise<Map<string, { sent: boolean; timestamp?: string }>> {
  const result = new Map<string, { sent: boolean; timestamp?: string }>();

  if (!titleKeys.length) return result;

  // Batch in chunks to avoid overwhelming Redis
  for (let i = 0; i < titleKeys.length; i += MAX_HISTORY_BATCH_SIZE) {
    const batch = titleKeys.slice(i, i + MAX_HISTORY_BATCH_SIZE);
    const values = await redis.hmget(DISPATCH_HISTORY_KEY, ...batch);

    if (Array.isArray(values)) {
      batch.forEach((key, idx) => {
        const val = values[idx];
        if (val) {
          try {
            const parsed = JSON.parse(val as string);
            result.set(key, { sent: parsed.sent === true, timestamp: parsed.timestamp });
          } catch {
            result.set(key, { sent: true });
          }
        }
      });
    }
  }

  return result;
}

/**
 * Check if a single title was dispatched (most efficient)
 */
export async function isTitleDispatched(
  redis: RedisClient,
  titleKey: string,
): Promise<boolean> {
  const value = await redis.hget(DISPATCH_HISTORY_KEY, titleKey);
  if (!value) return false;

  try {
    const parsed = JSON.parse(value as string);
    return parsed.sent === true;
  } catch {
    return true; // Assume sent if can't parse
  }
}

/**
 * Get dispatch count without loading all data
 */
export async function getDispatchCount(redis: RedisClient): Promise<number> {
  return redis.hlen(DISPATCH_HISTORY_KEY);
}

/**
 * Get recent dispatch entries with pagination (safe alternative to hgetall)
 */
export async function getRecentDispatchHistory(
  redis: RedisClient,
  options: {
    cursor?: string;
    count?: number;
    pattern?: string;
  } = {},
): Promise<{
  entries: Map<string, any>;
  cursor: string | null;
  hasMore: boolean;
}> {
  const { cursor = "0", count = 50, pattern } = options;

  if (pattern) {
    // Use HSCAN for pattern matching
    const [nextCursor, results] = await redis.hscan(
      DISPATCH_HISTORY_KEY,
      cursor,
      { match: pattern, count },
    );

    const entries = new Map<string, any>();
    if (Array.isArray(results)) {
      for (let i = 0; i < results.length; i += 2) {
        const key = results[i];
        const val = results[i + 1];
        try {
          entries.set(key, JSON.parse(val as string));
        } catch {
          entries.set(key, val);
        }
      }
    }

    return {
      entries,
      cursor: nextCursor === "0" ? null : nextCursor,
      hasMore: nextCursor !== "0",
    };
  }

  // For non-pattern queries, just get specific fields or return empty
  return {
    entries: new Map(),
    cursor: null,
    hasMore: false,
  };
}
