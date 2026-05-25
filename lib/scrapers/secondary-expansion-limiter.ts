import { SECONDARY_CONFIG } from "../config.js";

export interface SecondaryExpansionOptions {
  /** Maximum rows to process (default: 20) */
  maxRows?: number;
  /** Maximum concurrent detail fetches (default: 5) */
  maxConcurrency?: number;
  /** Maximum expansion searches (default: 5) */
  maxExpansionSearches?: number;
}

export const DEFAULT_SECONDARY_OPTIONS: Required<SecondaryExpansionOptions> = {
  maxRows: SECONDARY_CONFIG.MAX_ROWS,
  maxConcurrency: SECONDARY_CONFIG.MAX_CONCURRENCY,
  maxExpansionSearches: SECONDARY_CONFIG.MAX_EXPANSION_SEARCHES,
};

/**
 * Cap rows to prevent unbounded processing
 */
export function capRows<T>(
  rows: T[],
  maxRows: number = DEFAULT_SECONDARY_OPTIONS.maxRows,
  logFn?: (msg: string, meta: any) => void,
): { capped: T[]; wasCapped: boolean; originalCount: number } {
  const originalCount = rows.length;

  if (originalCount <= maxRows) {
    return { capped: rows, wasCapped: false, originalCount };
  }

  // Keep first N rows (assumed most recent)
  const capped = rows.slice(0, maxRows);

  logFn?.(
    `Secondary rows capped: ${originalCount} → ${maxRows}`,
    { originalCount, cappedCount: maxRows },
  );

  return { capped, wasCapped: true, originalCount };
}

/**
 * Cap expansion searches
 */
export function capExpansionSearches<T>(
  items: T[],
  maxSearches: number = DEFAULT_SECONDARY_OPTIONS.maxExpansionSearches,
): T[] {
  if (items.length <= maxSearches) return items;
  return items.slice(0, maxSearches);
}
