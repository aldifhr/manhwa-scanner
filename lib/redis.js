import { Redis } from "@upstash/redis";

// ✅ Satu instance saja
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const WHITELIST_KEY = "whitelist:manga";

// ===== WHITELIST =====

/**
 * Load whitelist dari Redis.
 * Upstash auto-deserialize JSON, jadi tidak perlu JSON.parse manual.
 */
export async function loadWhitelist() {
  try {
    const raw = await redis.get(WHITELIST_KEY);
    if (!raw) return [];

    // Upstash sudah deserialize — raw langsung array atau object
    const data = Array.isArray(raw) ? raw : [];

    return data.map((item) =>
      typeof item === "string" ? { title: item, url: null } : item,
    );
  } catch (err) {
    console.error("[loadWhitelist] Redis error:", err);
    return [];
  }
}

/**
 * Simpan whitelist ke Redis.
 * Upstash auto-serialize — tidak perlu JSON.stringify manual.
 */
export async function saveWhitelist(list) {
  if (!Array.isArray(list)) throw new Error("list harus berupa array");

  try {
    await redis.set(WHITELIST_KEY, list);
  } catch (err) {
    console.error("[saveWhitelist] Redis error:", err);
    throw err;
  }
}

// ===== CHANNEL =====

/**
 * Ambil channel notifikasi untuk satu guild.
 * Mengembalikan channelId (string) atau null kalau belum diset.
 */
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

/**
 * Set channel notifikasi untuk satu guild.
 * Menyimpan channelId langsung tanpa prefix tambahan.
 */
export async function setNotificationChannel(guildId, channelId) {
  if (!guildId || !channelId) throw new Error("guildId dan channelId required");

  const idStr = String(BigInt(channelId));  // Force safe conversion
  if (idStr.length !== 18 && idStr.length !== 19) {
    throw new Error(`Invalid snowflake length: ${idStr.length}`);
  }

  console.log(`[REDIS SET] "${idStr}" → key:channel:${guildId.slice(-4)}`);
  
  await redis.set(`channel:${guildId}`, idStr);
  
  // Atomic verify
  const verify = await redis.get(`channel:${guildId}`);
  if (verify !== idStr) {
    throw new Error(`Redis corrupt! Wrote "${idStr}" got "${verify}"`);
  }
  console.log(`[REDIS OK] Verified`);
}


/**
 * Hapus channel notifikasi untuk satu guild.
 */
export async function deleteGuildChannel(guildId) {
  if (!guildId) throw new Error("guildId required");

  try {
    await redis.del(`channel:${guildId}`);
    console.log(`🗑️ Removed guild ${guildId} from Redis`);
  } catch (err) {
    console.error(`[deleteGuildChannel] guildId=${guildId}:`, err);
    throw err;
  }
}

/**
 * Ambil semua guild → channelId mapping dari Redis.
 * Menggunakan SCAN agar aman untuk dataset besar (tidak blocking).
 * Key null/expired difilter dari hasil akhir.
 */
export async function getAllGuildChannels() {
  try {
    let cursor = 0;
    const keys = [];

    // SCAN sampai cursor kembali ke 0
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
      keys
        .map((key, i) => [key.replace("channel:", ""), values[i]])
        // Filter key yang sudah dihapus atau expired (nilai null)
        .filter(([, val]) => val !== null) 
    );
  } catch (err) {
    console.error("[getAllGuildChannels] Redis error:", err);
    return {};
  }
}