import { httpGet } from "../httpClient.js";
import pLimit from "p-limit";
import { getLogger } from "../logger.js";
import { env } from "../config/env.js";
import {
  RedisClient,
  DiscordChannel,
  DiscordApiError,
  FetchDiscordChannelOptions,
  ValidateDiscordChannelOptions,
  ValidateDiscordChannelsBatchOptions,
} from "../types.js";

const logger = getLogger({ scope: "channelValidation" });

export const CHANNEL_VALIDATION_CACHE_SEC = env.CHANNEL_VALIDATION_CACHE_SEC;

export const CHANNELS_VALIDATION_KEY = "channels:validation";
export const CHANNEL_VALIDATION_CONCURRENCY = 5;

// Re-export consolidated types for backward compatibility
export type { DiscordChannel, DiscordApiError, FetchDiscordChannelOptions, ValidateDiscordChannelOptions, ValidateDiscordChannelsBatchOptions };

/**
 * Runs a background cleanup of expired validation entries.
 * Does not await the results to avoid blocking the main execution.
 */
function _runAsyncCleanup(redis: RedisClient): void {
  // Only run cleanup with a 5% chance to minimize Redis overhead during high-concurrency cron runs
  if (Math.random() > 0.05) return;

  // Run in background without awaiting
  (async () => {
    try {
      const data = await redis.hgetall(CHANNELS_VALIDATION_KEY);
      if (!data) return;
      const now = Date.now();
      const toDelete = Object.entries(data as Record<string, string>)
        .filter(([_key, val]) => {
          try {
            const parsed = typeof val === "string" ? JSON.parse(val) : val;
            return (parsed as { expiresAt?: number }).expiresAt! < now;
          } catch {
            return true;
          }
        })
        .map(([key]) => key);
      if (toDelete.length > 0) {
        await redis.hdel(CHANNELS_VALIDATION_KEY, ...toDelete);
      }
    } catch {
      // Cleanup errors are non-critical
    }
  })();
}

export async function fetchDiscordChannel({
  channelId,
  botToken,
}: FetchDiscordChannelOptions): Promise<DiscordChannel | null> {
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

export async function getCachedChannelValidity(
  redis: RedisClient,
  channelId: string,
): Promise<boolean | null> {
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
}: ValidateDiscordChannelOptions): Promise<boolean> {
  if (!channelId) return false;

  const cached = redis ? await getCachedChannelValidity(redis, channelId) : null;
  if (cached !== null) return cached;

  try {
    const channel = await fetchDiscordChannel({ channelId, botToken });

    if (writeCache && redis) {
      const pipeline = redis.pipeline();
      pipeline.hset(CHANNELS_VALIDATION_KEY, {
        [channelId]: JSON.stringify({
          valid: true,
          expiresAt: Date.now() + cacheSec * 1000,
        }),
      });
      pipeline.eval(
        "return redis.call('HPEXPIRE', KEYS[1], ARGV[1], 'FIELDS', 1, ARGV[2])",
        [CHANNELS_VALIDATION_KEY],
        [cacheSec * 1000, channelId]
      );
      await pipeline.exec();
      _runAsyncCleanup(redis);
    }
    if (channel && typeof onValid === "function") {
      await Promise.resolve(onValid(channel));
    }
    return !!channel;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if ((status === 403 || status === 404) && writeCache && redis) {
      const pipeline = redis.pipeline();
      pipeline.hset(CHANNELS_VALIDATION_KEY, {
        [channelId]: JSON.stringify({
          valid: false,
          expiresAt: Date.now() + cacheSec * 1000,
        }),
      });
      pipeline.eval(
        "return redis.call('HPEXPIRE', KEYS[1], ARGV[1], 'FIELDS', 1, ARGV[2])",
        [CHANNELS_VALIDATION_KEY],
        [cacheSec * 1000, channelId]
      );
      await pipeline.exec();
      _runAsyncCleanup(redis);
    }
    if (typeof onInvalid === "function") {
      await Promise.resolve(onInvalid(err as Error | { message: string; response?: { status?: number } }));
    }
    return false;
  }
}


/**
 * Fetch multiple Discord channels in parallel with concurrency control
 */
export async function fetchDiscordChannelsBatch(
  channelIds: string[],
  botToken: string,
  concurrency = CHANNEL_VALIDATION_CONCURRENCY,
): Promise<Map<string, any>> {
  if (!channelIds || channelIds.length === 0) return new Map();

  const limit = pLimit(concurrency);
  const results = new Map();

  const fetchTasks = channelIds.map((channelId) =>
    limit(async () => {
      try {
        const channel = await fetchDiscordChannel({ channelId, botToken });
        return { channelId, channel, valid: true };
      } catch (err: any) {
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
 */
export async function getCachedChannelsValidityBatch(
  redis: RedisClient,
  channelIds: string[],
): Promise<Map<string, boolean | null>> {
  if (!redis || !channelIds || channelIds.length === 0) return new Map();

  const results = new Map<string, boolean | null>();
  const now = Date.now();

  try {
    const cachedData: any = await redis.hmget(
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
            results.set(channelId, null);
          }
        } catch {
          results.set(channelId, null);
        }
      } else {
        results.set(channelId, null);
      }
    }
  } catch {
    for (const channelId of channelIds) {
      results.set(channelId, null);
    }
  }

  return results;
}

export async function validateDiscordChannelsBatch({
  redis = null,
  channelIds = [],
  botToken,
  cacheSec = CHANNEL_VALIDATION_CACHE_SEC,
  concurrency = CHANNEL_VALIDATION_CONCURRENCY,
}: ValidateDiscordChannelsBatchOptions): Promise<Map<string, boolean>> {
  if (!channelIds || channelIds.length === 0) return new Map();

  const results = new Map<string, boolean>();
  const now = Date.now();

  const cachedResults = redis
    ? await getCachedChannelsValidityBatch(redis, channelIds)
    : new Map(channelIds.map((id) => [id, null]));
  const channelsToFetch: string[] = [];

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

  const fetchedResults = await fetchDiscordChannelsBatch(
    channelsToFetch,
    botToken,
    concurrency,
  );

  const cacheUpdates: { channelId: string; data: string }[] = [];

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

  if (cacheUpdates.length > 0 && redis) {
    try {
      const updateMap: Record<string, string> = {};
      for (const { channelId, data } of cacheUpdates) {
        updateMap[channelId] = data;
      }
      await redis.hset(CHANNELS_VALIDATION_KEY, updateMap);
      _runAsyncCleanup(redis);
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Cache write failed");
    }
  }

  return results;
}
