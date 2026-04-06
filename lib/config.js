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

// Build-time constant for Vercel bundler compatibility
// To change: update the value and redeploy
// Default: 300 seconds (5 minutes)
export const HEALTH_CHECK_MAX_DURATION_SEC = 300;

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

// ============================================================================
// Common Time Constants (prevent magic numbers)
// ============================================================================

/** One second in milliseconds */
export const ONE_SECOND_MS = 1000;
/** One minute in milliseconds */
export const ONE_MINUTE_MS = 60 * 1000;
/** One hour in milliseconds */
export const ONE_HOUR_MS = 60 * 60 * 1000;
/** One day in milliseconds */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** One minute in seconds */
export const ONE_MINUTE_SEC = 60;
/** One hour in seconds */
export const ONE_HOUR_SEC = 60 * 60;
/** One day in seconds */
export const ONE_DAY_SEC = 24 * 60 * 60;

// ============================================================================
// Common Size Limits
// ============================================================================

/** Default Discord message length limit */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** Discord embed title limit */
export const DISCORD_EMBED_TITLE_LIMIT = 256;
/** Discord embed description limit */
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
/** Autocomplete choice label limit */
export const AUTOCOMPLETE_LABEL_LIMIT = 100;
/** Redis scan batch size */
export const REDIS_SCAN_BATCH_SIZE = 100;
/** Default pagination page size */
export const DEFAULT_PAGE_SIZE = 40;

// ============================================================================
// HTTP & API Constants
// ============================================================================

/** 30 seconds timeout for API calls */
export const API_TIMEOUT_30S_MS = 30000;
/** 5 seconds timeout for fast operations */
export const API_TIMEOUT_5S_MS = 5000;
/** 3 seconds timeout for quick checks */
export const API_TIMEOUT_3S_MS = 3000;
/** 1 second timeout for health checks */
export const API_TIMEOUT_1S_MS = 1000;

// ============================================================================
// Scraper Constants
// ============================================================================

/** Maximum stale age for manga data (~8 months) */
export const MAX_STALE_MS = ONE_DAY_MS * 30 * 8;
/** Detail throttle delay in ms */
export const DETAIL_THROTTLE_MS = 200;
/** Max chapters to fetch per run */
export const MAX_CHAPTERS_PER_RUN_LIMIT = 15;
/** Default retry delay in ms */
export const DEFAULT_RETRY_DELAY_MS = 1000;
/** Default request timeout for scrapers */
export const SCRAPER_REQUEST_TIMEOUT_MS = 8000;

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
