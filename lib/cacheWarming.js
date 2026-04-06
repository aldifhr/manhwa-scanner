import { redis } from "./redis.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ module: "cache-warming" });

// Cache warming configuration
const WARMING_INTERVAL_MS = 30_000; // Check every 30 seconds
const WARMING_TTL_THRESHOLD = 0.3; // Warm when 30% of TTL remains

// Track warming state
let warmingInterval = null;
let isWarming = false;

/**
 * Get TTL of a key from Redis
 */
async function getKeyTTL(key) {
  try {
    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : 0;
  } catch (err) {
    logger.error({ key, err: err.message }, "Failed to get TTL");
    return 0;
  }
}

/**
 * Warm a specific cache key by re-fetching data
 */
async function warmCacheKey(key, fetchFn, ttlSeconds) {
  try {
    logger.info({ key }, "Warming cache...");

    const data = await fetchFn();
    if (data) {
      await redis.set(key, JSON.stringify(data), { ex: ttlSeconds });
      logger.info({ key, ttlSeconds }, "Cache warmed successfully");
      return true;
    }
  } catch (err) {
    logger.error({ key, err: err.message }, "Cache warming failed");
  }
  return false;
}

/**
 * Check and warm cache if needed
 */
async function checkAndWarmCache(cacheKey, fetchFn, originalTTL) {
  const ttl = await getKeyTTL(cacheKey);

  // If TTL is low or key doesn't exist, warm it
  if (ttl === 0 || ttl < originalTTL * WARMING_TTL_THRESHOLD) {
    await warmCacheKey(cacheKey, fetchFn, originalTTL);
  }
}

/**
 * List of caches to warm
 */
const CACHES_TO_WARM = [
  {
    key: "api:health-status:cache",
    fetchFn: async () => {
      // Import dynamically to avoid circular deps
      const { default: healthHandler } = await import("../api/health-status.js");
      // Mock request/response to get data
      const mockReq = { headers: {} };
      const mockRes = {
        json: (data) => data,
        status: () => ({ json: (data) => data }),
      };
      return healthHandler(mockReq, mockRes);
    },
    ttlSeconds: 60,
  },
  {
    key: "status:cache",
    fetchFn: async () => {
      const { readCronStatusWithHealth } = await import("./cronRuntime.js");
      return readCronStatusWithHealth(redis);
    },
    ttlSeconds: 60,
  },
];

/**
 * Run cache warming for all registered caches
 */
async function runCacheWarming() {
  if (isWarming) {
    logger.debug("Cache warming already running, skipping");
    return;
  }

  isWarming = true;
  const startTime = Date.now();

  try {
    logger.info("Starting cache warming...");

    const results = await Promise.allSettled(
      CACHES_TO_WARM.map(async (cacheConfig) => {
        try {
          await checkAndWarmCache(
            cacheConfig.key,
            cacheConfig.fetchFn,
            cacheConfig.ttlSeconds,
          );
          return { key: cacheConfig.key, status: "warmed" };
        } catch (err) {
          return { key: cacheConfig.key, status: "failed", error: err.message };
        }
      }),
    );

    const duration = Date.now() - startTime;
    const warmed = results.filter(r => r.value?.status === "warmed").length;
    const failed = results.filter(r => r.value?.status === "failed").length;

    logger.info(
      { duration, warmed, failed },
      "Cache warming completed",
    );
  } catch (err) {
    logger.error({ err: err.message }, "Cache warming error");
  } finally {
    isWarming = false;
  }
}

/**
 * Start automatic cache warming
 */
export function startCacheWarming(options = {}) {
  const interval = options.intervalMs || WARMING_INTERVAL_MS;

  if (warmingInterval) {
    logger.warn("Cache warming already running");
    return;
  }

  logger.info({ interval }, "Starting cache warming service");

  // Run immediately
  runCacheWarming();

  // Then schedule
  warmingInterval = setInterval(runCacheWarming, interval);

  // Handle graceful shutdown
  process.on("SIGTERM", stopCacheWarming);
  process.on("SIGINT", stopCacheWarming);
}

/**
 * Stop cache warming
 */
export function stopCacheWarming() {
  if (warmingInterval) {
    clearInterval(warmingInterval);
    warmingInterval = null;
    logger.info("Cache warming stopped");
  }
}

/**
 * Manually trigger cache warming
 */
export async function manualCacheWarming() {
  await runCacheWarming();
}

/**
 * Check cache warming status
 */
export function getCacheWarmingStatus() {
  return {
    isRunning: warmingInterval !== null,
    isWarming,
    nextCheck: warmingInterval ? WARMING_INTERVAL_MS : null,
  };
}
