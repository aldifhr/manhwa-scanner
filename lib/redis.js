import "dotenv/config";
import { Redis } from "@upstash/redis";
import { normalizeTitleKey, normalizeWhitelist } from "./domain.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "redis" });

// Create Redis client with graceful error handling
function createRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    logger.error("Redis configuration missing: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set");
    // Return a mock Redis client that logs operations but doesn't fail
    return createMockRedisClient();
  }

  try {
    return new Redis({
      url,
      token,
      enableAutoPipelining: true,
    });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to create Redis client, using mock");
    return createMockRedisClient();
  }
}

// Mock Redis client for graceful degradation when Redis is unavailable
function createMockRedisClient() {
  const mockOperation = (operation, defaultValue = null) => (...args) => {
    logger.warn({ operation, args: args.slice(0, 2) }, `Mock Redis: ${operation} called`);
    return Promise.resolve(defaultValue);
  };

  const pipelineOperation = (operation, defaultValue = null) => (...args) => {
    logger.warn(
      { operation: `pipeline.${operation}`, args: args.slice(0, 2) },
      `Mock Redis: pipeline.${operation} called`,
    );
    return defaultValue;
  };

  return {
    get: mockOperation("get", null),
    set: mockOperation("set", "OK"),
    del: mockOperation("del", 0),
    hget: mockOperation("hget", null),
    hset: mockOperation("hset", 0),
    hsetnx: mockOperation("hsetnx", 0),
    hdel: mockOperation("hdel", 0),
    hgetall: mockOperation("hgetall", {}),
    hmget: mockOperation("hmget", []),
    hlen: mockOperation("hlen", 0),
    zrange: mockOperation("zrange", []),
    zadd: mockOperation("zadd", 0),
    zrem: mockOperation("zrem", 0),
    zcard: mockOperation("zcard", 0),
    incr: mockOperation("incr", 1),
    expire: mockOperation("expire", 1),
    ttl: mockOperation("ttl", -1),
    exists: mockOperation("exists", 0),
    scan: mockOperation("scan", [0, []]),
    mget: mockOperation("mget", []),
    lrange: mockOperation("lrange", []),
    rpush: mockOperation("rpush", 1),
    lpop: mockOperation("lpop", null),
    pipeline: () => ({
      get: pipelineOperation("get"),
      set: pipelineOperation("set"),
      del: pipelineOperation("del"),
      hget: pipelineOperation("hget"),
      hset: pipelineOperation("hset"),
      hsetnx: pipelineOperation("hsetnx"),
      hdel: pipelineOperation("hdel"),
      hmget: pipelineOperation("hmget"),
      hlen: pipelineOperation("hlen"),
      zadd: pipelineOperation("zadd"),
      zrem: pipelineOperation("zrem"),
      exec: () => Promise.resolve([]),
    }),
  };
}

export const redis = createRedisClient();
export const DISPATCH_HISTORY_KEY = "dispatch:history";
export const MANGA_METADATA_KEY = "manga:metadata";
export const LIVE_EVENTS_KEY = "dashboard:live_events";
export const LIVE_EVENTS_LIMIT = 50;

/**
 * Set hash field with TTL using HPEXPIRE/HEXPIRE (Redis 7.4+)
 * Falls back to no TTL on older Redis versions
 */
export async function hsetWithTTL(redisClient, key, field, value, ttlMs) {
  // Set the field
  await redisClient.hset(key, { [field]: value });

  // Try to set per-field TTL
  try {
    if (typeof redisClient.hpexpire === "function") {
      await redisClient.hpexpire(key, field, ttlMs);
    } else if (typeof redisClient.hexpire === "function") {
      await redisClient.hexpire(
        key,
        Math.ceil(ttlMs / 1000),
        "FIELDS",
        1,
        field,
      );
    }
  } catch {
    // TTL not supported
  }
}

/**
 * Push a live event to the dashboard feed.
 * Events are capped at LIVE_EVENTS_LIMIT.
 * @param {Object} redisClient - Redis instance
 * @param {Object} event - { message: string, type: 'info'|'success'|'warn'|'error' }
 */
export async function appendLiveEvent(redisClient, event = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    message: String(event.message || "Unknown event").trim(),
    type: event.type || "info",
  };

  try {
    const pipeline = redisClient.pipeline();
    pipeline.lpush(LIVE_EVENTS_KEY, JSON.stringify(payload));
    pipeline.ltrim(LIVE_EVENTS_KEY, 0, LIVE_EVENTS_LIMIT - 1);
    pipeline.expire(LIVE_EVENTS_KEY, 3600 * 24); // 24h TTL
    await pipeline.exec();
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to append live event");
    return false;
  }
}

/**
 * Fetch cached manga metadata
 * @param {Object} redisClient
 * @param {string} titleKey
 * @param {number} [maxAgeHours=168] - Max age before treating as stale (default: 7 days). Set to 0 to disable.
 */
export async function getMangaMetadata(redisClient, titleKey, maxAgeHours = 168) {
  try {
    const raw = await redisClient.hget(MANGA_METADATA_KEY, titleKey);
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

    // Staleness check: if older than maxAgeHours, treat as cache miss so it gets re-fetched
    if (maxAgeHours > 0 && parsed?.lastUpdated) {
      const ageHours = (Date.now() - new Date(parsed.lastUpdated).getTime()) / 3600000;
      if (ageHours > maxAgeHours) {
        logger.info({ titleKey, ageHours: Math.round(ageHours) }, "Metadata stale, forcing refresh");
        return null;
      }
    }

    return parsed;
  } catch (err) {
    logger.warn({ err: err.message, titleKey }, "Failed to get manga metadata from Redis");
    return null;
  }
}

/**
 * Cache manga metadata with TTL
 */
export async function setMangaMetadata(redisClient, titleKey, data, ttlSec = 3600 * 24 * 30) {
  try {
    const payload = JSON.stringify({
      ...data,
      lastUpdated: new Date().toISOString(),
    });
    await hsetWithTTL(redisClient, MANGA_METADATA_KEY, titleKey, payload, ttlSec * 1000);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, titleKey }, "Failed to set manga metadata in Redis");
    return false;
  }
}

/**
 * Add HPEXPIRE command to pipeline
 */
export function addHexpireToPipeline(pipeline, key, field, ttlMs, redisClient) {
  if (typeof redisClient.hpexpire === "function") {
    pipeline.hpexpire(key, field, ttlMs);
  } else if (typeof redisClient.hexpire === "function") {
    pipeline.hexpire(key, Math.ceil(ttlMs / 1000), "FIELDS", 1, field);
  }
}

// In-flight request tracking for deduplication with memory protection
const inFlightRequests = new Map();
const MAX_INFLIGHT_REQUESTS = 1000; // Prevent unbounded growth

export async function dedupedRequest(key, fn, ttlMs = 30000) {
  // Cleanup oldest entries if map is too large (LRU-style eviction)
  if (inFlightRequests.size >= MAX_INFLIGHT_REQUESTS) {
    const entriesToDelete = Math.ceil(MAX_INFLIGHT_REQUESTS * 0.2); // Remove 20%
    const keysIterator = inFlightRequests.keys();
    for (let i = 0; i < entriesToDelete; i++) {
      const { value, done } = keysIterator.next();
      if (done) break;
      inFlightRequests.delete(value);
    }
  }

  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }

  const promise = fn().finally(() => {
    setTimeout(() => inFlightRequests.delete(key), ttlMs);
  });

  inFlightRequests.set(key, promise);
  return promise;
}

// Batch Redis operations with pipeline
export async function batchGet(keys) {
  if (!keys || keys.length === 0) return [];
  if (keys.length === 1) return [await redis.get(keys[0])];

  // Fall back to individual operations if pipeline not available (e.g., in tests)
  if (typeof redis.pipeline !== "function") {
    return await Promise.all(keys.map((key) => redis.get(key)));
  }

  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.get(key);
  }
  return await pipeline.exec();
}

export async function batchSet(entries, ttlSeconds = 3600) {
  if (!entries || entries.length === 0) return;
  if (entries.length === 1) {
    await redis.set(entries[0].key, entries[0].value, { ex: ttlSeconds });
    return;
  }

  // Fall back to individual operations if pipeline not available (e.g., in tests)
  if (typeof redis.pipeline !== "function") {
    await Promise.all(
      entries.map(({ key, value }) =>
        redis.set(key, value, { ex: ttlSeconds }),
      ),
    );
    return;
  }

  const pipeline = redis.pipeline();
  for (const { key, value } of entries) {
    pipeline.set(key, value, { ex: ttlSeconds });
  }
  await pipeline.exec();
}

// Incremental scraping timestamp tracking - Optimized with Time-based sharding
// Uses Redis Hash per month to reduce key count and enable unlimited growth
// Hash key: scrape:lastChecks:YYYY-MM, Field: titleKey, Value: timestamp

const LAST_CHECK_HASH_PREFIX = "scrape:lastChecks";
const LAST_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours in ms

/**
 * Get hash key for last scrape checks - sharded by month
 * Format: "scrape:lastChecks:2024-01" for January 2024
 * Note: titleKey parameter kept for API compatibility but not used (always returns current month)
 */
function getLastCheckHashKey(_titleKey = null) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${LAST_CHECK_HASH_PREFIX}:${year}-${month}`;
}

/**
 * Get last scrape check timestamp for a single title
 */
export async function getLastScrapeCheck(titleKey) {
  const hashKey = getLastCheckHashKey(titleKey);
  return await redis.hget(hashKey, titleKey);
}

/**
 * Set last scrape check timestamp for a single title
 * Uses HEXPIRE/HPEXPIRE for per-field TTL on Redis 7.4+
 * Falls back to plain HSET on older versions (cleanup handles expiration)
 */
export async function setLastScrapeCheck(titleKey, timestamp = Date.now()) {
  const hashKey = getLastCheckHashKey(titleKey);
  const ttlSeconds = Math.floor(LAST_CHECK_TTL_MS / 1000);

  // HSET the value
  await redis.hset(hashKey, { [titleKey]: String(timestamp) });

  // Try to set per-field TTL with HEXPIRE (Redis 7.4+) or HPEXPIRE
  try {
    // Try HPEXPIRE first (millisecond precision, Redis 7.4+)
    if (typeof redis.hpexpire === "function") {
      await redis.hpexpire(hashKey, titleKey, LAST_CHECK_TTL_MS);
    }
    // Fallback to HEXPIRE (seconds, Redis 7.4+)
    else if (typeof redis.hexpire === "function") {
      await redis.hexpire(hashKey, ttlSeconds, "FIELDS", 1, titleKey);
    }
  } catch (err) {
    // HEXPIRE/HPEXPIRE not available (Redis < 7.4), log and continue
    // Cleanup will handle expiration via cleanupStaleLastChecks()
    logger.debug({ err: err.message }, "HEXPIRE/HPEXPIRE not available, using cleanup fallback");
  }
}

/**
 * Group keys by hash shard for efficient batch operations
 */
const groupByShard = (keys) => {
  const byShard = new Map();
  keys.forEach((key) => {
    const hashKey = getLastCheckHashKey(key);
    byShard.set(hashKey, [...(byShard.get(hashKey) || []), key]);
  });
  return byShard;
};

/**
 * Flatten pipeline results back to original key order
 */
const flattenResults = (results, shardKeys, originalKeys) => {
  const resultMap = new Map();
  results.forEach((shardResult, i) => {
    shardKeys[i].fields.forEach((field, j) => {
      resultMap.set(field, shardResult?.[j] ?? null);
    });
  });
  return originalKeys.map((key) => resultMap.get(key) ?? null);
};

/**
 * Batch get last scrape check timestamps using pipeline
 * All keys go to current month's hash (time-based sharding)
 */
export async function batchGetLastScrapeChecks(titleKeys) {
  if (!titleKeys?.length) return [];

  const hashKey = getLastCheckHashKey();

  // Fall back to individual operations if pipeline not available
  if (typeof redis.pipeline !== "function") {
    return Promise.all(titleKeys.map((key) => redis.hget(hashKey, key)));
  }

  const pipeline = redis.pipeline();
  pipeline.hmget(hashKey, ...titleKeys);

  const results = await pipeline.exec();
  return results?.[0] || new Array(titleKeys.length).fill(null);
}

/**
 * Build HSET fields object from keys and timestamp
 */
const buildHsetFields = (keys, timestamp) =>
  Object.fromEntries(keys.map((k) => [k, String(timestamp)]));

/**
 * Add HEXPIRE commands to pipeline per field
 */
const addHexpireCommands = (pipeline, hashKey, keys, ttlMs, ttlSeconds) => {
  if (typeof redis.hpexpire === "function") {
    keys.forEach((key) => pipeline.hpexpire(hashKey, key, ttlMs));
  } else if (typeof redis.hexpire === "function") {
    pipeline.hexpire(hashKey, ttlSeconds, "FIELDS", keys.length, ...keys);
  }
};

/**
 * Batch set last scrape check timestamps using pipeline
 * All keys go to current month's hash (time-based sharding)
 * Uses HPEXPIRE/HEXPIRE per field on Redis 7.4+
 */
export async function batchSetLastScrapeChecks(
  titleKeys,
  timestamp = Date.now(),
) {
  if (!titleKeys?.length) return;

  const ts = String(timestamp);
  const ttlSeconds = Math.floor(LAST_CHECK_TTL_MS / 1000);
  const hasTtlSupport =
    typeof redis.hpexpire === "function" || typeof redis.hexpire === "function";

  const hashKey = getLastCheckHashKey();

  // Fall back to individual operations if pipeline not available
  if (typeof redis.pipeline !== "function") {
    await Promise.all(
      titleKeys.map((key) => setLastScrapeCheck(key, ts).catch(() => { })),
    );
    return;
  }

  const pipeline = redis.pipeline();
  pipeline.hset(hashKey, buildHsetFields(titleKeys, ts));

  if (hasTtlSupport) {
    addHexpireCommands(
      pipeline,
      hashKey,
      titleKeys,
      LAST_CHECK_TTL_MS,
      ttlSeconds,
    );
  }

  await pipeline.exec();
}

/**
 * Check if Redis supports per-field TTL (HEXPIRE/HPEXPIRE)
 * Returns true if Redis 7.4+ detected
 */
export function supportsPerFieldTTL() {
  return (
    typeof redis.hexpire === "function" || typeof redis.hpexpire === "function"
  );
}

/**
 * Parse HSCAN result and collect stale entries
 */
const collectStaleEntries = (fieldValues, cutoff) => {
  const stale = [];
  for (let i = 0; i < fieldValues.length; i += 2) {
    const ts = Number(fieldValues[i + 1]);
    if (!Number.isNaN(ts) && ts < cutoff) {
      stale.push(fieldValues[i]);
    }
  }
  return stale;
};

/**
 * Scan single shard for stale entries
 * Uses hgetall instead of hscan (hscan not available in Upstash)
 */
const scanShardForStale = async (redis, hashKey, cutoff) => {
  try {
    const allEntries = await redis.hgetall(hashKey);
    if (!allEntries || typeof allEntries !== "object") {
      return [];
    }

    // Convert object to fieldValues format [key, value, key, value, ...]
    const fieldValues = Object.entries(allEntries).flat();
    return collectStaleEntries(fieldValues, cutoff);
  } catch (err) {
    logger.error({ hashKey, err: err.message }, "[scanShardForStale] Error scanning hash");
    return [];
  }
};

/**
 * Get all month-based hash keys (current and previous months)
 */
function getMonthHashKeys(monthsBack = 3) {
  const keys = [];
  const now = new Date();

  for (let i = 0; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    keys.push(`${LAST_CHECK_HASH_PREFIX}:${year}-${month}`);
  }

  return keys;
}

/**
 * Cleanup old alphabet-based shards (safety check)
 * Deletes any remaining old format keys like scrape:lastChecks:a, scrape:lastChecks:b, etc.
 * This is a safety measure in case old keys somehow reappear
 */
export async function cleanupOldAlphabetShards() {
  const oldShards = "abcdefghijklmnopqrstuvwxyz_".split("");
  let deleted = 0;

  for (const shard of oldShards) {
    const oldKey = `${LAST_CHECK_HASH_PREFIX}:${shard}`;
    try {
      const exists = await redis.exists(oldKey);
      if (exists) {
        await redis.del(oldKey);
        deleted++;
      }
    } catch {
      // Key might not exist, ignore
    }
  }

  if (deleted > 0) {
    logger.info(`[cleanup] Deleted ${deleted} old alphabet-based shards`);
  }

  return deleted;
}

/**
 * Cleanup stale entries from lastCheck hashes
 * Removes entries older than TTL (default 24 hours)
 * Uses HSCAN for memory-efficient iteration
 * Note: Only needed for Redis < 7.4 (no per-field TTL support)
 */
export async function cleanupStaleLastChecks(
  maxAgeMs = LAST_CHECK_TTL_MS,
  nowMs = Date.now(),
) {
  // Safety check: cleanup any old alphabet-based shards first
  await cleanupOldAlphabetShards();

  const cutoff = nowMs - maxAgeMs;
  const hashKeys = getMonthHashKeys(3); // Check last 3 months

  const deletionCounts = await Promise.all(
    hashKeys.map(async (hashKey) => {
      const stale = await scanShardForStale(redis, hashKey, cutoff);

      if (stale.length) {
        await redis.hdel(hashKey, ...stale);
      }
      return stale.length;
    }),
  );

  return deletionCounts.reduce((sum, count) => sum + count, 0);
}

/**
 * Cleanup entire hash keys that have no fields (empty hashes)
 * Useful after HEXPIRE automatically removes all expired fields
 * Also cleanup old month hashes (older than 3 months)
 */
export async function cleanupEmptyLastCheckHashes() {
  const hashKeys = getMonthHashKeys(12); // Check last 12 months
  let deleted = 0;

  for (const hashKey of hashKeys) {
    const count = await redis.hlen(hashKey);

    if (count === 0) {
      // Hash is empty, delete it
      await redis.del(hashKey);
      deleted++;
    }
  }

  return deleted;
}

/**
 * Get stats about lastCheck hashes
 * Returns total entries and per-month breakdown
 */
export async function getLastCheckStats() {
  const stats = { total: 0, months: {} };
  const hashKeys = getMonthHashKeys(12);

  for (const hashKey of hashKeys) {
    const month = hashKey.split(":").pop();
    const count = await redis.hlen(hashKey);
    stats.months[month] = count;
    stats.total += count;
  }

  return stats;
}

/**
 * Migrate from old key-based lastCheck to new hash-based system
 * Scans for keys matching "scrape:lastCheck:*" and migrates them
 * @param {boolean} deleteAfter - Whether to delete old keys after migration
 * @returns {Promise<{migrated: number, failed: number}>}
 */
export async function migrateLastChecksToHash(deleteAfter = false) {
  const results = { migrated: 0, failed: 0, deleted: 0 };
  const pattern = "scrape:lastCheck:*";

  let cursor = 0;
  do {
    // Use SCAN to find matching keys
    const scanResult = await redis.scan(cursor, { match: pattern, count: 100 });
    cursor = scanResult.cursor;

    const keys = scanResult.keys || [];
    if (keys.length === 0) continue;

    // Group by hash shard
    const byShard = new Map();
    const keyValues = await redis.mget(...keys);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = keyValues[i];
      if (!value) continue;

      // Extract titleKey from "scrape:lastCheck:{titleKey}"
      const titleKey = key.slice("scrape:lastCheck:".length);
      if (!titleKey) continue;

      const hashKey = getLastCheckHashKey(titleKey);
      if (!byShard.has(hashKey)) {
        byShard.set(hashKey, {});
      }
      byShard.get(hashKey)[titleKey] = value;
    }

    // Migrate to hashes
    for (const [hashKey, fields] of byShard) {
      try {
        await redis.hset(hashKey, fields);
        results.migrated += Object.keys(fields).length;
      } catch (err) {
        logger.warn(
          { hashKey, error: err.message },
          `[migrateLastChecksToHash] Failed to migrate to ${hashKey}`,
        );
        results.failed += Object.keys(fields).length;
      }
    }

    // Delete old keys if requested
    if (deleteAfter && results.migrated > 0) {
      try {
        await redis.del(...keys);
        results.deleted += keys.length;
      } catch (err) {
        logger.warn(
          { error: err.message },
          "[migrateLastChecksToHash] Failed to delete old keys",
        );
      }
    }
  } while (cursor !== 0);

  return results;
}

const WHITELIST_KEY_LEGACY = "whitelist:manga";
const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_INDEX_KEY = "whitelist:index";
const CHANNEL_HASH_KEY = "channels:guild-map";
const CHANNEL_KEY_PREFIX = "channel:";

export const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];
export const RECENT_CHAPTERS_KEY = "recent:chapters";
export const CRON_LOG_LIST_KEY = "cron:logs";
export const CRON_LAST_RUN_KEY = "cron:last_run";
export const MANGA_LAST_UPDATES_KEY = "manga:last_updates";
export const SOURCES_HEALTH_KEY = "sources:health";
export const NOTIFICATION_QUEUE_KEY = "queue:notifications";
export const MANGA_SUBSCRIBERS_KEY = "manga:subscribers";
export const MANGA_MUTES_KEY = "manga:mutes";
export const MANGA_STALE_WARNED_KEY = "manga:stale_warned";

/**
 * Optimized dashboard data fetching using Redis pipeline.
 * Reduces multiple round-trips to a single batched operation.
 */
export async function fetchDashboardSnapshot() {
  const snapshotLen = await redis.hlen(RECENT_CHAPTERS_KEY).catch(() => 0);
  const pipeline = redis.pipeline();

  pipeline.get(CRON_LAST_RUN_KEY);            // 0: Cron status
  pipeline.hgetall(SOURCES_HEALTH_KEY);         // 1: Source health map
  pipeline.get("health:recommendations");    // 2: Health recommendations
  pipeline.get("health:last-check");         // 3: Last health check time

  // Fetch recent chapters from Hash format
  pipeline.hgetall(RECENT_CHAPTERS_KEY);         // 4: Recent chapters (Hash)

  pipeline.lrange(CRON_LOG_LIST_KEY, 0, 9);    // 5: Recent logs (List)
  pipeline.lrange(LIVE_EVENTS_KEY, 0, 49);    // 6: Live events (List)
  pipeline.llen("queue:notifications");      // 7: Queue length
  pipeline.lrange("queue:notifications", 0, 49); // 8: Queue items

  const results = await pipeline.exec();

  const cronStatus = results[0];
  const sourceHealth = results[1] || {};
  const recommendations = results[2] || [];
  const lastHealthCheck = results[3];

  // Process recent chapters with individual item safety
  const rawChapters = results[4] || {};
  const recentChapters = Object.values(rawChapters)
    .map(v => {
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch (err) {
        console.warn("[Redis] Failed to parse chapter item:", err.message);
        return null; // Skip corrupted items gracefully
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const timeA = new Date(a.sentAt || a.enqueuedAt || 0).getTime();
      const timeB = new Date(b.sentAt || b.enqueuedAt || 0).getTime();
      if (timeA !== timeB) return timeB - timeA; // Primary: Time descending

      const orderA = a.sentOrder ?? 0;
      const orderB = b.sentOrder ?? 0;
      return orderB - orderA; // Secondary: Order within same timestamp
    })
    .slice(0, 20);

  const recentLogs = results[5] || [];
  const liveEvents = (results[6] || [])
    .map((v) => {
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const queueLength = results[7] || 0;
  const rawQueueItems = results[8] || [];
  const queueItems = rawQueueItems
    .map((v) => {
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Optimized: Load full whitelist data in parallel or from cache
  const whitelist = await loadWhitelist();

  return {
    cronStatus,
    sourceHealth,
    recommendations,
    lastHealthCheck,
    recentChapters,
    recentLogs,
    liveEvents,
    whitelist,
    whitelistCount: whitelist.length,
    queueLength,
    queueItems,
    timestamp: new Date().toISOString(),
  };
}
export const CHANNEL_VALIDATION_REFRESH_KEY = "cron:last_channel_validation_at";

/**
 * Parse whitelist data from HMGET result (handles both object and array formats)
 */
const parseWhitelistData = (data) => {
  if (!data) return [];
  const rawItems = Array.isArray(data)
    ? data
    : typeof data === "object"
      ? Object.values(data)
      : [];

  return rawItems
    .filter(Boolean)
    .map((v) => {
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch (err) {
        console.warn("[Redis] Failed to parse whitelist item:", err.message);
        return null;
      }
    })
    .filter(Boolean);
};

/**
 * Log whitelist load result for debugging
 */
const logWhitelistLoad = (indexLen, dataType, isArray, finalLen) => {
  logger.debug(
    { index: indexLen, dataType, isArray, final: finalLen },
    "[loadWhitelist] Whitelist load result",
  );
};

/**
 * Try loading from legacy format and migrate if found
 */
const loadAndMigrateLegacy = async (redis) => {
  const rawLegacy = await redis.get(WHITELIST_KEY_LEGACY);
  if (!rawLegacy) return null;

  const list = normalizeWhitelist(rawLegacy);
  if (list.length) {
    await saveWhitelist(list);
    logger.info(
      { migrated: list.length },
      "[loadWhitelist] Migrated items to new structure",
    );
  }
  return list;
};

export async function loadWhitelist() {
  try {
    const index = await redis.zrange(WHITELIST_INDEX_KEY, 0, -1);
    if (!index?.length) {
      return (await loadAndMigrateLegacy(redis)) || [];
    }

    const data = await redis.hmget(WHITELIST_DATA_KEY, ...index);
    const list = parseWhitelistData(data);

    logWhitelistLoad(
      index.length,
      typeof data,
      Array.isArray(data),
      list.length,
    );
    return list;
  } catch (err) {
    logger.error({ err }, "[loadWhitelist] Redis error");
    return [];
  }
}

export async function loadWhitelistItem(titleKey) {
  try {
    return await redis.hget(WHITELIST_DATA_KEY, titleKey);
  } catch (err) {
    logger.error({ titleKey, err }, "[loadWhitelistItem] Redis error");
    return null;
  }
}

/**
 * Clear all whitelist data (when list is empty)
 */
const clearWhitelistData = async (redis) => {
  try {
    await Promise.all([
      redis.del(WHITELIST_DATA_KEY),
      redis.del(WHITELIST_INDEX_KEY),
      redis.del(WHITELIST_KEY_LEGACY),
    ]);
  } catch (err) {
    logger.error({ err }, "[saveWhitelist] Clear error");
  }
};

/**
 * Build data map and index tasks from normalized items
 */
const buildWhitelistMaps = (normalized) => {
  const dataMap = {};
  const indexEntries = [];

  normalized.forEach((item, i) => {
    const tk = normalizeTitleKey(item.title);
    if (!tk) return;
    dataMap[tk] = item;
    indexEntries.push({ score: i, member: tk });
  });

  return { dataMap, indexEntries };
};

export async function saveWhitelist(list) {
  if (!Array.isArray(list)) throw new Error("list harus berupa array");

  const normalized = normalizeWhitelist(list);
  if (!normalized.length) {
    return clearWhitelistData(redis);
  }

  const { dataMap, indexEntries } = buildWhitelistMaps(normalized);

  try {
    // Use pipeline for atomic operation - prevents race condition
    // where index is deleted but not rebuilt
    const pipeline = redis.pipeline();

    // Set data
    pipeline.hset(WHITELIST_DATA_KEY, dataMap);

    // Rebuild index atomically: delete old, add new
    pipeline.del(WHITELIST_INDEX_KEY);
    for (const entry of indexEntries) {
      pipeline.zadd(WHITELIST_INDEX_KEY, entry);
    }

    // Clear legacy
    pipeline.del(WHITELIST_KEY_LEGACY);

    // Execute all commands atomically
    await pipeline.exec();

    logger.info({ count: normalized.length }, "[saveWhitelist] Saved items");
  } catch (err) {
    logger.error({ err }, "[saveWhitelist] Redis pipeline error");
    // Attempt recovery - check if index needs rebuild
    const indexCount = await redis.zcard(WHITELIST_INDEX_KEY).catch(() => 0);
    if (indexCount === 0) {
      logger.error("[saveWhitelist] Index is empty after failed save! Attempting recovery...");
      // Data is saved but index failed - try to rebuild index
      try {
        const data = await redis.hgetall(WHITELIST_DATA_KEY);
        const keys = Object.keys(data);
        for (let i = 0; i < keys.length; i++) {
          await redis.zadd(WHITELIST_INDEX_KEY, { score: i, member: keys[i] });
        }
        logger.info({ recovered: keys.length }, "[saveWhitelist] Recovered index entries");
      } catch (recoveryErr) {
        logger.error({ err: recoveryErr }, "[saveWhitelist] Recovery failed");
      }
    }
    throw err;
  }
}

export async function getNotificationChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    const val = await getNotificationChannelFromStore(redis, guildId);
    if (val === null) return null;
    return String(val);
  } catch (err) {
    logger.error({ guildId, err }, "[getNotificationChannel] Redis error");
    return null;
  }
}

export async function setNotificationChannel(guildId, channelId) {
  if (!guildId || !channelId) throw new Error("guildId dan channelId required");

  const idStr = String(channelId).trim();
  if (!/^\d+$/.test(idStr)) throw new Error("channelId harus numeric");
  if (idStr.length !== 18 && idStr.length !== 19)
    throw new Error(`Invalid snowflake length: ${idStr.length}`);

  await setNotificationChannelInStore(redis, guildId, idStr);
}

export async function deleteGuildChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    await deleteGuildChannelFromStore(redis, guildId);
  } catch (err) {
    logger.error({ guildId, err }, "[deleteGuildChannel] Redis error");
    throw err;
  }
}

export async function getAllGuildChannels() {
  try {
    return await getAllGuildChannelsFromStore(redis);
  } catch (err) {
    logger.error({ err }, "[getAllGuildChannels] Redis error");
    return {};
  }
}

function normalizeChannelMap(map) {
  if (!map || typeof map !== "object") return {};

  return Object.fromEntries(
    Object.entries(map)
      .map(([guildId, channelId]) => [
        String(guildId),
        channelId === null || channelId === undefined
          ? null
          : String(channelId),
      ])
      .filter(([, channelId]) => Boolean(channelId)),
  );
}

/**
 * Scan for legacy channel keys
 */
const scanLegacyChannelKeys = async (client) => {
  const keys = [];
  let cursor = 0;

  do {
    const [nextCursor, batch] = await client.scan(cursor, {
      match: `${CHANNEL_KEY_PREFIX}*`,
      count: 100,
    });
    keys.push(...batch);
    cursor = Number(nextCursor);
  } while (cursor !== 0);

  return keys;
};

/**
 * Batch get values for channel keys
 */
const batchGetChannelValues = async (client, keys) => {
  const batchSize = 200;
  const batches = Array.from(
    { length: Math.ceil(keys.length / batchSize) },
    (_, i) => keys.slice(i * batchSize, (i + 1) * batchSize),
  );

  const values = (
    await Promise.all(batches.map((b) => client.mget(...b)))
  ).flat();
  return Object.fromEntries(
    keys.map((key, i) => [key.slice(CHANNEL_KEY_PREFIX.length), values[i]]),
  );
};

async function getLegacyGuildChannels(client) {
  const keys = await scanLegacyChannelKeys(client);
  if (!keys.length) return {};

  const map = await batchGetChannelValues(client, keys);
  return normalizeChannelMap(map);
}

async function hydrateChannelHash(client, guildChannels) {
  const normalized = normalizeChannelMap(guildChannels);
  const entries = Object.entries(normalized);
  if (!entries.length) return {};

  await client.hset(CHANNEL_HASH_KEY, normalized);
  return Object.fromEntries(entries);
}

export async function getNotificationChannelFromStore(client, guildId) {
  const field = String(guildId);
  const hashed = await client.hget(CHANNEL_HASH_KEY, field);
  if (hashed !== null && hashed !== undefined) return String(hashed);

  const legacy = await client.get(`${CHANNEL_KEY_PREFIX}${field}`);
  if (legacy === null || legacy === undefined) return null;

  const value = String(legacy);
  await client.hset(CHANNEL_HASH_KEY, { [field]: value }).catch((err) => {
    logger.error(
      { guildId: field, error: err.message },
      "[redis] Failed to migrate channel",
    );
  });
  return value;
}

export async function setNotificationChannelInStore(
  client,
  guildId,
  channelId,
) {
  const field = String(guildId);
  const value = String(channelId);
  await client.hset(CHANNEL_HASH_KEY, { [field]: value });
  await client.del(`${CHANNEL_KEY_PREFIX}${field}`).catch((err) => {
    logger.error(
      { guildId: field, error: err.message },
      "[redis] Failed to delete legacy channel",
    );
  });
}

export async function deleteGuildChannelFromStore(client, guildId) {
  const field = String(guildId);
  await Promise.all([
    client.hdel(CHANNEL_HASH_KEY, field).catch(() => 0),
    client.del(`${CHANNEL_KEY_PREFIX}${field}`),
  ]);
}

export async function getAllGuildChannelsFromStore(client) {
  const hashed = normalizeChannelMap(await client.hgetall(CHANNEL_HASH_KEY));
  if (Object.keys(hashed).length > 0) return hashed;

  const legacy = await getLegacyGuildChannels(client);
  if (Object.keys(legacy).length === 0) return {};

  await hydrateChannelHash(client, legacy).catch((err) => {
    logger.error({ error: err.message }, "[redis] Failed to hydrate channel hash");
  });
  return legacy;
}

export async function readObjectCache(client, key) {
  try {
    const cached = await client.get(key);
    if (!cached) return null;
    // Handle both string (JSON) and object (auto-parsed) formats
    if (typeof cached === "string") {
      return JSON.parse(cached);
    }
    if (typeof cached === "object") {
      return cached;
    }
    return null;
  } catch (err) {
    logger.error({ key, error: err.message }, "[redis] Failed to read cache");
    return null;
  }
}

export async function writeObjectCache(client, key, payload, cacheTtl) {
  try {
    const serialized = JSON.stringify(payload);
    await client.set(key, serialized, { ex: cacheTtl });
  } catch (err) {
    logger.error({ key, error: err.message }, "[redis] Failed to write cache");
  }
}


export async function readRecentChapters(client, start = 0, stop = 49) {
  // Read from hash instead of list
  const data = await client.hgetall(RECENT_CHAPTERS_KEY);
  if (!data) return [];
  const entries = Object.values(data)
    .map((v) => {
      if (typeof v === "object" && v !== null) return v;
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      }
      return null;
    })
    .filter(Boolean);

  // Sort by sentOrder or sentAt
  entries.sort((a, b) => {
    const orderA = a.sentOrder ?? 0;
    const orderB = b.sentOrder ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return new Date(a.sentAt || 0) - new Date(b.sentAt || 0);
  });

  return entries.slice(start, stop + 1);
}

export async function readCronLogs(client, start = 0, stop = 49) {
  const logs = await client.lrange(CRON_LOG_LIST_KEY, start, stop);
  if (!logs || !Array.isArray(logs)) return [];
  return logs
    .map((log) => {
      if (typeof log === "string") {
        try {
          return JSON.parse(log);
        } catch {
          return null;
        }
      }
      return log;
    })
    .filter(Boolean);
}

export async function readCronStatus(client) {
  const raw = await client.get(CRON_LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function writeCronStatus(client, statusPayload) {
  const serialized = JSON.stringify(statusPayload);
  await client.set(CRON_LAST_RUN_KEY, serialized);
}

export async function loadSourceHealthSnapshot(
  client,
  sourceKeys = SOURCE_KEYS,
) {
  const rawMap = (await client.hgetall(SOURCES_HEALTH_KEY)) || {};
  const entries = sourceKeys.map((source) => {
    const raw = rawMap?.[source];
    if (!raw) return [source, null];
    if (typeof raw === "object") return [source, raw];
    try {
      return [source, JSON.parse(raw)];
    } catch {
      return [source, null];
    }
  });
  return Object.fromEntries(entries);
}

export async function readChannelValidationState(client) {
  return client.get(CHANNEL_VALIDATION_REFRESH_KEY).catch(() => null);
}

export async function writeChannelValidationState(client, payload) {
  await client.set(CHANNEL_VALIDATION_REFRESH_KEY, payload).catch((err) => {
    logger.error(
      { error: err.message },
      "[redis] Failed to write channel validation state",
    );
  });
}

/**
 * Consolidated pipeline execution helper
 */
export async function execPipeline(redisClient, buildOperations) {
  const pipeline = redisClient.pipeline();
  buildOperations(pipeline);
  return pipeline.exec();
}

/**
 * Batch claim chapters using Redis pipeline for efficiency
 */
export async function batchClaimPendingChapters(
  redisClient,
  items,
  pendingClaimTtl,
  pendingStaleMs,
) {
  if (!items?.length) return [];

  // Try to claim all atomically with hsetnx
  const hsetnxResults = await execPipeline(redisClient, (pipeline) => {
    for (const { key, nowIso } of items) {
      const payload = {
        status: "pending",
        claimedAt: nowIso,
        expiresAt: Date.now() + pendingClaimTtl * 1000,
      };
      pipeline.hsetnx(
        DISPATCH_HISTORY_KEY,
        key,
        JSON.stringify(payload),
      );
    }
  });

  // Set TTL for newly claimed fields
  const newlyClaimed = hsetnxResults
    .map((result, index) =>
      result === 1 || result === true ? items[index].key : null,
    )
    .filter(Boolean);

  if (newlyClaimed.length) {
    await execPipeline(redisClient, (pipeline) => {
      for (const key of newlyClaimed) {
        addHexpireToPipeline(
          pipeline,
          DISPATCH_HISTORY_KEY,
          key,
          pendingClaimTtl * 1000,
          redisClient,
        );
      }
    });
  }

  return hsetnxResults.map((r) => r === 1 || r === true);
}

/**
 * Flush write tasks in batches
 */
export async function flushWriteTasks(
  writeTasks = [],
  writeTaskBatch = 10,
) {
  for (let i = 0; i < writeTasks.length; i += writeTaskBatch) {
    await Promise.all(writeTasks.slice(i, i + writeTaskBatch));
  }
}
