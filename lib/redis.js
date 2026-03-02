import { Redis } from "@upstash/redis";

// ✅ Satu instance saja
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const WHITELIST_KEY = "whitelist:manga";

// ===== WHITELIST =====

export async function loadWhitelist() {
  try {
    const raw = await redis.get(WHITELIST_KEY);
    if (!raw) return [];

    const data = Array.isArray(raw) ? raw : JSON.parse(raw);
    return data.map((item) =>
      typeof item === "string" ? { title: item, url: null } : item
    );
  } catch (err) {
    console.error("Redis whitelist error:", err);
    return [];
  }
}

export async function saveWhitelist(list) {
  try {
    await redis.set(WHITELIST_KEY, JSON.stringify(list));
  } catch (err) {
    console.error("Save whitelist error:", err);
    throw err;
  }
}

// ===== CHANNEL =====

export async function getNotificationChannel(guildId) {
  try {
    const val = await redis.get(`channel:${guildId}`);
    if (!val) return null;
    const str = String(val).replace(/"/g, "");
    return str.startsWith("id:") ? str.slice(3) : str;
  } catch (err) {
    console.error("Get channel error:", err);
    return null;
  }
}

export async function setNotificationChannel(guildId, channelId) {
  try {
    await redis.set(`channel:${guildId}`, `id:${channelId}`);
  } catch (err) {
    console.error("Set channel error:", err);
  }
}

export async function deleteGuildChannel(guildId) {
  try {
    await redis.del(`channel:${guildId}`);
    console.log(`🗑️ Removed guild ${guildId} from Redis`);
  } catch (err) {
    console.error("Delete guild error:", err);
  }
}

export async function getAllGuildChannels() {
  try {
    let cursor = 0;
    const keys = [];

    do {
      const [nextCursor, batchKeys] = await redis.scan(cursor, {
        match: "channel:*",
        count: 100,
      });
      keys.push(...batchKeys);
      cursor = Number(nextCursor);
    } while (cursor !== 0);

    if (keys.length === 0) return {};

    const values = await redis.mget(...keys);

    return Object.fromEntries(
      keys.map((key, i) => {
        const raw = values[i];
        const val = typeof raw === "string"
          ? raw.replace(/"/g, "").replace(/^id:/, "")
          : raw;
        return [key.replace("channel:", ""), val];
      })
    );
  } catch (err) {
    console.error("Get all channels error:", err);
    return {};
  }
}