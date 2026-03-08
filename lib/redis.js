import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  enableAutoPipelining: false,
});

const WHITELIST_KEY = "whitelist:manga";

function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function normalizeTitleKey(title = "") {
  return String(title)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

    const dedupeKey = `${src}::${key}`;

    if (!seen.has(dedupeKey)) {
      const idx = result.length;
      result.push({ title, url, source: src });
      seen.set(dedupeKey, idx);
      continue;
    }

    const idx = seen.get(dedupeKey);
    const current = result[idx];
    if (!current.url && url) current.url = url;
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
