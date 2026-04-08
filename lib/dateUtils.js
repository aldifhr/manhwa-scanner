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

// Import fallback parsers for DRY helper
import {
  parseLooseRelativeTime,
  parseRelativeTimeText,
} from "./scrapers/shared.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "dateUtils" });

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
 * Tries: safeParseDate -> parseLooseRelativeTime -> parseRelativeTimeText
 * @param {string} raw - Raw date string to parse
 * @returns {Date|null} Parsed date or null if all strategies fail
 */
export function parseDateWithFallback(raw) {
  if (!raw) return null;

  return (
    safeParseDate(raw) ||
    parseLooseRelativeTime(raw) ||
    parseRelativeTimeText(raw)
  );
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
 * Useful for pre-computing sort keys
 */
export function batchParseTimestamps(items, dateField = "timestamp") {
  return items.map((item) => ({
    item,
    timestampMs: getTimestampMs(item[dateField]),
  }));
}

/**
 * Get cached data or fetch and cache (DRY pattern for Redis caching)
 * @param {Object} redis - Redis client
 * @param {string} cacheKey - Cache key
 * @param {Function} fetchFn - Async function to fetch data if cache miss
 * @param {number} ttlSeconds - Cache TTL in seconds (default: 300)
 * @param {string} context - Context for error logging
 * @returns {Promise<any>} Cached or fetched data
 */
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
 * @param {string} context - Context/component name
 * @param {Error} err - Error object
 * @param {string} message - Additional message
 */
export function logWarnError(context, err, message = "") {
  logger.warn({ context, err: err?.message || err }, message || "Warning");
}

/**
 * Safely parse JSON with fallback (DRY pattern)
 * @param {string} jsonString - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
export function safeJsonParse(jsonString, defaultValue = null) {
  if (!jsonString) return defaultValue;
  try {
    return typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;
  } catch {
    return defaultValue;
  }
}

/**
 * Sort array by date field (descending - newest first)
 */
export function sortByDateDesc(items, dateField = "timestamp") {
  return batchParseTimestamps(items, dateField)
    .filter(({ timestampMs }) => !isNaN(timestampMs))
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .map(({ item }) => item);
}

/**
 * Sort array by date field (ascending - oldest first)
 */
export function sortByDateAsc(items, dateField = "timestamp") {
  return batchParseTimestamps(items, dateField)
    .filter(({ timestampMs }) => !isNaN(timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map(({ item }) => item);
}
