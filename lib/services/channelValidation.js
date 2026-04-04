import { httpGet } from "../httpClient.js";

export const CHANNEL_VALIDATION_CACHE_SEC = Number(
  process.env.CHANNEL_VALIDATION_CACHE_SEC || 60 * 60 * 6,
);

export const CHANNELS_VALIDATION_KEY = "channels:validation";

async function _runAsyncCleanup(redis) {
  try {
    const data = await redis.hgetall(CHANNELS_VALIDATION_KEY);
    if (!data) return;
    const now = Date.now();
    const toDelete = Object.entries(data)
      .filter(([_, val]) => {
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
  } catch { /* ignore */ }
}

export async function fetchDiscordChannel({
  channelId,
  botToken,
} = {}) {
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
      const parsed = typeof cachedStr === 'string' ? JSON.parse(cachedStr) : cachedStr;
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
      await redis.hset(CHANNELS_VALIDATION_KEY, {
        [channelId]: JSON.stringify({ valid: true, expiresAt: Date.now() + cacheSec * 1000 })
      }).catch(() => {});
      _runAsyncCleanup(redis);
    }
    if (typeof onValid === "function") {
      await Promise.resolve(onValid(channel));
    }
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if ((status === 403 || status === 404) && writeCache && redis) {
      await redis.hset(CHANNELS_VALIDATION_KEY, {
        [channelId]: JSON.stringify({ valid: false, expiresAt: Date.now() + cacheSec * 1000 })
      }).catch(() => {});
      _runAsyncCleanup(redis);
    }
    if (typeof onInvalid === "function") {
      await Promise.resolve(onInvalid(err));
    }
    return false;
  }
}
