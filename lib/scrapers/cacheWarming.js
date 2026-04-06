import { getLogger } from "../logger.js";
import { redis } from "../redis.js";
import { scrapeMangaUpdatesWithMeta } from "./orchestrator.js";

const RECENT_CHAPTERS_KEY = "recent:chapters";
const CACHE_WARM_LOCK_KEY = "cache:warm:lock";
const CACHE_WARM_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 4 * 60 * 1000; // 4 minutes (refresh before 5min expiry)
const MAX_CONCURRENT_WARMS = 2;

let warmingIntervalId = null;
let isWarming = false;

/**
 * Get popular titles from recent chapters
 * Returns titles sorted by access frequency
 */
async function getPopularTitles(limit = 20) {
  try {
    // Get recent chapters to identify popular titles
    const recentData = await redis.get(RECENT_CHAPTERS_KEY);
    if (!recentData) return [];

    let recent = [];
    try {
      recent = JSON.parse(recentData);
    } catch {
      return [];
    }

    // Count occurrences of each title
    const titleCounts = new Map();
    for (const chapter of recent) {
      const key = chapter.title?.toLowerCase().trim();
      if (key) {
        titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
      }
    }

    // Sort by frequency and return top titles
    return Array.from(titleCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([title]) => title);
  } catch (err) {
    getLogger({ module: "cacheWarming" }).error({ err: err.message }, "Failed to get popular titles");
    return [];
  }
}

/**
 * Check if cache warming is already running (distributed lock)
 */
async function acquireWarmLock() {
  try {
    const lockValue = Date.now().toString();
    const acquired = await redis.set(CACHE_WARM_LOCK_KEY, lockValue, {
      nx: true, // Only set if not exists
      ex: 60, // 60 second expiry
    });
    return acquired === "OK";
  } catch {
    return false;
  }
}

/**
 * Release the warm lock
 */
async function releaseWarmLock() {
  try {
    await redis.del(CACHE_WARM_LOCK_KEY);
  } catch {
    // Ignore errors
  }
}

/**
 * Warm cache for specific titles
 */
async function warmCacheForTitles(titles, logger) {
  if (!titles || titles.length === 0) return;

  const warmed = [];
  const errors = [];

  // Use p-limit pattern for concurrency control
  const running = new Set();

  for (const title of titles) {
    // Wait if we've hit the concurrency limit
    while (running.size >= MAX_CONCURRENT_WARMS) {
      await Promise.race(running);
    }

    // Start warming this title
    const promise = (async () => {
      try {
        // Check if data is stale (needs warming)
        const lastCheck = await redis.get(`scrape:lastCheck:${title}`);
        const age = lastCheck ? Date.now() - Number(lastCheck) : Infinity;

        if (age > STALE_THRESHOLD_MS) {
          // Data is stale, need to refresh
          logger.info({ title }, "Warming cache for title");

          // Scrape updates for this specific title
          await scrapeMangaUpdatesWithMeta(redis, {
            preferredIkiruTitles: [title],
            skipExpansion: true,
            incremental: false, // Force refresh
          });

          warmed.push(title);
        }
      } catch (err) {
        logger.warn({ title, err: err.message }, "Failed to warm cache");
        errors.push({ title, error: err.message });
      }
    })();

    running.add(promise);
    promise.finally(() => running.delete(promise));
  }

  // Wait for all to complete
  await Promise.all(running);

  return { warmed, errors };
}

/**
 * Perform cache warming
 * This should be called periodically during low-traffic times
 */
export async function performCacheWarming(options = {}) {
  const logger = options.logger || getLogger({ module: "cacheWarming" });

  // Check if already running
  if (isWarming) {
    logger.debug("Cache warming already in progress, skipping");
    return { skipped: true, reason: "already_running" };
  }

  // Try to acquire distributed lock
  if (!(await acquireWarmLock())) {
    logger.debug("Could not acquire warm lock, another instance is warming");
    return { skipped: true, reason: "lock_not_acquired" };
  }

  isWarming = true;
  const startTime = Date.now();

  try {
    logger.info("Starting cache warming");

    // Get popular titles
    const popularTitles = await getPopularTitles(options.maxTitles || 20);
    if (popularTitles.length === 0) {
      logger.info("No popular titles to warm");
      return { warmed: [], duration: 0 };
    }

    logger.info({ count: popularTitles.length }, "Found popular titles to warm");

    // Warm cache for these titles
    const { warmed, errors } = await warmCacheForTitles(popularTitles, logger);

    const duration = Date.now() - startTime;
    logger.info(
      { warmed: warmed.length, errors: errors.length, duration },
      "Cache warming complete",
    );

    return {
      warmed,
      errors,
      duration,
      warmedCount: warmed.length,
      errorCount: errors.length,
    };
  } catch (err) {
    logger.error({ err: err.message }, "Cache warming failed");
    return { error: err.message, duration: Date.now() - startTime };
  } finally {
    isWarming = false;
    await releaseWarmLock();
  }
}

/**
 * Start automatic cache warming
 * Runs periodically during low-traffic periods
 */
export function startAutoCacheWarming(options = {}) {
  const logger = options.logger || getLogger({ module: "cacheWarming" });

  // Stop any existing interval
  stopAutoCacheWarming();

  // Determine interval based on traffic patterns
  // Default: every 5 minutes
  const intervalMs = options.intervalMs || CACHE_WARM_INTERVAL_MS;

  logger.info({ intervalMs: intervalMs / 1000 }, "Starting auto cache warming");

  warmingIntervalId = setInterval(async () => {
    // Only warm during "low traffic" hours (optional check)
    const hour = new Date().getHours();
    const isLowTraffic = hour >= 1 && hour <= 6; // 1 AM - 6 AM

    if (options.lowTrafficOnly === false || isLowTraffic) {
      await performCacheWarming(options);
    } else {
      logger.debug({ hour }, "Skipping warm - not low traffic period");
    }
  }, intervalMs);

  // Return control functions
  return {
    stop: () => stopAutoCacheWarming(),
    isRunning: () => warmingIntervalId !== null,
    forceWarm: () => performCacheWarming(options),
  };
}

/**
 * Stop automatic cache warming
 */
export function stopAutoCacheWarming() {
  if (warmingIntervalId) {
    clearInterval(warmingIntervalId);
    warmingIntervalId = null;
  }
}

/**
 * Check if cache warming is currently active
 */
export function isCacheWarmingActive() {
  return isWarming;
}

// Default export for convenience
export default {
  performCacheWarming,
  startAutoCacheWarming,
  stopAutoCacheWarming,
  isCacheWarmingActive,
};
