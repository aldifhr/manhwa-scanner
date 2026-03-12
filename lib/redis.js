import { Redis } from "@upstash/redis";
import { normalizeTitleKey } from "./domain/manga.js";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  enableAutoPipelining: true,
});

const WHITELIST_KEY = "whitelist:manga";
const CHANNEL_HASH_KEY = "channels:guild-map";
const CHANNEL_KEY_PREFIX = "channel:";

function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function normalizeWhitelist(list = []) {
  const source = Array.isArray(list) ? list : [];
  const result = [];
  const seen = new Map();

  for (const item of source) {
    const rawTitle = typeof item === "string" ? item : item?.title;
    const title = String(rawTitle ?? "").trim();
    if (!title) continue;

    const key = normalizeTitleKey(title);
    if (!key) continue;

    const urlRaw = typeof item === "string" ? null : item?.url;
    const url = String(urlRaw ?? "").trim() || null;
    const srcRaw = typeof item === "string" ? "ikiru" : item?.source;
    const src = normalizeSource(srcRaw);
    const markRaw = typeof item === "string" ? null : item?.mark;
    const mark = String(markRaw ?? "").trim() || null;

    const dedupeKey = `${src}::${key}`;

    if (!seen.has(dedupeKey)) {
      const idx = result.length;
      result.push({ title, url, source: src, mark });
      seen.set(dedupeKey, idx);
      continue;
    }

    const idx = seen.get(dedupeKey);
    const current = result[idx];
    if (!current.url && url) current.url = url;
    if (!current.mark && mark) current.mark = mark;
  }

  return result;
}

export async function loadWhitelist() {
  try {
    const raw = await redis.get(WHITELIST_KEY);
    if (!raw) return [];
    return normalizeWhitelist(raw);
  } catch (err) {
    console.error("[loadWhitelist] Redis error:", err);
    return [];
  }
}

export async function saveWhitelist(list) {
  if (!Array.isArray(list)) throw new Error("list harus berupa array");

  try {
    await redis.set(WHITELIST_KEY, normalizeWhitelist(list));
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
