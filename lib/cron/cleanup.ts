/**
 * Cron job cleanup and maintenance tasks
 */

import { getLogger } from "../logger.js";
import {
  syncDailyStatsToSupabase,
} from "../services/storage.js";
import { cleanupScrapeOptimizer } from "../scrapers/optimizer.js";
import { cleanupOldLogs } from "./helpers.js";
import type { RedisClient } from "../types.js";

const logger = getLogger({ scope: "cron:cleanup" });

/**
 * Run all cleanup tasks (fire-and-forget)
 */
export function runCleanupTasks(redis: RedisClient): void {
  // Cleanup optimizer to prevent memory leaks
  cleanupScrapeOptimizer();


  cleanupOldLogs(redis).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to cleanup old logs",
    );
  });

  syncDailyStatsToSupabase(redis).catch(() => {
    // Silent fail for telemetry
  });
}
