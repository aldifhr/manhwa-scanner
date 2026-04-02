/**
 * Unified Configuration Service
 * Static constants and environment-based configuration.
 */

export const CHAPTER_TTL_SEC = 60 * 60 * 24 * 3;
export const CHAPTER_PENDING_TTL_SEC = 60 * 10;
export const RECENT_LIST_TTL_SEC = 60 * 60 * 24 * 7;
export const CRON_LOG_LIST_TTL_SEC = 60 * 60 * 24 * 30;
export const DEFAULT_DISPATCH_WRITE_TASK_BATCH = 24;
export const DEFAULT_CHAPTER_DISPATCH_CONCURRENCY = 3;
export const RESYNC_LOCK_TTL_SEC = 60 * 10;
export const RESYNC_DEFAULT_MAX_SEND = 30;

export const MAX_CHAPTERS_PER_RUN = 5;
export const CRON_INTERVAL_LABEL = "Every 5 minutes";
export const CACHE_TTL_LABEL = "3 hari";

// Alises for backward compatibility
export const CHAPTER_TTL = CHAPTER_TTL_SEC;

/**
 * Resolves a value to a positive integer, falling back to a default value if invalid.
 */
export function resolvePositiveInt(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.floor(fallback);
  }
  return Math.floor(parsed);
}
