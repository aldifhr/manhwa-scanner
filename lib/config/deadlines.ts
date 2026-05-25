/**
 * Centralized Deadline Configuration
 * Single source of truth for all timeout and deadline management
 */

import { env } from "./env.js";

/**
 * Deadline hierarchy for serverless execution
 * Each level has progressively tighter constraints
 */
export const DEADLINES = {
  // Vercel hard limit (cannot exceed)
  VERCEL_HARD_LIMIT_MS: 30_000,
  
  // Internal buffer to ensure we finish before Vercel kills us
  INTERNAL_BUFFER_MS: 2_000,
  
  // Safety margins for different operations
  SCRAPE_SAFETY_MARGIN_MS: 8_000,
  DISPATCH_SAFETY_MARGIN_MS: 6_500,
  METADATA_SAFETY_MARGIN_MS: 4_000,
  FINAL_ABORT_MARGIN_MS: 1_500,
  
  /**
   * Get internal deadline (Vercel limit - buffer)
   * This is the target completion time for the entire cron job
   */
  get INTERNAL_DEADLINE_MS(): number {
    return this.VERCEL_HARD_LIMIT_MS - this.INTERNAL_BUFFER_MS;
  },
  
  /**
   * Get scrape deadline (internal deadline - scrape margin)
   * Scraping must complete before this to leave time for dispatch
   */
  get SCRAPE_DEADLINE_MS(): number {
    return this.INTERNAL_DEADLINE_MS - this.SCRAPE_SAFETY_MARGIN_MS;
  },
  
  /**
   * Get dispatch deadline (scrape deadline - dispatch margin)
   * Dispatch must complete before this to leave time for cleanup
   */
  get DISPATCH_DEADLINE_MS(): number {
    return this.SCRAPE_DEADLINE_MS - this.DISPATCH_SAFETY_MARGIN_MS;
  },
  
  /**
   * Calculate remaining time until deadline
   */
  getRemainingTime(startTime: number, deadline: number): number {
    return Math.max(0, deadline - (Date.now() - startTime));
  },
  
  /**
   * Check if we should abort due to approaching deadline
   */
  shouldAbort(startTime: number, deadline: number, marginMs: number): boolean {
    const elapsed = Date.now() - startTime;
    return elapsed > (deadline - marginMs);
  },
  
  /**
   * Get deadline for specific operation
   */
  getOperationDeadline(startTime: number, operation: "scrape" | "dispatch" | "metadata"): number {
    switch (operation) {
      case "scrape":
        return startTime + this.SCRAPE_DEADLINE_MS;
      case "dispatch":
        return startTime + this.DISPATCH_DEADLINE_MS;
      case "metadata":
        return startTime + this.SCRAPE_DEADLINE_MS - this.METADATA_SAFETY_MARGIN_MS;
      default:
        return startTime + this.INTERNAL_DEADLINE_MS;
    }
  },
} as const;

/**
 * HTTP Client Timeouts (optimized for serverless)
 */
export const HTTP_TIMEOUTS = {
  // Individual request timeout
  REQUEST_TIMEOUT_MS: 8_000,
  
  // Total timeout for operation (including retries)
  TOTAL_TIMEOUT_MS: 15_000,
  
  // Connection timeout
  CONNECT_TIMEOUT_MS: 3_000,
  
  // Keep-alive timeout
  KEEP_ALIVE_TIMEOUT_MS: 15_000,
} as const;

/**
 * Redis Operation Timeouts
 */
export const REDIS_TIMEOUTS = {
  // Single operation timeout
  OPERATION_TIMEOUT_MS: 2_000,
  
  // Pipeline execution timeout
  PIPELINE_TIMEOUT_MS: 5_000,
  
  // Lock acquisition timeout
  LOCK_TIMEOUT_MS: 10_000,
} as const;

/**
 * Concurrency Limits (optimized for serverless)
 */
export const CONCURRENCY_LIMITS = {
  // HTTP client settings
  HTTP_MAX_SOCKETS: 20,
  HTTP_MAX_FREE_SOCKETS: 5,
  
  // Scraper concurrency
  SCRAPER_CONCURRENCY: 3,
  METADATA_ENRICHMENT_CONCURRENCY: 2,
  
  // Dispatch concurrency
  CHANNEL_DISPATCH_CONCURRENCY: 10,
  DISCORD_SEND_MAX_CONCURRENT: 10,
  
  // Channel validation
  CHANNEL_VALIDATION_CONCURRENCY: 10,
} as const;

/**
 * Batch Sizes
 */
export const BATCH_SIZES = {
  // Redis pipeline batch size
  REDIS_PIPELINE_BATCH: 50,
  
  // Channel processing batch size
  CHANNEL_BATCH_SIZE: 10,
  
  // Discord embeds per message
  DISCORD_EMBEDS_PER_MESSAGE: 10,
  
  // Metadata enrichment limit
  METADATA_ENRICHMENT_LIMIT: 10,
} as const;

/**
 * Retry Configuration
 */
export const RETRY_CONFIG = {
  // Max retry attempts
  MAX_RETRIES: 2,
  
  // Base delay between retries (ms)
  BASE_DELAY_MS: 1_000,
  
  // Max delay between retries (ms)
  MAX_DELAY_MS: 6_000,
  
  // Jitter to add to retry delay (ms)
  JITTER_MS: 200,
} as const;

/**
 * Helper function to create deadline-aware timeout
 */
export function createDeadlineTimeout(
  startTime: number,
  operation: "scrape" | "dispatch" | "metadata",
  customMarginMs?: number
): number {
  const deadline = DEADLINES.getOperationDeadline(startTime, operation);
  const remaining = DEADLINES.getRemainingTime(startTime, deadline);
  
  if (customMarginMs) {
    return Math.max(0, remaining - customMarginMs);
  }
  
  return remaining;
}

/**
 * Helper function to check if operation should be aborted
 */
export function shouldAbortOperation(
  startTime: number,
  operation: "scrape" | "dispatch" | "metadata"
): boolean {
  const deadline = DEADLINES.getOperationDeadline(startTime, operation);
  const marginMs = operation === "scrape" 
    ? DEADLINES.SCRAPE_SAFETY_MARGIN_MS 
    : DEADLINES.DISPATCH_SAFETY_MARGIN_MS;
  
  return DEADLINES.shouldAbort(startTime, deadline, marginMs);
}
