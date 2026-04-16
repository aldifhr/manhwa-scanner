import "dotenv/config";
import { Redis } from "@upstash/redis";
import { normalizeTitleKey, normalizeWhitelist } from "./domain.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "redis" });

// Create Redis client
function createRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Redis configuration missing: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set");
  }

  return new Redis({
    url,
    token,
    enableAutoPipelining: true,
  });
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
  } catch (err) {
    logger.debug({ err: err.message }, "HEXPIRE/HPEXPIRE not available");
  }
}

/**
 * Push a live event to the dashboard feed.
 * Events are capped at LIVE_EVENTS_LIMIT.
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
 */
export async function getMangaMetadata(redisClient, titleKey, maxAgeHours = 168) {
  try {
    const raw = await redisClient.hget(MANGA_METADATA_KEY, titleKey);
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

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
const MAX_INFLIGHT_REQUESTS = 1000;

export async function dedupedRequest(key, fn, ttlMs = 30000) {
  if (inFlightRequests.size >= MAX_INFLIGHT_REQUESTS) {
    const entriesToDelete = Math.ceil(MAX_INFLIGHT_REQUESTS * 0.2);
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
export async function batchGet(keys, client = redis) {
  if (!keys || keys.length === 0) return [];
  if (keys.length === 1) return [await client.get(keys[0])];

  const pipeline = client.pipeline();
  for (const key of keys) {
    pipeline.get(key);
  }
  return await pipeline.exec();
}

export async function batchSet(entries, ttlSeconds = 3600, client = redis) {
  if (!entries || entries.length === 0) return;
  if (entries.length === 1) {
    await client.set(entries[0].key, entries[0].value, { ex: ttlSeconds });
    return;
  }

  const pipeline = client.pipeline();
  for (const { key, value } of entries) {
    pipeline.set(key, value, { ex: ttlSeconds });
  }
  await pipeline.exec();
}

// Incremental scraping timestamp tracking
const LAST_CHECK_HASH_PREFIX = "scrape:lastChecks";
const LAST_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

function getLastCheckHashKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${LAST_CHECK_HASH_PREFIX}:${year}-${month}`;
}

export async function getLastScrapeCheck(titleKey, client = redis) {
  const hashKey = getLastCheckHashKey();
  return await client.hget(hashKey, titleKey);
}

export async function setLastScrapeCheck(titleKey, timestamp = Date.now(), client = redis) {
  const hashKey = getLastCheckHashKey();
  const ttlSeconds = Math.floor(LAST_CHECK_TTL_MS / 1000);

  await client.hset(hashKey, { [titleKey]: String(timestamp) });

  try {
    if (typeof client.hpexpire === "function") {
      await client.hpexpire(hashKey, titleKey, LAST_CHECK_TTL_MS);
    } else if (typeof client.hexpire === "function") {
      await client.hexpire(hashKey, ttlSeconds, "FIELDS", 1, titleKey);
    }
  } catch (err) {
    logger.debug({ err: err.message }, "HEXPIRE/HPEXPIRE not available");
  }
}

export async function batchGetLastScrapeChecks(titleKeys, client = redis) {
  if (!titleKeys?.length) return [];
  const hashKey = getLastCheckHashKey();
  const pipeline = client.pipeline();
  pipeline.hmget(hashKey, ...titleKeys);
  const results = await pipeline.exec();
  return results?.[0] || new Array(titleKeys.length).fill(null);
}

export async function batchSetLastScrapeChecks(titleKeys, timestamp = Date.now(), client = redis) {
  if (!titleKeys?.length) return;
  const ts = String(timestamp);
  const ttlSeconds = Math.floor(LAST_CHECK_TTL_MS / 1000);
  const hashKey = getLastCheckHashKey();

  const pipeline = client.pipeline();
  pipeline.hset(hashKey, Object.fromEntries(titleKeys.map((k) => [k, ts])));

  if (typeof client.hpexpire === "function") {
    titleKeys.forEach((key) => pipeline.hpexpire(hashKey, key, LAST_CHECK_TTL_MS));
  } else if (typeof client.hexpire === "function") {
    pipeline.hexpire(hashKey, ttlSeconds, "FIELDS", titleKeys.length, ...titleKeys);
  }

  await pipeline.exec();
}

/**
 * Cleanup stale entries from lastCheck hashes
 */
export async function cleanupStaleLastChecks(maxAgeMs = LAST_CHECK_TTL_MS, nowMs = Date.now(), client = redis) {
  const cutoff = nowMs - maxAgeMs;
  const hashKeys = getMonthHashKeys(3);

  const deletionCounts = await Promise.all(
    hashKeys.map(async (hashKey) => {
      const allEntries = await client.hgetall(hashKey);
      if (!allEntries || typeof allEntries !== "object") return 0;

      const stale = Object.entries(allEntries)
        .filter(([, ts]) => Number(ts) < cutoff)
        .map(([key]) => key);

      if (stale.length) {
        await client.hdel(hashKey, ...stale);
      }
      return stale.length;
    }),
  );

  return deletionCounts.reduce((sum, count) => sum + count, 0);
}

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

export async function getLastCheckStats(client = redis) {
  const stats = { total: 0, months: {} };
  const hashKeys = getMonthHashKeys(12);
  for (const hashKey of hashKeys) {
    const month = hashKey.split(":").pop();
    const count = await client.hlen(hashKey);
    stats.months[month] = count;
    stats.total += count;
  }
  return stats;
}

const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_INDEX_KEY = "whitelist:index";
const CHANNEL_HASH_KEY = "channels:guild-map";

export const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];
export const RECENT_CHAPTERS_KEY = "recent:chapters";
export const CRON_LOG_LIST_KEY = "cron:logs";
export const CRON_LAST_RUN_KEY = "cron:last_run";
export const CHANNEL_VALIDATION_REFRESH_KEY = "channels:last-validation";
export const MANGA_LAST_UPDATES_KEY = "manga:last_updates";
export const SOURCES_HEALTH_KEY = "sources:health";
export const NOTIFICATION_QUEUE_KEY = "queue:notifications";
export const MANGA_SUBSCRIBERS_KEY = "manga:subscribers";
export const MANGA_MUTES_KEY = "manga:mutes";
export const MANGA_STALE_WARNED_KEY = "manga:stale_warned";

export async function fetchDashboardSnapshot(client = redis) {
  const pipeline = client.pipeline();
  pipeline.get(CRON_LAST_RUN_KEY);
  pipeline.hgetall(SOURCES_HEALTH_KEY);
  pipeline.get("health:recommendations");
  pipeline.get("health:last-check");
  pipeline.hgetall(RECENT_CHAPTERS_KEY);
  pipeline.lrange(CRON_LOG_LIST_KEY, 0, 9);
  pipeline.lrange(LIVE_EVENTS_KEY, 0, 49);
  pipeline.llen(NOTIFICATION_QUEUE_KEY);
  pipeline.lrange(NOTIFICATION_QUEUE_KEY, 0, 49);

  const results = await pipeline.exec();

  const cronStatus = results[0];
  const sourceHealth = results[1] || {};
  const recommendations = results[2] || [];
  const lastHealthCheck = results[3];
  const rawChapters = results[4] || {};
  const recentLogs = results[5] || [];
  const liveEvents = (results[6] || [])
    .map((v) => {
      try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
    }).filter(Boolean);
  const queueLength = results[7] || 0;
  const queueItems = (results[8] || [])
    .map((v) => {
      try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
    }).filter(Boolean);

  const recentChapters = Object.values(rawChapters)
    .map(v => {
      try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const timeA = new Date(a.sentAt || a.enqueuedAt || 0).getTime();
      const timeB = new Date(b.sentAt || b.enqueuedAt || 0).getTime();
      if (timeA !== timeB) return timeB - timeA;
      return (b.sentOrder ?? 0) - (a.sentOrder ?? 0);
    })
    .slice(0, 20);

  const whitelist = await loadWhitelist(client);

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

export async function loadWhitelist(client = redis) {
  try {
    const index = await client.zrange(WHITELIST_INDEX_KEY, 0, -1);
    if (!index?.length) return [];
    const data = await client.hmget(WHITELIST_DATA_KEY, ...index);
    return (data || [])
      .filter(Boolean)
      .map((v) => {
        try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
      }).filter(Boolean);
  } catch (err) {
    logger.error({ err }, "[loadWhitelist] Redis error");
    return [];
  }
}

export async function saveWhitelist(list, client = redis) {
  if (!Array.isArray(list)) throw new Error("list harus berupa array");
  const normalized = normalizeWhitelist(list);

  if (!normalized.length) {
    await Promise.all([client.del(WHITELIST_DATA_KEY), client.del(WHITELIST_INDEX_KEY)]);
    return;
  }

  const dataMap = {};
  const indexEntries = [];
  normalized.forEach((item, i) => {
    const tk = normalizeTitleKey(item.title);
    if (!tk) return;
    dataMap[tk] = JSON.stringify(item);
    indexEntries.push({ score: i, member: tk });
  });

  const pipeline = client.pipeline();
  pipeline.hset(WHITELIST_DATA_KEY, dataMap);
  pipeline.del(WHITELIST_INDEX_KEY);
  for (const entry of indexEntries) {
    pipeline.zadd(WHITELIST_INDEX_KEY, entry);
  }
  await pipeline.exec();
}

export async function getNotificationChannel(guildId, client = redis) {
  const hashed = await client.hget(CHANNEL_HASH_KEY, String(guildId));
  return hashed !== null && hashed !== undefined ? String(hashed) : null;
}

export async function setNotificationChannel(guildId, channelId, client = redis) {
  await client.hset(CHANNEL_HASH_KEY, { [String(guildId)]: String(channelId) });
}

export async function deleteGuildChannel(guildId, client = redis) {
  await client.hdel(CHANNEL_HASH_KEY, String(guildId));
}

export async function getAllGuildChannels(client = redis) {
  const raw = await client.hgetall(CHANNEL_HASH_KEY);
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw)
      .map(([k, v]) => [k, v === null ? null : String(v)])
      .filter(([, v]) => Boolean(v)),
  );
}

export async function readObjectCache(client, key) {
  const cached = await client.get(key);
  if (!cached) return null;
  return typeof cached === "string" ? JSON.parse(cached) : cached;
}

export async function writeObjectCache(client, key, payload, cacheTtl) {
  await client.set(key, JSON.stringify(payload), { ex: cacheTtl });
}

export async function readCronStatus(client) {
  const raw = await client.get(CRON_LAST_RUN_KEY);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function writeCronStatus(client, statusPayload) {
  await client.set(CRON_LAST_RUN_KEY, JSON.stringify(statusPayload));
}

export async function readChannelValidationState(client = redis) {
  const raw = await client.get(CHANNEL_VALIDATION_REFRESH_KEY);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function writeChannelValidationState(client = redis, state) {
  await client.set(CHANNEL_VALIDATION_REFRESH_KEY, JSON.stringify(state));
}

export async function loadSourceHealthSnapshot(client, sourceKeys = SOURCE_KEYS) {
  const rawMap = (await client.hgetall(SOURCES_HEALTH_KEY)) || {};
  const entries = sourceKeys.map((source) => {
    const raw = rawMap?.[source];
    if (!raw) return [source, null];
    try { return [source, typeof raw === "string" ? JSON.parse(raw) : raw]; } catch { return [source, null]; }
  });
  return Object.fromEntries(entries);
}

export async function execPipeline(redisClient, buildOperations) {
  const pipeline = redisClient.pipeline();
  buildOperations(pipeline);
  return pipeline.exec();
}

export async function batchClaimPendingChapters(
  redisClient,
  items,
  pendingClaimTtl,
  pendingStaleMs,
  nowMs = Date.now(),
) {
  if (!items?.length) return [];

  // 1. Fetch current status of all items
  const keys = items.map((i) => i.key);
  const rawValues = await redisClient.hmget(DISPATCH_HISTORY_KEY, ...keys);

  const claimIndices = [];
  const results = new Array(items.length).fill(false);

  for (let i = 0; i < items.length; i++) {
    const raw = rawValues[i];
    let claimable = false;

    if (!raw) {
      claimable = true;
    } else {
      try {
        const claim = typeof raw === "string" ? JSON.parse(raw) : raw;
        const claimedAtMs = claim?.claimedAt ? new Date(claim.claimedAt).getTime() : 0;
        // If it's pending and stale, we can reclaim it
        if (claim?.status === "pending" && nowMs - claimedAtMs >= pendingStaleMs) {
          claimable = true;
        }
      } catch {
        // Corrupt data, allow reclaim
        claimable = true;
      }
    }

    if (claimable) {
      claimIndices.push(i);
    }
  }

  if (claimIndices.length > 0) {
    const claimPipeline = redisClient.pipeline();
    const expiryMs = pendingClaimTtl * 1000;

    for (const idx of claimIndices) {
      const { key, nowIso } = items[idx];
      const payload = {
        status: "pending",
        claimedAt: nowIso,
        expiresAt: nowMs + expiryMs,
      };
      claimPipeline.hset(DISPATCH_HISTORY_KEY, { [key]: JSON.stringify(payload) });
      if (typeof redisClient.hpexpire === "function") {
        claimPipeline.hpexpire(DISPATCH_HISTORY_KEY, key, expiryMs);
      }
    }

    const claimResults = await claimPipeline.exec();
    // Map pipeline results back to the original items array
    claimIndices.forEach((idx, i) => {
      // With Upstash hset returns number of fields updated. 0 is fine if we are overwriting.
      results[idx] = true;
    });
  }

  return results;
}

/**
 * Fetch recent chapters list from Redis
 */
export async function readRecentChapters(client = redis, limit = 50) {
  const raw = await client.lrange(CHAPTER_RECENT_KEY, 0, limit - 1);
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? JSON.parse(item) : item))
    .filter(Boolean);
}

/**
 * Fetch cron logs from Redis (for legacy tests)
 */
export async function readCronLogs(client = redis, limit = 50) {
  return await client.lrange(CRON_LOG_LIST_KEY, 0, limit - 1);
}

/**
 * Execute a batch of tasks (Promises or thunks) in chunks to avoid blocking.
 */
export async function flushWriteTasks(tasks, batchSize = 24) {
  if (!tasks?.length) return;

  for (let i = 0; i < tasks.length; i += batchSize) {
    const chunk = tasks.slice(i, i + batchSize);
    await Promise.all(
      chunk.map((task) => (typeof task === "function" ? task() : task)),
    );
  }
}
