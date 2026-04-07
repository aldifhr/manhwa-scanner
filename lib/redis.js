import "dotenv/config";
import { Redis } from "@upstash/redis";
import { normalizeTitleKey, normalizeWhitelist } from "./domain.js";
import { STATUS_API_CACHE_KEY } from "./cacheKeys.js";
import {
  SOURCES_HEALTH_KEY,
  SOURCE_KEYS,
  sourceHealthKey,
} from "./services/health.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "redis" });

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  enableAutoPipelining: true,
});

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
 * Get hash key based on current month (time-based sharding)
 * Format: "scrape:lastChecks:2024-01" for January 2024
 */
function getLastCheckHashKey(titleKey) {
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
  } catch {
    // HEXPIRE/HPEXPIRE not available (Redis < 7.4), ignore
    // Cleanup will handle expiration via cleanupStaleLastChecks()
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
      titleKeys.map((key) => setLastScrapeCheck(key, ts).catch(() => {})),
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
 */
const scanShardForStale = async (redis, hashKey, cutoff) => {
  const stale = [];
  let cursor = 0;

  do {
    const { cursor: nextCursor, fieldValues } = await redis.hscan(
      hashKey,
      cursor,
      {
        count: 100,
      },
    );
    cursor = nextCursor;
    stale.push(...collectStaleEntries(fieldValues, cutoff));
  } while (cursor !== 0);

  return stale;
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

export const RECENT_CHAPTERS_KEY = "recent:chapters";
export const CRON_LOG_LIST_KEY = "cron:logs";
export const CRON_LAST_RUN_KEY = "cron:last_run";
export const CHANNEL_VALIDATION_REFRESH_KEY = "cron:last_channel_validation_at";
export const STATUS_CACHE_TTL_SEC = Number(process.env.STATUS_CACHE_SEC || 60);

export const STATUS_EMPTY_CACHE_VALUE = "__STATUS_NULL__";

export function hasStatusCacheValue(value) {
  return value !== null && value !== undefined;
}

export function decodeStatusCacheValue(value) {
  if (value === STATUS_EMPTY_CACHE_VALUE) return null;
  return value;
}

export function encodeStatusCacheValue(value) {
  return value === null ? STATUS_EMPTY_CACHE_VALUE : value;
}

/**
 * Parse whitelist data from HMGET result (handles both object and array formats)
 */
const parseWhitelistData = (data) => {
  if (!data) return [];
  if (typeof data === "object" && !Array.isArray(data)) {
    return Object.values(data).filter(Boolean);
  }
  if (Array.isArray(data)) {
    return data.filter(Boolean);
  }
  return [];
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

export async function readStatusCache(client) {
  const rawCached = await client.get(STATUS_API_CACHE_KEY);
  if (!hasStatusCacheValue(rawCached)) {
    return { hit: false, value: null };
  }
  return {
    hit: true,
    value: decodeStatusCacheValue(rawCached),
  };
}

export async function writeStatusCache(client, payload, cacheTtl) {
  await client
    .set(STATUS_API_CACHE_KEY, encodeStatusCacheValue(payload), {
      ex: cacheTtl,
    })
    .catch(() => {});
}

export async function readRecentChapters(client, start = 0, stop = 49) {
  // Read from hash instead of list
  const data = await client.hgetall(RECENT_CHAPTERS_KEY);
  if (!data) return [];
  const entries = Object.values(data)
    .map((v) => {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
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
  await writeStatusCache(client, serialized, STATUS_CACHE_TTL_SEC);
}

export async function loadSourceHealthSnapshot(
  client,
  sourceKeys = SOURCE_KEYS,
) {
  const entries = await Promise.all(
    sourceKeys.map(async (source) => {
      const raw = await client.get(sourceHealthKey(source));
      return [source, raw ?? null];
    }),
  );
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
