import { Redis } from "@upstash/redis";
import dotenv from "dotenv";
dotenv.config();

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CHAPTER_TTL   = 60 * 60 * 24 * 3;      // 3 hari dalam detik
const THREE_DAYS_MS = 1000 * 60 * 60 * 24 * 3; // 3 hari dalam ms

const log = {
  info:    (msg) => console.log(`\x1b[36mℹ️  ${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m✅ ${msg}\x1b[0m`),
  warn:    (msg) => console.log(`\x1b[33m⚠️  ${msg}\x1b[0m`),
  error:   (msg) => console.log(`\x1b[31m❌ ${msg}\x1b[0m`),
  title:   (msg) => console.log(`\x1b[35m\n${"─".repeat(50)}\n   ${msg}\n${"─".repeat(50)}\x1b[0m`),
  item:    (msg) => console.log(`\x1b[37m   ${msg}\x1b[0m`),
};

// ─────────────────────────────────────────────────────────
// Hapus chapter key yang umurnya > 3 hari
// Logic: value disimpan sebagai timestamp (Date.now().toString())
// Kalau value bukan timestamp (misal "sent") → set TTL saja supaya auto expire
// ─────────────────────────────────────────────────────────
async function flushExpired() {
  log.title("🗑️  FLUSH CHAPTER KEYS > 3 HARI");

  const keys = await redis.keys("chapter:*");
  if (keys.length === 0) {
    log.warn("Tidak ada chapter key di Redis.");
    return;
  }

  log.info(`Scanning ${keys.length} chapter keys...`);

  const now    = Date.now();
  let deleted  = 0;
  let kept     = 0;
  let migrated = 0;

  for (const key of keys) {
    const value     = await redis.get(key);
    const timestamp = parseInt(value);

    if (!isNaN(timestamp)) {
      // Value berupa timestamp → bisa cek umur
      const ageMs = now - timestamp;
      if (ageMs > THREE_DAYS_MS) {
        await redis.del(key);
        log.item(`🗑️  Deleted (${Math.floor(ageMs / 86400000)} hari): ${key}`);
        deleted++;
      } else {
        const hoursOld = Math.floor(ageMs / 3600000);
        log.item(`✅ Keep   (${hoursOld}h old): ${key}`);
        kept++;
      }
    } else {
      // Value "sent" (format lama) → tidak ada timestamp, set TTL supaya auto expire
      const ttl = await redis.ttl(key);
      if (ttl === -1) {
        await redis.expire(key, CHAPTER_TTL);
        log.warn(`🔧 Migrated (set TTL 3 hari): ${key}`);
        migrated++;
      } else {
        log.item(`✅ Keep   (TTL: ${Math.ceil(ttl / 3600)}h left): ${key}`);
        kept++;
      }
    }
  }

  console.log("");
  log.success(`Deleted  : ${deleted} keys`);
  if (migrated > 0) log.warn(`Migrated : ${migrated} keys (format lama, TTL di-set)`);
  log.item(`Kept     : ${kept} keys`);
}

async function flushChapter() {
  log.title("🗑️  FLUSH ALL CHAPTER KEYS");
  const keys = await redis.keys("chapter:*");

  if (keys.length === 0) {
    log.warn("Tidak ada chapter key di Redis.");
    return;
  }

  for (const key of keys) {
    await redis.del(key);
    log.item(`Deleted: ${key}`);
  }
  log.success(`Total deleted: ${keys.length} keys`);
}

async function flushWhitelist() {
  log.title("🗑️  FLUSH WHITELIST");
  const whitelist = await redis.get("whitelist:manga") || [];
  log.info(`Found ${whitelist.length} manga in whitelist...`);
  await redis.del("whitelist:manga");
  log.success("Whitelist cleared!");
}

async function flushChannels() {
  log.title("🗑️  FLUSH CHANNEL KEYS");
  const keys = await redis.keys("channel:*");

  if (keys.length === 0) {
    log.warn("Tidak ada channel key di Redis.");
    return;
  }

  for (const key of keys) {
    await redis.del(key);
    log.item(`Deleted: ${key}`);
  }
  log.success(`Total deleted: ${keys.length} keys`);
}

async function flushAll() {
  log.title("💥 FLUSH ALL REDIS DATA");
  await flushChapter();
  await flushWhitelist();
  await flushChannels();
  await redis.del("cache:updates");
  log.success("cache:updates deleted");
  log.title("✅ SEMUA DATA BERHASIL DIHAPUS");
}

// ─────────────────────────────────────────────────────────
// Entry point
// node flush.js             → hapus chapter > 3 hari (default)
// node flush.js chapter     → hapus semua chapter keys
// node flush.js whitelist   → hapus whitelist
// node flush.js channels    → hapus channel keys
// node flush.js all         → hapus semua data
// ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args[0] || "expired";

switch (mode) {
  case "expired":
    flushExpired().catch(console.error);
    break;
  case "chapter":
    flushChapter().catch(console.error);
    break;
  case "whitelist":
    flushWhitelist().catch(console.error);
    break;
  case "channels":
    flushChannels().catch(console.error);
    break;
  case "all":
    flushAll().catch(console.error);
    break;
  default:
    log.error(`Unknown mode: "${mode}"`);
    log.item("Usage:");
    log.item("  node flush.js           → hapus chapter > 3 hari");
    log.item("  node flush.js chapter   → hapus semua chapter keys");
    log.item("  node flush.js whitelist → hapus whitelist");
    log.item("  node flush.js channels  → hapus channel keys");
    log.item("  node flush.js all       → hapus semua data");
    process.exit(1);
}
