import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ===== CACHE =====
let whitelistCache = null;
let cacheExpiry = 0;

// ===== WHITELIST =====

export async function loadWhitelist() {
  try {
    const now = Date.now();

    if (whitelistCache && now < cacheExpiry) {
      return whitelistCache;
    }

    const raw = await redis.get("whitelist:manga");

    if (!raw) {
      whitelistCache = [];
      cacheExpiry = now + 30000;
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
    whitelistCache = list;
    cacheExpiry = Date.now() + 30000;
  } catch (err) {
    console.error("Save whitelist error:", err);
  }
}

// ===== CHANNEL =====

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
    const result = {};
    let cursor = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, {
        match: "channel:*",
        count: 100,
      });
      cursor = nextCursor;

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
