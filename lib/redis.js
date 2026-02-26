import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🆕 GLOBAL CACHE - Fix Discord token timeout
let whitelistCache = null;
let cacheExpiry = 0;

export async function loadWhitelist() {
  try {
    const now = Date.now();
    
    // Cache hit = instant <1ms
    if (whitelistCache && now < cacheExpiry) {
      return whitelistCache;
    }

    const raw = await redis.get("whitelist:manga");
    if (!raw) {
      whitelistCache = [];
      cacheExpiry = now + 30000;  // 30s
      return [];
    }

    const data = Array.isArray(raw) ? raw : JSON.parse(raw);
    whitelistCache = data;
    cacheExpiry = now + 30000;  // Refresh setiap 30s
    return data;
  } catch (err) {
    console.error("Redis whitelist error:", err);
    return whitelistCache || [];
  }
}

export async function saveWhitelist(list) {
  try {
    await redis.set("whitelist:manga", JSON.stringify(list));
    // Invalidate cache on write
    whitelistCache = list;
    cacheExpiry = Date.now() + 30000;
  } catch (err) {
    console.error("Save whitelist error:", err);
  }
}

export async function getNotificationChannel(guildId) {
  try {
    return await redis.get(`channel:${guildId}`);
  } catch (err) {
    console.error("Get channel error:", err);
    return null;
  }
}

export async function setNotificationChannel(guildId, channelId) {
  try {
    await redis.set(`channel:${guildId}`, channelId);
  } catch (err) {
    console.error("Set channel error:", err);
  }
}

// 🆕 OPTIMIZE: Pakai SCAN bukan KEYS (production safe)
export async function getAllGuildChannels() {
  try {
    const result = {};
    let cursor = 0;
    
    do {
      const scanResult = await redis.scan(cursor, {
        MATCH: "channel:*",
        COUNT: 100
      });
      
      cursor = scanResult.cursor;
      const keys = scanResult.keys;
      
      for (const key of keys) {
        const guildId = key.replace("channel:", "");
        result[guildId] = await redis.get(key);
      }
    } while (cursor !== 0);
    
    return result;
  } catch (err) {
    console.error("Get all channels error:", err);
    return {};
  }
}
