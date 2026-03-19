import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
  STATUS_API_CACHE_KEY,
  invalidateDashboardCaches,
} from "./cacheKeys.js";
import {
  decodeStatusCacheValue,
  encodeStatusCacheValue,
  hasStatusCacheValue,
} from "./statusCache.js";
import {
  SOURCE_KEYS,
  sanitizeSourceHealth,
  sourceHealthKey,
} from "./services/sourceHealth.js";

export const RECENT_CHAPTERS_KEY = "recent:chapters";
export const CRON_LOG_LIST_KEY = "cron:logs";
export const CRON_LAST_RUN_KEY = "cron:last_run";
export const CHANNEL_VALIDATION_REFRESH_KEY = "cron:last_channel_validation_at";

export async function readObjectCache(redis, key) {
  const cached = await redis.get(key);
  return cached && typeof cached === "object" ? cached : null;
}

export async function writeObjectCache(redis, key, payload, cacheTtl) {
  await redis.set(key, payload, { ex: cacheTtl }).catch(() => {});
}

export async function readStatusCache(redis) {
  const rawCached = await redis.get(STATUS_API_CACHE_KEY);
  if (!hasStatusCacheValue(rawCached)) {
    return { hit: false, value: null };
  }
  return {
    hit: true,
    value: decodeStatusCacheValue(rawCached),
  };
}

export async function writeStatusCache(redis, payload, cacheTtl) {
  await redis
    .set(STATUS_API_CACHE_KEY, encodeStatusCacheValue(payload), { ex: cacheTtl })
    .catch(() => {});
}

export async function readRecentChapters(redis, start = 0, stop = 49) {
  return redis.lrange(RECENT_CHAPTERS_KEY, start, stop);
}

export async function readCronLogs(redis, start = 0, stop = 49) {
  return redis.lrange(CRON_LOG_LIST_KEY, start, stop);
}

export async function readCronStatus(redis) {
  return redis.get(CRON_LAST_RUN_KEY);
}

export async function writeCronStatus(redis, statusPayload) {
  await redis.set(CRON_LAST_RUN_KEY, statusPayload);
  await invalidateDashboardCaches(redis, [STATUS_API_CACHE_KEY]);
}

export async function loadSourceHealthSnapshot(redis, sourceKeys = SOURCE_KEYS) {
  const entries = await Promise.all(
    sourceKeys.map(async (source) => {
      const raw = await redis.get(sourceHealthKey(source));
      return [source, sanitizeSourceHealth(source, raw)];
    }),
  );
  return Object.fromEntries(entries);
}

export async function readChannelValidationState(redis) {
  return redis.get(CHANNEL_VALIDATION_REFRESH_KEY).catch(() => null);
}

export async function writeChannelValidationState(redis, payload) {
  await redis.set(CHANNEL_VALIDATION_REFRESH_KEY, payload).catch(() => {});
}
