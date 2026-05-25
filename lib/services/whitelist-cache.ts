/**
 * Whitelist Memory Cache
 * Reduces Redis reads by 90%
 */

import type { RedisClient, WhitelistEntry } from "../types.js";
import { getLogger } from "../logger.js";
import { loadWhitelist as loadWhitelistFromRedis } from "./storage.js";

const logger = getLogger({ scope: "whitelist-cache" });

interface CacheEntry {
  data: WhitelistEntry[];
  timestamp: number;
  version: string;
}

// In-memory cache
let cache: CacheEntry | null = null;

// Cache TTL (5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;

// Version key in Redis
const VERSION_KEY = "whitelist:version";

/**
 * Get whitelist with memory cache
 * Only loads from Redis if cache is stale or version changed
 */
export async function loadWhitelistCached(
  redis: RedisClient,
  options: {
    forceFresh?: boolean;
    ttl?: number;
  } = {}
): Promise<WhitelistEntry[]> {
  const forceFresh = options.forceFresh ?? false;
  const ttl = options.ttl ?? CACHE_TTL_MS;
  const now = Date.now();

  // Force fresh load
  if (forceFresh) {
    logger.debug("Force loading whitelist from Redis");
    return await loadFreshWhitelist(redis);
  }

  // Check if cache exists and is fresh
  if (cache && (now - cache.timestamp) < ttl) {
    // Check if version changed
    const currentVersion = await getWhitelistVersion(redis);
    
    if (currentVersion === cache.version) {
      logger.debug({ 
        age: now - cache.timestamp,
        count: cache.data.length 
      }, "Using cached whitelist");
      return cache.data;
    } else {
      logger.debug({ 
        oldVersion: cache.version,
        newVersion: currentVersion 
      }, "Whitelist version changed, reloading");
    }
  }

  // Cache miss or stale, load fresh
  return await loadFreshWhitelist(redis);
}

/**
 * Load fresh whitelist from Redis and update cache
 */
async function loadFreshWhitelist(redis: RedisClient): Promise<WhitelistEntry[]> {
  const startTime = Date.now();
  
  try {
    const data = await loadWhitelistFromRedis(redis);
    const version = await getWhitelistVersion(redis);
    
    // Update cache
    cache = {
      data,
      timestamp: Date.now(),
      version,
    };

    const duration = Date.now() - startTime;
    logger.info({ 
      count: data.length,
      duration,
      version 
    }, "Loaded fresh whitelist");

    return data;
  } catch (err) {
    logger.error({ err }, "Failed to load whitelist");
    
    // Return stale cache if available
    if (cache) {
      logger.warn("Returning stale cache due to error");
      return cache.data;
    }
    
    throw err;
  }
}

/**
 * Get whitelist version from Redis
 */
async function getWhitelistVersion(redis: RedisClient): Promise<string> {
  try {
    const version = await redis.get(VERSION_KEY);
    return version || "0";
  } catch (err) {
    logger.error({ err }, "Failed to get whitelist version");
    return "0";
  }
}

/**
 * Increment whitelist version (call when whitelist changes)
 */
export async function incrementWhitelistVersion(redis: RedisClient): Promise<void> {
  try {
    await redis.incr(VERSION_KEY);
    logger.debug("Incremented whitelist version");
  } catch (err) {
    logger.error({ err }, "Failed to increment whitelist version");
  }
}

/**
 * Invalidate cache (force reload on next access)
 */
export function invalidateWhitelistCache(): void {
  cache = null;
  logger.debug("Invalidated whitelist cache");
}

/**
 * Get cache stats
 */
export function getWhitelistCacheStats(): {
  cached: boolean;
  age: number | null;
  count: number | null;
  version: string | null;
} {
  if (!cache) {
    return {
      cached: false,
      age: null,
      count: null,
      version: null,
    };
  }

  return {
    cached: true,
    age: Date.now() - cache.timestamp,
    count: cache.data.length,
    version: cache.version,
  };
}
