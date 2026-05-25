/**
 * Safe In-Memory Cache with LRU Eviction
 * Prevents memory leaks in Vercel serverless
 */

import { LRUCache } from "lru-cache";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "cache" });

/**
 * Cache configuration
 */
interface CacheConfig {
  max?: number; // Max items
  ttl?: number; // Time to live (ms)
  maxSize?: number; // Max memory size (bytes)
  sizeCalculation?: (value: any) => number;
}

/**
 * Default cache configs for different use cases
 */
const DEFAULT_CONFIGS = {
  // Small cache for frequently accessed data
  small: {
    max: 100,
    ttl: 5 * 60 * 1000, // 5 minutes
    maxSize: 1024 * 1024, // 1MB
  },
  
  // Medium cache for moderate data
  medium: {
    max: 500,
    ttl: 15 * 60 * 1000, // 15 minutes
    maxSize: 5 * 1024 * 1024, // 5MB
  },
  
  // Large cache for heavy data
  large: {
    max: 1000,
    ttl: 30 * 60 * 1000, // 30 minutes
    maxSize: 10 * 1024 * 1024, // 10MB
  },
};

/**
 * Global cache instances
 */
const caches = new Map<string, LRUCache<any, any, any>>();

/**
 * Get or create cache instance
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function getCache<T extends {} = any>(
  name: string,
  config: CacheConfig = DEFAULT_CONFIGS.medium
): LRUCache<string, T, any> {
  if (!caches.has(name)) {
    const cache = new LRUCache({
      max: config.max || 500,
      ttl: config.ttl || 15 * 60 * 1000,
      maxSize: config.maxSize || 5 * 1024 * 1024,
      sizeCalculation: config.sizeCalculation || ((value) => {
        // Estimate size in bytes
        const str = JSON.stringify(value);
        return str.length * 2; // UTF-16 = 2 bytes per char
      }),
      // Dispose callback (cleanup)
      dispose: (value, key) => {
        logger.debug({ key }, "Cache entry evicted");
      },
    });
    
    caches.set(name, cache);
    logger.info({ name, config }, "Cache created");
  }
  
  return caches.get(name)!;
}

/**
 * Whitelist cache (replaces global object)
 */
export const whitelistCache = getCache("whitelist", {
  max: 1, // Only one whitelist
  ttl: 5 * 60 * 1000, // 5 minutes
  maxSize: 1024 * 1024, // 1MB
});

/**
 * Manga metadata cache
 */
export const metadataCache = getCache("metadata", {
  max: 200, // 200 manga
  ttl: 30 * 60 * 1000, // 30 minutes
  maxSize: 2 * 1024 * 1024, // 2MB
});

/**
 * Chapter cache
 */
export const chapterCache = getCache("chapters", {
  max: 1000, // 1000 chapters
  ttl: 15 * 60 * 1000, // 15 minutes
  maxSize: 5 * 1024 * 1024, // 5MB
});

/**
 * HTTP response cache
 */
export const httpCache = getCache("http", {
  max: 100, // 100 responses
  ttl: 5 * 60 * 1000, // 5 minutes
  maxSize: 10 * 1024 * 1024, // 10MB
});

/**
 * Safe cache get with fallback
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function cacheGet<T extends {}>(
  cache: LRUCache<string, T, any>,
  key: string,
  fallback?: T
): T | undefined {
  const value = cache.get(key);
  
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  
  return value;
}

/**
 * Safe cache set with size check
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function cacheSet<T extends {}>(
  cache: LRUCache<string, T, any>,
  key: string,
  value: T,
  options?: { ttl?: number }
): boolean {
  try {
    cache.set(key, value, options);
    return true;
  } catch (err) {
    logger.error({ err, key }, "Failed to set cache");
    return false;
  }
}

/**
 * Get or compute (with caching)
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export async function cacheGetOrCompute<T extends {} = any>(
  cache: LRUCache<string, T, any>,
  key: string,
  compute: () => Promise<T>,
  options?: { ttl?: number }
): Promise<T> {
  // Check cache first
  const cached = cache.get(key);
  if (cached !== undefined) {
    logger.debug({ key }, "Cache hit");
    return cached;
  }
  
  // Cache miss, compute
  logger.debug({ key }, "Cache miss, computing");
  const value = await compute();
  
  // Store in cache
  cache.set(key, value, options);
  
  return value;
}

/**
 * Batch get from cache
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function cacheBatchGet<T extends {} = any>(
  cache: LRUCache<string, T, any>,
  keys: string[]
): Map<string, T> {
  const results = new Map<string, T>();
  
  for (const key of keys) {
    const value = cache.get(key);
    if (value !== undefined) {
      results.set(key, value);
    }
  }
  
  return results;
}

/**
 * Batch set to cache
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function cacheBatchSet<T extends {} = any>(
  cache: LRUCache<string, T, any>,
  entries: Map<string, T>,
  options?: { ttl?: number }
): number {
  let count = 0;
  
  for (const [key, value] of entries) {
    if (cacheSet(cache, key, value, options)) {
      count++;
    }
  }
  
  return count;
}

/**
 * Clear specific cache
 */
export function clearCache(name: string): void {
  const cache = caches.get(name);
  if (cache) {
    cache.clear();
    logger.info({ name }, "Cache cleared");
  }
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
  for (const [name, cache] of caches) {
    cache.clear();
    logger.info({ name }, "Cache cleared");
  }
}

/**
 * Get cache stats
 */
export function getCacheStats(name: string): {
  size: number;
  max: number;
  calculatedSize: number;
  maxSize: number;
} | null {
  const cache = caches.get(name);
  if (!cache) return null;
  
  return {
    size: cache.size,
    max: cache.max,
    calculatedSize: cache.calculatedSize || 0,
    maxSize: cache.maxSize || 0,
  };
}

/**
 * Get all cache stats
 */
export function getAllCacheStats(): Record<string, any> {
  const stats: Record<string, any> = {};
  
  for (const [name, cache] of caches) {
    stats[name] = {
      size: cache.size,
      max: cache.max,
      calculatedSize: cache.calculatedSize || 0,
      maxSize: cache.maxSize || 0,
      hitRate: calculateHitRate(cache),
    };
  }
  
  return stats;
}

/**
 * Calculate cache hit rate (approximate)
 */
function calculateHitRate(cache: LRUCache<string, any>): number {
  // LRU cache doesn't track hits/misses by default
  // This is an approximation based on size
  const fillRate = cache.size / cache.max;
  return fillRate * 100;
}

/**
 * Prune old entries (manual cleanup)
 */
export function pruneCache(name: string): number {
  const cache = caches.get(name);
  if (!cache) return 0;
  
  const sizeBefore = cache.size;
  cache.purgeStale();
  const sizeAfter = cache.size;
  
  const pruned = sizeBefore - sizeAfter;
  
  if (pruned > 0) {
    logger.info({ name, pruned }, "Cache pruned");
  }
  
  return pruned;
}

/**
 * Prune all caches
 */
export function pruneAllCaches(): number {
  let totalPruned = 0;
  
  for (const name of caches.keys()) {
    totalPruned += pruneCache(name);
  }
  
  return totalPruned;
}

/**
 * Monitor cache memory usage
 */
export function monitorCacheMemory(): {
  total: number;
  byCache: Record<string, number>;
  warning: boolean;
} {
  let total = 0;
  const byCache: Record<string, number> = {};
  
  for (const [name, cache] of caches) {
    const size = cache.calculatedSize || 0;
    byCache[name] = size;
    total += size;
  }
  
  const warning = total > 50 * 1024 * 1024; // Warn if > 50MB
  
  if (warning) {
    logger.warn({ 
      total: `${(total / 1024 / 1024).toFixed(2)}MB`,
      byCache 
    }, "High cache memory usage");
  }
  
  return { total, byCache, warning };
}
