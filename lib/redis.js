import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function getRedis() {
  if (!redisInstance) {
    redisInstance = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisInstance;
}

// ===== CACHE =====
let whitelistCache = null;
let cacheExpiry = 0;

export function invalidateWhitelistCache() {
  whitelistCache = null;
  cacheExpiry = 0;
}

// ===== WHITELIST =====

export async function loadWhitelist() {
  try {
    const now = Date.now();

    if (whitelistCache && now < cacheExpiry) {
      return whitelistCache;
    }

    const raw = await getRedis().get("whitelist:manga");

    if (!raw) {
      // ✅ Jangan cache hasil kosong supaya selalu fresh dari Redis
      whitelistCache = null;
      cacheExpiry = 0;
      return [];
    }

    const data = Array.isArray(raw) ? raw : JSON.parse(raw);

    const migrated = data.map((item) =>
      typeof item === "string" ? { title: item, url: null } : item,
    );

    whitelistCache = migrated;
    cacheExpiry = now + 30000;

    return migrated;
  } catch (err) {
    console.error("Redis whitelist error:", err);
    return whitelistCache || [];
  }
}

export async function saveWhitelist(list) {
  try {
    await redis.set("whitelist:manga", JSON.stringify(list));
    // ✅ Update cache langsung supaya konsisten
    whitelistCache = list;
    cacheExpiry = Date.now() + 30000;
  } catch (err) {
    console.error("Save whitelist error:", err);
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
    // Prefix "id:" prevents Upstash from parsing snowflake ID as float
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
      }),
    );
  } catch (err) {
    console.error("Get all channels error:", err);
    return {};
  }
}