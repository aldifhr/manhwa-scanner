import {
  format,
  parseISO,
  isValid,
  isAfter,
  isBefore,
  differenceInMilliseconds,
  differenceInDays,
  differenceInHours,
  subDays,
  subHours,
  startOfDay,
  endOfDay,
  toDate,
  getTime,
} from "date-fns";

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
