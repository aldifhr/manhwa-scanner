import "dotenv/config";
import { Redis } from "@upstash/redis";
import { normalizeWhitelist, normalizeTitleKey } from "./domain.js";
import { STATUS_API_CACHE_KEY } from "./cacheKeys.js";
import { SOURCE_KEYS, sourceHealthKey } from "./services/health.js";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  enableAutoPipelining: true,
});

const WHITELIST_KEY_LEGACY = "whitelist:manga";
const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_INDEX_KEY = "whitelist:index";
const CHANNEL_HASH_KEY = "channels:guild-map";
const CHANNEL_KEY_PREFIX = "channel:";

export const RECENT_CHAPTERS_KEY = "recent:chapters";
export const CRON_LOG_LIST_KEY = "cron:logs";
export const CRON_LAST_RUN_KEY = "cron:last_run";
export const CHANNEL_VALIDATION_REFRESH_KEY = "cron:last_channel_validation_at";
export const STATUS_CACHE_TTL_SEC = Number(process.env.STATUS_CACHE_SEC || 60);

export const STATUS_EMPTY_CACHE_VALUE = "__STATUS_NULL__";

export function hasStatusCacheValue(value) {
  return value !== null && value !== undefined;
}

export function decodeStatusCacheValue(value) {
  if (value === STATUS_EMPTY_CACHE_VALUE) return null;
  return value;
}

export function encodeStatusCacheValue(value) {
  return value === null ? STATUS_EMPTY_CACHE_VALUE : value;
}


export async function loadWhitelist() {
  try {
    // 1. Cek di ZSET index untuk mendapatkan urutan titleKey
    const index = await redis.zrange(WHITELIST_INDEX_KEY, 0, -1);
    
    if (index && index.length > 0) {
      // 2. Jika ada di index, ambil data dari Hash
      const data = await redis.hmget(WHITELIST_DATA_KEY, ...index);
      
      let list = [];
      // Upstash hmget mengembalikan objek { field: value } jika diberikan multiple arguments
      if (data && typeof data === "object" && !Array.isArray(data)) {
        list = Object.values(data).filter(Boolean);
      } else if (Array.isArray(data)) {
        list = data.filter(Boolean);
      }
      
      console.log(`[loadWhitelist] Index=${index.length} HMGET_Type=${typeof data} Array=${Array.isArray(data)} Final=${list.length}`);
      return list;
    }

    // 3. LAZY MIGRATION: Jika index kosong, coba cek dari key lama
    const rawLegacy = await redis.get(WHITELIST_KEY_LEGACY);
    if (rawLegacy) {
      const list = normalizeWhitelist(rawLegacy);
      if (list.length > 0) {
        // Melakukan migrasi ke struktur baru
        await saveWhitelist(list);
        console.log(`[loadWhitelist] Migrated ${list.length} items to new structure.`);
      }
      return list;
    }

    return [];
  } catch (err) {
    console.error("[loadWhitelist] Redis error:", err);
    return [];
  }
}

export async function loadWhitelistItem(titleKey) {
  try {
    return await redis.hget(WHITELIST_DATA_KEY, titleKey);
  } catch (err) {
    console.error(`[loadWhitelistItem] titleKey=${titleKey}:`, err);
    return null;
  }
}

export async function saveWhitelist(list) {
  if (!list || !Array.isArray(list)) throw new Error("list harus berupa array");

  const normalized = normalizeWhitelist(list);
  if (normalized.length === 0) {
    // Jika dikosongkan, hapus semua
    try {
      await Promise.all([
        redis.del(WHITELIST_DATA_KEY),
        redis.del(WHITELIST_INDEX_KEY),
        redis.del(WHITELIST_KEY_LEGACY)
      ]);
    } catch (err) {
      console.error("[saveWhitelist] Clear error:", err);
    }
    return;
  }

  const dataMap = {};
  const indexTasks = [];
  const now = Date.now();

  normalized.forEach((item, i) => {
    const tk = normalizeTitleKey(item.title);
    if (!tk) return;
    dataMap[tk] = item;
    // Gunakan index 'i' sebagai score agar urutan tetap sama dengan input array
    indexTasks.push({ score: i, member: tk });
  });

  try {
    // Gunakan pipeline untuk performa (jika didukung client, atau Promise.all)
    await Promise.all([
      redis.hset(WHITELIST_DATA_KEY, dataMap),
      // Kita harus hapus index lama dulu agar urutan tidak numpuk jika jumlah berubah
      redis.del(WHITELIST_INDEX_KEY).then(() => {
          // Batching zadd
          let batch = [];
          for (const task of indexTasks) {
              batch.push(redis.zadd(WHITELIST_INDEX_KEY, task));
          }
          return Promise.all(batch);
      }),
      // Cleanup legacy key
      redis.del(WHITELIST_KEY_LEGACY)
    ]);
  } catch (err) {
    console.error("[saveWhitelist] Redis error:", err);
    throw err;
  }
}

export async function getNotificationChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    const val = await getNotificationChannelFromStore(redis, guildId);
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

  await setNotificationChannelInStore(redis, guildId, idStr);
}

export async function deleteGuildChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    await deleteGuildChannelFromStore(redis, guildId);
  } catch (err) {
    console.error(`[deleteGuildChannel] guildId=${guildId}:`, err);
    throw err;
  }
}

export async function getAllGuildChannels() {
  try {
    return await getAllGuildChannelsFromStore(redis);
  } catch (err) {
    console.error("[getAllGuildChannels] Redis error:", err);
    return {};
  }
}

function normalizeChannelMap(map) {
  if (!map || typeof map !== "object") return {};

  return Object.fromEntries(
    Object.entries(map)
      .map(([guildId, channelId]) => [String(guildId), channelId === null || channelId === undefined ? null : String(channelId)])
      .filter(([, channelId]) => Boolean(channelId)),
  );
}

async function getLegacyGuildChannels(client) {
  let cursor = 0;
  const keys = [];

  do {
    const [nextCursor, batchKeys] = await client.scan(cursor, {
      match: `${CHANNEL_KEY_PREFIX}*`,
      count: 100,
    });
    keys.push(...batchKeys);
    cursor = Number(nextCursor);
  } while (cursor !== 0);

  if (keys.length === 0) return {};

  const values = [];
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const chunkValues = await client.mget(...chunk);
    values.push(...chunkValues);
  }

  return normalizeChannelMap(
    Object.fromEntries(
      keys.map((key, i) => [key.slice(CHANNEL_KEY_PREFIX.length), values[i]]),
    ),
  );
}

async function hydrateChannelHash(client, guildChannels) {
  const normalized = normalizeChannelMap(guildChannels);
  const entries = Object.entries(normalized);
  if (!entries.length) return {};

  await client.hset(CHANNEL_HASH_KEY, normalized);
  return Object.fromEntries(entries);
}

export async function getNotificationChannelFromStore(client, guildId) {
  const field = String(guildId);
  const hashed = await client.hget(CHANNEL_HASH_KEY, field);
  if (hashed !== null && hashed !== undefined) return String(hashed);

  const legacy = await client.get(`${CHANNEL_KEY_PREFIX}${field}`);
  if (legacy === null || legacy === undefined) return null;

  const value = String(legacy);
  await client.hset(CHANNEL_HASH_KEY, { [field]: value }).catch(() => {});
  return value;
}

export async function setNotificationChannelInStore(client, guildId, channelId) {
  const field = String(guildId);
  const value = String(channelId);
  await client.hset(CHANNEL_HASH_KEY, { [field]: value });
  await client.del(`${CHANNEL_KEY_PREFIX}${field}`).catch(() => {});
}

export async function deleteGuildChannelFromStore(client, guildId) {
  const field = String(guildId);
  await Promise.all([
    client.hdel(CHANNEL_HASH_KEY, field).catch(() => 0),
    client.del(`${CHANNEL_KEY_PREFIX}${field}`),
  ]);
}

export async function getAllGuildChannelsFromStore(client) {
  const hashed = normalizeChannelMap(await client.hgetall(CHANNEL_HASH_KEY));
  if (Object.keys(hashed).length > 0) return hashed;

  const legacy = await getLegacyGuildChannels(client);
  if (Object.keys(legacy).length === 0) return {};

  await hydrateChannelHash(client, legacy).catch(() => {});
  return legacy;
}

export async function readObjectCache(client, key) {
  const cached = await client.get(key);
  return cached && typeof cached === "object" ? cached : null;
}

export async function writeObjectCache(client, key, payload, cacheTtl) {
  await client.set(key, payload, { ex: cacheTtl }).catch(() => {});
}

export async function readStatusCache(client) {
  const rawCached = await client.get(STATUS_API_CACHE_KEY);
  if (!hasStatusCacheValue(rawCached)) {
    return { hit: false, value: null };
  }
  return {
    hit: true,
    value: decodeStatusCacheValue(rawCached),
  };
}

export async function writeStatusCache(client, payload, cacheTtl) {
  await client
    .set(STATUS_API_CACHE_KEY, encodeStatusCacheValue(payload), { ex: cacheTtl })
    .catch(() => {});
}

export async function readRecentChapters(client, start = 0, stop = 49) {
  return client.lrange(RECENT_CHAPTERS_KEY, start, stop);
}

export async function readCronLogs(client, start = 0, stop = 49) {
  return client.lrange(CRON_LOG_LIST_KEY, start, stop);
}

export async function readCronStatus(client) {
  return client.get(CRON_LAST_RUN_KEY);
}

export async function writeCronStatus(client, statusPayload) {
  await client.set(CRON_LAST_RUN_KEY, statusPayload);
  await writeStatusCache(client, statusPayload, STATUS_CACHE_TTL_SEC);
}

export async function loadSourceHealthSnapshot(client, sourceKeys = SOURCE_KEYS) {
  const entries = await Promise.all(
    sourceKeys.map(async (source) => {
      const raw = await client.get(sourceHealthKey(source));
      return [source, raw ?? null];
    }),
  );
  return Object.fromEntries(entries);
}

export async function readChannelValidationState(client) {
  return client.get(CHANNEL_VALIDATION_REFRESH_KEY).catch(() => null);
}

export async function writeChannelValidationState(client, payload) {
  await client.set(CHANNEL_VALIDATION_REFRESH_KEY, payload).catch(() => {});
}

