import {
  differenceInDays,
  differenceInHours,
  differenceInMilliseconds,
  endOfDay,
  format,
  getTime,
  isAfter,
  isBefore,
  isValid,
  parseISO,
  startOfDay,
  subDays,
  subHours,
  toDate,
} from "date-fns";

import { parseLooseRelativeTime } from "./scrapers/shared.js";
import { getLogger } from "./logger.js";
import { safeJsonParse } from "./utils.js";

const logger = getLogger({ scope: "dateUtils" });
export { safeJsonParse };

/**
 * Sort array of objects by date field (descending)
 */
export function sortByDateDesc(items, dateField = "timestamp") {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => compareDatesDesc(a[dateField], b[dateField]));
}

/**
 * Sort array of objects by date field (ascending)
 */
export function sortByDateAsc(items, dateField = "timestamp") {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => compareDatesAsc(a[dateField], b[dateField]));
}

/**
 * Standardized warning logger (alias for test compatibility)
 */
export function logWarnError(context, err, message) {
  return warnLog(context, err, message);
}

/**
 * Parse and validate a date string or object
 * Returns Date object or null if invalid
 */
export function safeParseDate(date) {
  if (!date) return null;
  if (date instanceof Date) return isValid(date) ? date : null;

  try {
    const parsed = typeof date === "string" ? parseISO(date) : toDate(date);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Get timestamp in milliseconds from a date string or object
 * Returns number or NaN if invalid
 */
export function getTimestampMs(date) {
  const parsed = safeParseDate(date);
  return parsed ? getTime(parsed) : NaN;
}

/**
 * Check if a date is valid
 */
export function isValidDate(date) {
  return safeParseDate(date) !== null;
}

/**
 * Format date to ISO string safely
 * Returns ISO string or null if invalid
 */
export function toISOSafe(date) {
  const parsed = safeParseDate(date);
  return parsed ? format(parsed, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") : null;
}

/**
 * Format date for display in Indonesian locale
 */
export function formatDisplayDate(date, options = {}) {
  const parsed = safeParseDate(date);
  if (!parsed) return "Invalid date";

  const { weekday = true, year = true, month = "long", day = true } = options;

  const formatStr = [
    weekday ? "EEEE" : "",
    day ? "d" : "",
    month === "long" ? "MMMM" : month === "short" ? "MMM" : "MM",
    year ? "yyyy" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return format(parsed, formatStr, { locale: undefined });
}

/**
 * Get start of day timestamp (midnight) for a date
 */
export function getStartOfDay(date) {
  const parsed = safeParseDate(date);
  return parsed ? getTime(startOfDay(parsed)) : NaN;
}

/**
 * Get end of day timestamp for a date
 */
export function getEndOfDay(date) {
  const parsed = safeParseDate(date);
  return parsed ? getTime(endOfDay(parsed)) : NaN;
}

/**
 * Calculate cutoff time for filtering
 * Returns timestamp in milliseconds
 */
export function getCutoffTime(daysBack = 30, hoursBack = 0) {
  let result = new Date();
  if (daysBack > 0) {
    result = subDays(result, daysBack);
  }
  if (hoursBack > 0) {
    result = subHours(result, hoursBack);
  }
  return getTime(result);
}

/**
 * Check if date is within last N days
 */
export function isWithinLastDays(date, days) {
  const parsed = safeParseDate(date);
  if (!parsed) return false;

  const cutoff = subDays(new Date(), days);
  return isAfter(parsed, cutoff);
}

/**
 * Check if date is within last N hours
 */
export function isWithinLastHours(date, hours) {
  const parsed = safeParseDate(date);
  if (!parsed) return false;

  const cutoff = subHours(new Date(), hours);
  return isAfter(parsed, cutoff);
}

/**
 * Compare two dates for sorting (descending - newest first)
 * Returns negative if b > a, positive if a > b, 0 if equal
 */
export function compareDatesDesc(a, b) {
  const ta = getTimestampMs(a);
  const tb = getTimestampMs(b);

  if (isNaN(ta) && isNaN(tb)) return 0;
  if (isNaN(ta)) return 1;
  if (isNaN(tb)) return -1;

  return tb - ta;
}

/**
 * Compare two dates for sorting (ascending - oldest first)
 */
export function compareDatesAsc(a, b) {
  const ta = getTimestampMs(a);
  const tb = getTimestampMs(b);

  if (isNaN(ta) && isNaN(tb)) return 0;
  if (isNaN(ta)) return 1;
  if (isNaN(tb)) return -1;

  return ta - tb;
}

/**
 * Get relative time string (e.g., "2 hours ago", "3 days ago")
 */
export function getRelativeTime(date) {
  const parsed = safeParseDate(date);
  if (!parsed) return "Unknown";

  const now = new Date();
  const diffMs = differenceInMilliseconds(now, parsed);

  if (diffMs < 0) return "In the future";
  if (diffMs < 60000) return "Just now";
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)} minutes ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)} hours ago`;
  if (diffMs < 604800000) return `${Math.floor(diffMs / 86400000)} days ago`;

  const days = differenceInDays(now, parsed);
  if (days < 30) return `${days} days ago`;

  const hours = differenceInHours(now, parsed);
  if (hours < 720) return `${Math.floor(hours / 24)} days ago`;

  return format(parsed, "yyyy-MM-dd");
}

// =================== DRY Helper Functions ===================

/**
 * Parse date with multiple fallback strategies (DRY principle)
 * Tries: safeParseDate -> parseLooseRelativeTime
 * @param {string} raw - Raw date string to parse
 * @returns {Date|null} Parsed date or null if all strategies fail
 */
export function parseDateWithFallback(raw) {
  if (!raw) return null;

  return safeParseDate(raw) || parseLooseRelativeTime(raw);
}

/**
 * Check if parsed date is valid (DRY wrapper)
 * @param {Date|null} date - Date to check
 * @returns {boolean} True if date is valid
 */
export function isValidDateResult(date) {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/**
 * Batch parse dates and return timestamps for sorting
 * Useful for pre‑computing sort keys
 */
export function batchParseTimestamps(items, dateField = "timestamp") {
  return items.map((item) => ({
    item,
    timestampMs: getTimestampMs(item[dateField]),
  }));
}

/**
 * Get cached data or fetch and cache (DRY pattern for Redis caching)
 *
 * @template T
 * @param {Object} redis - Redis client
 * @param {string} cacheKey - Cache key
 * @param {() => Promise<T>} fetchFn - Async function to fetch data if cache miss
 * @param {number} [ttlSeconds=300] - Cache TTL in seconds (default: 300)
 * @param {string} [context=""] - Context for error logging
 * @returns {Promise<T>} Cached or fetched data
 */
/**
 * Export the warnLog helper for other modules to use.
 */
// (Removed duplicate export; keep only function definition below)

export async function getCachedOrFetch(
  redis,
  cacheKey,
  fetchFn,
  ttlSeconds = 300,
  context = "",
) {
  // Try cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    } catch (err) {
      logger.warn({ context, err: err.message }, "Redis get failed");
    }
  }

  // Fetch fresh data
  try {
    const fresh = await fetchFn();

    // Save to cache if successful
    if (redis && fresh !== null && fresh !== undefined) {
      try {
        const valueToCache =
          typeof fresh === "string" ? fresh : JSON.stringify(fresh);
        await redis.set(cacheKey, valueToCache, { ex: ttlSeconds });
      } catch (cacheErr) {
        // Cache save error - ignore and return fresh data
        logger.warn({ context, err: cacheErr.message }, "Redis set failed");
      }
    }

    return fresh;
  } catch (fetchErr) {
    logger.error({ context, err: fetchErr.message }, "Fetch failed");
    throw fetchErr;
  }
}

/**
 * Standardized warning logger (DRY pattern)
 *
 * @param {string} context - Context/component name
 * @param {Error|{message:string}} err - Error object or an object containing a message property
 * @param {string} [message] - Optional custom message to prepend; if omitted, `err.message` is used.
 */
export function warnLog(context, err, message) {
  const msg =
    typeof err === "object" && "message" in err ? err.message : String(err);
  logger.warn({ context, err: msg }, message ?? "Warning encountered");
}
