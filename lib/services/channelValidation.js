import { httpGet } from "../httpClient.js";

export const CHANNEL_VALIDATION_CACHE_SEC = 60 * 10;

export function channelValidationCacheKey(channelId) {
  return `cache:channel-valid:${channelId}`;
}

export async function getCachedChannelValidity(redis, channelId) {
  if (!redis || !channelId) return null;
  try {
    const cached = await redis.get(channelValidationCacheKey(channelId));
    if (cached === true) return true;
    if (cached === false) return false;
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
    const resp = await httpGet(
      `https://discord.com/api/v10/channels/${channelId}`,
      {
        headers: { Authorization: `Bot ${botToken}` },
        timeout: 10000,
      },
      { retries: 2 },
    );

    if (writeCache && redis) {
      await redis.set(channelValidationCacheKey(channelId), true, {
        ex: cacheSec,
      }).catch(() => {});
    }
    if (typeof onValid === "function") {
      await Promise.resolve(onValid(resp.data));
    }
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if ((status === 403 || status === 404) && writeCache && redis) {
      await redis.set(channelValidationCacheKey(channelId), false, {
        ex: cacheSec,
      }).catch(() => {});
    }
    if (typeof onInvalid === "function") {
      await Promise.resolve(onInvalid(err));
    }
    return false;
  }
}
