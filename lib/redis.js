import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function loadWhitelist() {
  try {
    const raw = await redis.get("whitelist:manga");
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") return JSON.parse(raw);
    return [];
  } catch {
    return [];
  }
}

export async function saveWhitelist(list) {
  await redis.set("whitelist:manga", JSON.stringify(list));
}

export async function getNotificationChannel(guildId) {
  try {
    return await redis.get(`channel:${guildId}`);
  } catch {
    return null;
  }
}

export async function setNotificationChannel(guildId, channelId) {
  await redis.set(`channel:${guildId}`, channelId);
}

export async function getAllGuildChannels() {
  const keys   = await redis.keys("channel:*");
  const result = {};
  for (const key of keys) {
    result[key.replace("channel:", "")] = await redis.get(key);
  }
  return result;
}
