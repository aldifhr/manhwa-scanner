import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  enableAutoPipelining: false,
});

const WHITELIST_KEY = "whitelist:manga";

export async function loadWhitelist() {
  try {
    const raw = await redis.get(WHITELIST_KEY);
    if (!raw) return [];

    const data = Array.isArray(raw) ? raw : [];
    return data.map((item) => {
      if (typeof item === "string") {
        return { title: item, url: null, source: "ikiru" };
      }

      return {
        title: item?.title ?? "",
        url: item?.url ?? null,
        source: item?.source ?? "ikiru",
      };
    });
  } catch (err) {
    console.error("[loadWhitelist] Redis error:", err);
    return [];
  }
}

export async function saveWhitelist(list) {
  if (!Array.isArray(list)) throw new Error("list harus berupa array");

  try {
    await redis.set(WHITELIST_KEY, list);
  } catch (err) {
    console.error("[saveWhitelist] Redis error:", err);
    throw err;
  }
}

export async function getNotificationChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    const val = await redis.get(`channel:${guildId}`);
    if (val === null) return null;
    return String(val);
  } catch (err) {
    console.error(`[getNotificationChannel] guildId=${guildId}:`, err);
    return null;
  }
}

export async function setNotificationChannel(guildId, channelId) {
  if (!guildId || !channelId) throw new Error("guildId dan channelId required");

  const idStr = String(channelId).trim();
  if (!/^\d+$/.test(idStr)) throw new Error("channelId harus numeric");
  if (idStr.length !== 18 && idStr.length !== 19)
    throw new Error(`Invalid snowflake length: ${idStr.length}`);

  await redis.set(`channel:${guildId}`, idStr);
}

export async function deleteGuildChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    await redis.del(`channel:${guildId}`);
  } catch (err) {
    console.error(`[deleteGuildChannel] guildId=${guildId}:`, err);
    throw err;
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

    const values = [];
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      const chunkValues = await redis.mget(...chunk);
      values.push(...chunkValues);
    }

    return Object.fromEntries(
      keys
        .map((key, i) => [key.replace("channel:", ""), values[i]])
        .filter(([, val]) => val !== null),
    );
  } catch (err) {
    console.error("[getAllGuildChannels] Redis error:", err);
    return {};
  }
}
