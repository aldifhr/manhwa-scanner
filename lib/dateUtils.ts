import {
  differenceInDays,
  differenceInHours,
  differenceInMilliseconds,
  endOfDay,
  format,
  getTime,
  isAfter,
  isValid,
  parseISO,
  startOfDay,
  subDays,
  subHours,
  toDate,
} from "date-fns";
import { getLogger } from "./logger.js";
import { RedisClient } from "./types.js";

const logger = getLogger({ scope: "dateUtils" });

/**
 * Parse and validate a date string or object
 * Returns Date object or null if invalid
 */
export function safeParseDate(date: any): Date | null {
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
export function getTimestampMs(date: any): number {
  const parsed = parseDateWithFallback(date);
  return parsed ? getTime(parsed) : NaN;
}

/**
 * Check if a date is valid
 */
export function isValidDate(date: any): boolean {
  return safeParseDate(date) !== null;
}

/**
 * Format date to ISO string safely
 * Returns ISO string or null if invalid
 */
export function toISOSafe(date: any): string | null {
  const parsed = safeParseDate(date);
  return parsed ? format(parsed, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") : null;
}

/**
 * Calculate cutoff time for filtering
 * Returns timestamp in milliseconds
 */
export function getCutoffTime(daysBack = 30, hoursBack = 0): number {
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
export function isWithinLastDays(date: any, days: number): boolean {
  const parsed = safeParseDate(date);
  if (!parsed) return false;

  const cutoff = subDays(new Date(), days);
  return isAfter(parsed, cutoff);
}

/**
 * Check if date is within last N hours
 */
export function isWithinLastHours(date: any, hours: number): boolean {
  const parsed = safeParseDate(date);
  if (!parsed) return false;

  const cutoff = subHours(new Date(), hours);
  return isAfter(parsed, cutoff);
}

/**
 * Compare two dates for sorting (descending - newest first)
 */
export function compareDatesDesc(a: any, b: any): number {
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
export function compareDatesAsc(a: any, b: any): number {
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
export function getRelativeTime(date: any): string {
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



/**
 * Parse loose relative time strings (e.g., "2 hours ago", "3 days ago", "5 menit")
 * Returns Date object or null if parsing fails
 */
export function parseLooseRelativeTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const text = String(raw).toLowerCase().trim();
  
  // Extended regex for Shinigami ID: mnt (menit), d (hari), bln (bulan)
  const m = text.match(
    /(\d+)\s*(minute|minutes|min|menit|mnt|hour|hours|hr|jam|day|days|d|hari|week|weeks|minggu|month|months|bulan|bln)/,
  );
  if (!m) return null;

  const amount = Number.parseInt(m[1], 10);
  if (Number.isNaN(amount)) return null;

  const unit = m[2];
  let minutes = amount;
  if (unit === "hour" || unit === "hours" || unit === "hr" || unit === "jam") {
    minutes = amount * 60;
  } else if (unit === "day" || unit === "days" || unit === "d" || unit === "hari") {
    minutes = amount * 60 * 24;
  } else if (unit === "week" || unit === "weeks" || unit === "minggu") {
    minutes = amount * 60 * 24 * 7;
  } else if (unit === "month" || unit === "months" || unit === "bulan" || unit === "bln") {
    // Approximate month as 30 days
    minutes = amount * 60 * 24 * 30;
  }
  // Note: "minute|minutes|min|menit|mnt" defaults to minutes (no conversion needed)

  return new Date(Date.now() - minutes * 60 * 1000);
}

/**
 * Parse date with multiple fallback strategies (DRY principle)
 */
export function parseDateWithFallback(raw: string | null | undefined): Date | null {
  if (!raw) return null;

  return (
    safeParseDate(raw) ||
    parseLooseRelativeTime(raw)
  );
}

/**
 * Batch parse dates and return timestamps for sorting
 */
function batchParseTimestamps<T>(items: T[], dateField: keyof T): { item: T; timestampMs: number }[] {
  return items.map((item) => ({
    item,
    timestampMs: getTimestampMs(item[dateField]),
  }));
}

/**
 * Get cached data or fetch and cache (DRY pattern for Redis caching)
 */
export async function getCachedOrFetch<T>(
  redis: RedisClient | null | undefined,
  cacheKey: string,
  fetchFn: () => Promise<T>,
  ttlSeconds = 300,
  context = "",
): Promise<T> {
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    } catch (err: any) {
      logger.warn({ context, err: err.message }, "Redis get failed");
    }
  }

  try {
    const fresh = await fetchFn();

    if (redis && fresh !== null && fresh !== undefined) {
      try {
        const valueToCache =
          typeof fresh === "string" ? fresh : JSON.stringify(fresh);
        await redis.set(cacheKey, valueToCache, { ex: ttlSeconds });
      } catch (cacheErr: any) {
        logger.warn({ context, err: cacheErr.message }, "Redis set failed");
      }
    }

    return fresh;
  } catch (fetchErr: any) {
    logger.error({ context, err: fetchErr.message }, "Fetch failed");
    throw fetchErr;
  }
}

/**
 * Safely parse JSON with fallback (DRY pattern)
 */
export function safeJsonParse(jsonString: string | null | undefined, defaultValue: any = null): any {
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
export function sortByDateDesc<T>(items: T[], dateField = "timestamp" as keyof T): T[] {
  return batchParseTimestamps(items, dateField)
    .filter(({ timestampMs }) => !isNaN(timestampMs))
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .map(({ item }) => item);
}

/**
 * Sort array by date field (ascending - oldest first)
 */
export function sortByDateAsc<T>(items: T[], dateField = "timestamp" as keyof T): T[] {
  return batchParseTimestamps(items, dateField)
    .filter(({ timestampMs }) => !isNaN(timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map(({ item }) => item);
}
