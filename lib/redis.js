import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// GLOBAL CACHE - Fix Discord token timeout
let whitelistCache = null;
let cacheExpiry    = 0;

// Whitelist item shape: { title: string, url: string }
// Auto-migrasi dari format lama (array of string)

export async function loadWhitelist() {
  try {
    const now = Date.now();

    if (whitelistCache && now < cacheExpiry) {
      return whitelistCache;
    }

    const raw = await redis.get("whitelist:manga");
    if (!raw) {
      whitelistCache = [];
      cacheExpiry    = now + 30000;
      return [];
    }

    const data = Array.isArray(raw) ? raw : JSON.parse(raw);

    // Auto-migrasi: kalau isinya string lama, convert ke { title, url: null }
    const migrated = data.map(item =>
      typeof item === "string"
        ? { title: item, url: null }
        : item
    );

    whitelistCache = migrated;
    cacheExpiry    = now + 30000;
    return migrated;
  } catch (err) {
    console.error("Redis whitelist error:", err);
    return whitelistCache || [];
  }
}

export async function saveWhitelist(list) {
  try {
    await redis.set("whitelist:manga", JSON.stringify(list));
    whitelistCache = list;
    cacheExpiry    = Date.now() + 30000;
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

export async function getAllGuildChannels() {
  try {
    const result = {};
    let cursor   = 0;

    do {
      const scanResult = await redis.scan(cursor, {
        MATCH: "channel:*",
        COUNT: 100,
      });

      cursor       = scanResult.cursor;
      const keys   = scanResult.keys;

      for (const key of keys) {
        const guildId    = key.replace("channel:", "");
        result[guildId]  = await redis.get(key);
      }
    } while (cursor !== 0);

    return result;
  } catch (err) {
    console.error("Get all channels error:", err);
    return {};
  }
}