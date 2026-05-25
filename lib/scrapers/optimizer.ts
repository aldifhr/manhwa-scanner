/**
 * Advanced Scraping Optimizations
 * Request deduplication, intelligent caching, and concurrent optimization
 */

import { RedisClient } from "../types.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "scrape-optimizer" });

/**
 * In-flight request deduplication
 * Prevents duplicate requests to the same URL
 */
class RequestDeduplicator {
  private inFlight: Map<string, Promise<unknown>>;
  private cache: Map<string, { data: unknown; timestamp: number }>;
  private cacheTTL: number;
  private readonly MAX_ITEMS = 500;

  constructor(cacheTTL: number = 60000) {
    this.inFlight = new Map();
    this.cache = new Map();
    this.cacheTTL = cacheTTL;
  }

  /**
   * Execute request with deduplication
   */
  async dedupe<T>(
    key: string,
    fn: () => Promise<T>,
    options: {
      useCache?: boolean;
      cacheTTL?: number;
    } = {}
  ): Promise<T> {
    const { useCache = true, cacheTTL = this.cacheTTL } = options;

    // Check cache first
    if (useCache) {
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.timestamp < cacheTTL) {
        logger.debug({ key }, "Cache hit");
        return cached.data as T;
      }
    }

    // Check if request is already in flight
    if (this.inFlight.has(key)) {
      logger.debug({ key }, "Request already in flight, waiting");
      return this.inFlight.get(key) as Promise<T>;
    }

    // Execute new request
    const promise = fn()
      .then((data) => {
        // Cache result with capacity check
        if (useCache) {
          if (this.cache.size >= this.MAX_ITEMS) {
            // Simple eviction: remove oldest item (first key in insertion order)
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
          }
          this.cache.set(key, { data, timestamp: Date.now() });
        }
        return data;
      })
      .finally(() => {
        // Remove from in-flight
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Clear expired cache entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.cacheTTL) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      inFlight: this.inFlight.size,
      cached: this.cache.size,
      cacheHitRate: 0, // TODO: track hits/misses
    };
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.inFlight.clear();
    this.cache.clear();
  }
}

/**
 * Intelligent caching strategy with Redis backend
 */
export class ScrapeCacheManager {
  private redis: RedisClient | null;
  private localCache: Map<string, { data: unknown; timestamp: number }>;
  private cachePrefix: string;
  private readonly MAX_LOCAL_ITEMS = 1000;

  constructor(redis: RedisClient | null, cachePrefix: string = "scrape:cache") {
    this.redis = redis;
    this.localCache = new Map();
    this.cachePrefix = cachePrefix;
  }

  /**
   * Get cached data with fallback to local cache
   */
  async get<T>(key: string): Promise<T | null> {
    // Check local cache first (faster)
    const localKey = `${this.cachePrefix}:${key}`;
    const local = this.localCache.get(localKey);
    if (local) {
      return local.data as T;
    }

    // Check Redis cache
    if (this.redis) {
      try {
        const redisKey = `${this.cachePrefix}:${key}`;
        const cached = await this.redis.get(redisKey);
        if (cached) {
          const data = typeof cached === "string" ? JSON.parse(cached) : cached;
          // Populate local cache with capacity check
          if (this.localCache.size >= this.MAX_LOCAL_ITEMS) {
            const firstKey = this.localCache.keys().next().value;
            if (firstKey !== undefined) this.localCache.delete(firstKey);
          }
          this.localCache.set(localKey, { data, timestamp: Date.now() });
          return data as T;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message, key }, "Redis cache get failed");
      }
    }

    return null;
  }

  /**
   * Set cached data in both local and Redis
   */
  async set<T>(key: string, data: T, ttlSeconds: number = 3600): Promise<void> {
    const localKey = `${this.cachePrefix}:${key}`;
    
    // Set local cache with capacity check
    if (this.localCache.size >= this.MAX_LOCAL_ITEMS) {
      const firstKey = this.localCache.keys().next().value;
      if (firstKey !== undefined) this.localCache.delete(firstKey);
    }
    this.localCache.set(localKey, { data, timestamp: Date.now() });

    // Set Redis cache
    if (this.redis) {
      try {
        const redisKey = `${this.cachePrefix}:${key}`;
        await this.redis.set(redisKey, JSON.stringify(data), { ex: ttlSeconds });
      } catch (err) {
        logger.warn({ err: (err as Error).message, key }, "Redis cache set failed");
      }
    }
  }

  /**
   * Invalidate cache entry
   */
  async invalidate(key: string): Promise<void> {
    const localKey = `${this.cachePrefix}:${key}`;
    this.localCache.delete(localKey);

    if (this.redis) {
      try {
        const redisKey = `${this.cachePrefix}:${key}`;
        await this.redis.del(redisKey);
      } catch (err) {
        logger.warn({ err: (err as Error).message, key }, "Redis cache delete failed");
      }
    }
  }

  /**
   * Cleanup expired local cache entries
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [key, entry] of this.localCache.entries()) {
      if (now - entry.timestamp > maxAge) {
        this.localCache.delete(key);
      }
    }
  }
}

/**
 * Adaptive concurrency limiter
 * Adjusts concurrency based on response times and error rates
 */
export class AdaptiveConcurrencyLimiter {
  private currentConcurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private responseTimes: number[];
  private errorCount: number;
  private successCount: number;
  private windowSize: number;

  constructor(
    initialConcurrency: number = 3,
    minConcurrency: number = 1,
    maxConcurrency: number = 10
  ) {
    this.currentConcurrency = initialConcurrency;
    this.minConcurrency = minConcurrency;
    this.maxConcurrency = maxConcurrency;
    this.responseTimes = [];
    this.errorCount = 0;
    this.successCount = 0;
    this.windowSize = 20;
  }

  /**
   * Record successful request
   */
  recordSuccess(responseTimeMs: number): void {
    this.successCount++;
    this.responseTimes.push(responseTimeMs);
    
    // Keep only recent response times
    if (this.responseTimes.length > this.windowSize) {
      this.responseTimes.shift();
    }

    this.adjust();
  }

  /**
   * Record failed request
   */
  recordError(): void {
    this.errorCount++;
    this.adjust();
  }

  /**
   * Adjust concurrency based on performance
   */
  private adjust(): void {
    const totalRequests = this.successCount + this.errorCount;
    if (totalRequests < 10) return; // Need enough data

    const errorRate = this.errorCount / totalRequests;
    const avgResponseTime = this.responseTimes.length > 0
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
      : 0;

    // Decrease concurrency if error rate is high
    if (errorRate > 0.2) {
      this.currentConcurrency = Math.max(
        this.minConcurrency,
        Math.floor(this.currentConcurrency * 0.7)
      );
      logger.info(
        { concurrency: this.currentConcurrency, errorRate },
        "Decreased concurrency due to high error rate"
      );
    }
    // Decrease concurrency if response time is slow
    else if (avgResponseTime > 5000) {
      this.currentConcurrency = Math.max(
        this.minConcurrency,
        Math.floor(this.currentConcurrency * 0.8)
      );
      logger.info(
        { concurrency: this.currentConcurrency, avgResponseTime },
        "Decreased concurrency due to slow response time"
      );
    }
    // Increase concurrency if performing well
    else if (errorRate < 0.05 && avgResponseTime < 2000) {
      this.currentConcurrency = Math.min(
        this.maxConcurrency,
        Math.floor(this.currentConcurrency * 1.2)
      );
      logger.info(
        { concurrency: this.currentConcurrency, errorRate, avgResponseTime },
        "Increased concurrency due to good performance"
      );
    }

    // Reset counters periodically
    if (totalRequests > 50) {
      this.errorCount = Math.floor(this.errorCount * 0.5);
      this.successCount = Math.floor(this.successCount * 0.5);
    }
  }

  /**
   * Get current concurrency limit
   */
  getConcurrency(): number {
    return this.currentConcurrency;
  }

  /**
   * Get performance stats
   */
  getStats() {
    const totalRequests = this.successCount + this.errorCount;
    const errorRate = totalRequests > 0 ? this.errorCount / totalRequests : 0;
    const avgResponseTime = this.responseTimes.length > 0
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
      : 0;

    return {
      currentConcurrency: this.currentConcurrency,
      errorRate,
      avgResponseTime,
      totalRequests,
    };
  }
}

/**
 * Global instances
 */
export const globalRequestDeduplicator = new RequestDeduplicator(60000);
export const globalScrapeCacheManager = new ScrapeCacheManager(null);
export const globalAdaptiveLimiter = new AdaptiveConcurrencyLimiter(10, 5, 15);

/**
 * Initialize with Redis client
 */
export function initializeScrapeOptimizer(redis: RedisClient | null): void {
  // Re-create cache manager with Redis
  Object.assign(globalScrapeCacheManager, new ScrapeCacheManager(redis));
  logger.info("Scrape optimizer initialized with Redis");
}

/**
 * Cleanup function to run periodically
 */
export function cleanupScrapeOptimizer(): void {
  globalRequestDeduplicator.cleanup();
  globalScrapeCacheManager.cleanup();
  
  logger.debug(
    {
      deduplicator: globalRequestDeduplicator.getStats(),
      limiter: globalAdaptiveLimiter.getStats(),
    },
    "Scrape optimizer cleanup completed"
  );
}
