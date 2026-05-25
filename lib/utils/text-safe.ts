/**
 * Safe Text Processing Utilities
 * Limits text length before regex to prevent event loop blocking
 */

import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "text-utils" });

// Maximum text lengths for different operations
const MAX_LENGTHS = {
  TITLE: 200,
  DESCRIPTION: 1000,
  SYNOPSIS: 2000,
  CHAPTER: 100,
  SEARCH: 500,
};

/**
 * Safely truncate text before regex operations
 * Prevents event loop blocking on large text
 */
export function safeTruncate(
  text: string | undefined | null,
  maxLength: number,
  suffix: string = "..."
): string {
  if (!text) return "";
  
  const str = String(text);
  
  if (str.length <= maxLength) {
    return str;
  }
  
  return str.slice(0, maxLength) + suffix;
}

/**
 * Safe regex match with text length limit
 */
export function safeMatch(
  text: string | undefined | null,
  pattern: RegExp,
  maxLength: number = MAX_LENGTHS.DESCRIPTION
): RegExpMatchArray | null {
  if (!text) return null;
  
  // Truncate before regex (Issue #3 fix)
  const truncated = safeTruncate(text, maxLength, "");
  
  try {
    return truncated.match(pattern);
  } catch (err) {
    logger.error({ err, pattern: pattern.source }, "Regex match failed");
    return null;
  }
}

/**
 * Safe regex replace with text length limit
 */
export function safeReplace(
  text: string | undefined | null,
  pattern: RegExp | string,
  replacement: string,
  maxLength: number = MAX_LENGTHS.DESCRIPTION
): string {
  if (!text) return "";
  
  // Truncate before regex (Issue #3 fix)
  const truncated = safeTruncate(text, maxLength, "");
  
  try {
    return truncated.replace(pattern, replacement);
  } catch (err) {
    logger.error({ err }, "Regex replace failed");
    return truncated;
  }
}

/**
 * Clean and normalize text safely
 */
export function cleanText(
  text: string | undefined | null,
  options: {
    maxLength?: number;
    removeHtml?: boolean;
    normalizeWhitespace?: boolean;
    trim?: boolean;
  } = {}
): string {
  if (!text) return "";
  
  const {
    maxLength = MAX_LENGTHS.DESCRIPTION,
    removeHtml = true,
    normalizeWhitespace = true,
    trim = true,
  } = options;

  let result = String(text);

  // Truncate first (before any regex!)
  result = safeTruncate(result, maxLength, "");

  // Remove HTML tags (safe on truncated text)
  if (removeHtml) {
    result = result.replace(/<[^>]*>/g, "");
  }

  // Normalize whitespace (safe on truncated text)
  if (normalizeWhitespace) {
    result = result.replace(/\s+/g, " ");
  }

  // Trim
  if (trim) {
    result = result.trim();
  }

  return result;
}

/**
 * Extract chapter number safely
 */
export function extractChapterNumber(
  text: string | undefined | null
): number | null {
  if (!text) return null;
  
  // Truncate to reasonable length (Issue #3 fix)
  const truncated = safeTruncate(text, MAX_LENGTHS.CHAPTER, "");
  
  // Safe regex on short text
  const match = truncated.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Clean description/synopsis safely
 */
export function cleanDescription(
  text: string | undefined | null,
  maxLength: number = MAX_LENGTHS.DESCRIPTION
): string {
  return cleanText(text, {
    maxLength,
    removeHtml: true,
    normalizeWhitespace: true,
    trim: true,
  });
}

/**
 * Clean title safely
 */
export function cleanTitle(
  text: string | undefined | null
): string {
  return cleanText(text, {
    maxLength: MAX_LENGTHS.TITLE,
    removeHtml: true,
    normalizeWhitespace: true,
    trim: true,
  });
}

/**
 * Parse relative time safely (e.g., "2 hours ago")
 * Returns Unix timestamp (Issue #5 fix)
 */
export function parseRelativeTime(
  text: string | undefined | null
): number | null {
  if (!text) return null;
  
  // Truncate first
  const truncated = safeTruncate(text, 100, "").toLowerCase();
  
  const now = Date.now();
  
  // Match patterns (safe on short text)
  const minutesMatch = truncated.match(/(\d+)\s*min/);
  if (minutesMatch) {
    return now - parseInt(minutesMatch[1]) * 60 * 1000;
  }
  
  const hoursMatch = truncated.match(/(\d+)\s*hour/);
  if (hoursMatch) {
    return now - parseInt(hoursMatch[1]) * 60 * 60 * 1000;
  }
  
  const daysMatch = truncated.match(/(\d+)\s*day/);
  if (daysMatch) {
    return now - parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
  }
  
  const weeksMatch = truncated.match(/(\d+)\s*week/);
  if (weeksMatch) {
    return now - parseInt(weeksMatch[1]) * 7 * 24 * 60 * 60 * 1000;
  }
  
  return null;
}

/**
 * Format Unix timestamp to human readable
 */
export function formatTimestamp(
  timestamp: number | null | undefined,
  format: "relative" | "absolute" = "relative"
): string {
  if (!timestamp) return "Unknown";
  
  if (format === "absolute") {
    return new Date(timestamp).toISOString();
  }
  
  // Relative format
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  }
  
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 24) {
    return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  }
  
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days < 7) {
    return `${days} day${days !== 1 ? "s" : ""} ago`;
  }
  
  const weeks = Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
  return `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
}

/**
 * Compare timestamps (faster than Date objects)
 */
export function isNewerThan(
  timestamp1: number,
  timestamp2: number
): boolean {
  return timestamp1 > timestamp2;
}

/**
 * Check if timestamp is within last N hours
 */
export function isWithinHours(
  timestamp: number,
  hours: number
): boolean {
  const now = Date.now();
  const diff = now - timestamp;
  return diff < hours * 60 * 60 * 1000;
}
