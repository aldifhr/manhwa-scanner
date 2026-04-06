import { httpGet } from "../httpClient.js";
import pLimit from "p-limit";

export const CHANNEL_VALIDATION_CACHE_SEC = Number(
  process.env.CHANNEL_VALIDATION_CACHE_SEC || 60 * 60 * 6,
);

export const CHANNELS_VALIDATION_KEY = "channels:validation";
export const CHANNEL_VALIDATION_CONCURRENCY = 5;

async function _runAsyncCleanup(redis) {
  try {
    const data = await redis.hgetall(CHANNELS_VALIDATION_KEY);
    if (!data) return;
    const now = Date.now();
    const toDelete = Object.entries(data)
      .filter(([_key, val]) => {
        try {
          const parsed = JSON.parse(val);
          return parsed.expiresAt < now;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);
    if (toDelete.length > 0) {
      await redis.hdel(CHANNELS_VALIDATION_KEY, ...toDelete);
    }
  } catch {
    /* ignore */
  }
}

export async function fetchDiscordChannel({ channelId, botToken } = {}) {
  if (!channelId) return null;

  const resp = await httpGet(
    `https://discord.com/api/v10/channels/${channelId}`,
    {
      headers: { Authorization: `Bot ${botToken}` },
      timeout: 10000,
    },
    { retries: 2 },
  );

  return resp.data ?? null;
}

export async function getCachedChannelValidity(redis, channelId) {
  if (!redis || !channelId) return null;
  try {
    const cachedStr = await redis.hget(CHANNELS_VALIDATION_KEY, channelId);
    if (cachedStr) {
      const parsed =
        typeof cachedStr === "string" ? JSON.parse(cachedStr) : cachedStr;
      if (parsed && parsed.expiresAt > Date.now()) {
        return parsed.valid;
      }
    }
  } catch {
    // ignore cache read errors
  }
  return null;
}

export async function validateDiscordChannel({
  redis = null,
  channelId,
  botToken,
  cacheSec = CHANNEL_VALIDATION_CACHE_SEC,
  writeCache = true,
  onValid = null,
  onInvalid = null,
} = {}) {
  if (!channelId) return false;

  const cached = await getCachedChannelValidity(redis, channelId);
  if (cached !== null) return cached;

  try {
    const channel = await fetchDiscordChannel({ channelId, botToken });

    if (writeCache && redis) {
      await redis
        .hset(CHANNELS_VALIDATION_KEY, {
          [channelId]: JSON.stringify({
            valid: true,
            expiresAt: Date.now() + cacheSec * 1000,
          }),
        })
        .catch(() => {});
      _runAsyncCleanup(redis);
    }
    if (typeof onValid === "function") {
      await Promise.resolve(onValid(channel));
    }
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if ((status === 403 || status === 404) && writeCache && redis) {
      await redis
        .hset(CHANNELS_VALIDATION_KEY, {
          [channelId]: JSON.stringify({
            valid: false,
            expiresAt: Date.now() + cacheSec * 1000,
          }),
        })
        .catch(() => {});
      _runAsyncCleanup(redis);
    }
    if (typeof onInvalid === "function") {
      await Promise.resolve(onInvalid(err));
    }
    return false;
  }
}

/**
 * Fetch multiple Discord channels in parallel with concurrency control
 * @param {Array<string>} channelIds - Channel IDs to fetch
 * @param {string} botToken - Discord bot token
 * @param {number} concurrency - Max concurrent requests (default: 5)
 * @returns {Promise<Map<string, Object>>} - Map of channelId to channel data or null
 */
export async function fetchDiscordChannelsBatch(
  channelIds,
  botToken,
  concurrency = CHANNEL_VALIDATION_CONCURRENCY,
) {
  if (!channelIds || channelIds.length === 0) return new Map();

  const limit = pLimit(concurrency);
  const results = new Map();

  const fetchTasks = channelIds.map((channelId) =>
    limit(async () => {
      try {
        const channel = await fetchDiscordChannel({ channelId, botToken });
        return { channelId, channel, valid: true };
      } catch (err) {
        const status = err?.response?.status;
        return {
          channelId,
          channel: null,
          valid: !(status === 403 || status === 404),
          error: err,
        };
      }
    }),
  );

  const settled = await Promise.allSettled(fetchTasks);

  for (let i = 0; i < channelIds.length; i++) {
    const result = settled[i];
    const channelId = channelIds[i];

    if (result.status === "fulfilled") {
      results.set(channelId, result.value);
    } else {
      results.set(channelId, { channel: null, valid: false });
    }
  }

  return results;
}

/**
 * Batch check cached validity for multiple channels
 * @param {Object} redis - Redis client
 * @param {Array<string>} channelIds - Channel IDs to check
 * @returns {Promise<Map<string, boolean|null>>} - Map of channelId to validity (null if not cached)
 */
export async function getCachedChannelsValidityBatch(redis, channelIds) {
  if (!redis || !channelIds || channelIds.length === 0) return new Map();

  const results = new Map();
  const now = Date.now();

  try {
    // Use hmget for batch retrieval
    const cachedData = await redis.hmget(
      CHANNELS_VALIDATION_KEY,
      ...channelIds,
    );

    for (let i = 0; i < channelIds.length; i++) {
      const channelId = channelIds[i];
      const cachedStr = cachedData[i];

      if (cachedStr) {
        try {
          const parsed =
            typeof cachedStr === "string" ? JSON.parse(cachedStr) : cachedStr;
          if (parsed && parsed.expiresAt > now) {
            results.set(channelId, parsed.valid);
          } else {
            results.set(channelId, null); // Expired
          }
        } catch {
          results.set(channelId, null);
        }
      } else {
        results.set(channelId, null); // Not cached
      }
    }
  } catch {
    // On error, return all as null (not cached)
    for (const channelId of channelIds) {
      results.set(channelId, null);
    }
  }

  return results;
}

/**
 * Validate multiple Discord channels in batch with concurrency control
 * @param {Object} options - Options
 * @param {Object} options.redis - Redis client
 * @param {Array<string>} options.channelIds - Channel IDs to validate
 * @param {string} options.botToken - Discord bot token
 * @param {number} options.cacheSec - Cache TTL in seconds
 * @param {number} options.concurrency - Max concurrent validations
 * @returns {Promise<Map<string, boolean>>} - Map of channelId to validity
 */
export async function validateDiscordChannelsBatch({
  redis = null,
  channelIds = [],
  botToken,
  cacheSec = CHANNEL_VALIDATION_CACHE_SEC,
  concurrency = CHANNEL_VALIDATION_CONCURRENCY,
} = {}) {
  if (!channelIds || channelIds.length === 0) return new Map();

  const results = new Map();
  const now = Date.now();

  // Check cache first for all channels
  const cachedResults = await getCachedChannelsValidityBatch(redis, channelIds);
  const channelsToFetch = [];

  for (const [channelId, valid] of cachedResults) {
    if (valid !== null) {
      results.set(channelId, valid);
    } else {
      channelsToFetch.push(channelId);
    }
  }

  if (channelsToFetch.length === 0) {
    return results;
  }

  // Fetch uncached channels in parallel with concurrency control
  const fetchedResults = await fetchDiscordChannelsBatch(
    channelsToFetch,
    botToken,
    concurrency,
  );

  // Update cache and build final results
  const cacheUpdates = [];

  for (const [channelId, data] of fetchedResults) {
    const isValid = data.valid;
    results.set(channelId, isValid);

    if (redis) {
      cacheUpdates.push({
        channelId,
        data: JSON.stringify({
          valid: isValid,
          expiresAt: now + cacheSec * 1000,
        }),
      });
    }
  }

  // Batch update cache
  if (cacheUpdates.length > 0 && redis) {
    try {
      const updateMap = {};
      for (const { channelId, data } of cacheUpdates) {
        updateMap[channelId] = data;
      }
      await redis.hset(CHANNELS_VALIDATION_KEY, updateMap);
      // Run cleanup asynchronously
      _runAsyncCleanup(redis);
    } catch {
      // Ignore cache write errors
    }
  }

  return results;
}
