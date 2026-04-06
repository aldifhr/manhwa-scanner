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

// Cache TTL values ( centralized from hardcoded values in api files )
export const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60);
export const RECENT_CACHE_SEC = Number(process.env.RECENT_CACHE_SEC || 180);
export const LOGS_CACHE_SEC = Number(process.env.LOGS_CACHE_SEC || 300);
export const STATUS_CACHE_SEC = Number(process.env.STATUS_CACHE_SEC || 60);
export const WHITELIST_CACHE_SEC = Number(
  process.env.WHITELIST_CACHE_SEC || 300,
);
export const INCIDENT_CACHE_TTL = Number(process.env.INCIDENT_CACHE_TTL || 300);
export const SESSION_TTL_SECONDS = Number(
  process.env.SESSION_TTL_SECONDS || 60 * 60 * 12,
);

export const MAX_CHAPTERS_PER_RUN = 5;
export const CRON_INTERVAL_LABEL = "Every 5 minutes";
export const CACHE_TTL_LABEL = "3 hari";

// API and timeout configurations
export const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000); // 30 seconds
export const CRON_MAX_DURATION_SEC = Number(
  process.env.CRON_MAX_DURATION_SEC || 300,
); // 5 minutes
export const HEALTH_CHECK_MAX_DURATION_SEC = Number(
  process.env.HEALTH_CHECK_MAX_DURATION_SEC || 300,
); // 5 minutes

// Health status page configurations
export const HEALTH_CACHE_TTL_MS = Number(
  process.env.HEALTH_CACHE_TTL_MS || 60000,
); // 1 minute
export const UPTIME_CALCULATION_TIERS = {
  PERFECT: { threshold: 0, value: "100.0%" },
  EXCELLENT: { threshold: 1, value: "99.9%" },
  GOOD: { threshold: 2, value: "99.5%" },
  DEGRADED: { threshold: 3, value: "98.0%" },
};

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
