import { Redis } from "@upstash/redis";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CHAPTER_TTL_SEC = 60 * 60 * 24 * 3;
const THREE_DAYS_MS = CHAPTER_TTL_SEC * 1000;

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function section(title) {
  const border = "-".repeat(48);
  out("");
  out(border);
  out(title);
  out(border);
}

function info(message) {
  out(`[info] ${message}`);
}

function warn(message) {
  out(`[warn] ${message}`);
}

function success(message) {
  out(`[ok] ${message}`);
}

function fail(message) {
  out(`[error] ${message}`);
}

async function listKeys(pattern) {
  const keys = await redis.keys(pattern);
  return Array.isArray(keys) ? keys : [];
}

async function deleteKeys(keys = []) {
  let deleted = 0;
  for (const key of keys) {
    await redis.del(key);
    out(`  deleted: ${key}`);
    deleted += 1;
  }
  return deleted;
}

async function flushExpiredChapters() {
  section("Flush Expired Chapter Keys");

  const keys = await listKeys("chapter:*");
  if (!keys.length) {
    warn("Tidak ada chapter key di Redis.");
    return;
  }

  info(`Scanning ${keys.length} chapter key(s)...`);

  const nowMs = Date.now();
  let deleted = 0;
  let kept = 0;
  let migrated = 0;

  for (const key of keys) {
    const value = await redis.get(key);
    const rawTimestamp = typeof value === "string" ? Number.parseInt(value, 10) : NaN;

    if (Number.isFinite(rawTimestamp)) {
      const ageMs = nowMs - rawTimestamp;
      if (ageMs > THREE_DAYS_MS) {
        await redis.del(key);
        out(`  deleted expired (${Math.floor(ageMs / 86400000)}d): ${key}`);
        deleted += 1;
      } else {
        out(`  keep (${Math.floor(ageMs / 3600000)}h old): ${key}`);
        kept += 1;
      }
      continue;
    }

    const ttl = await redis.ttl(key);
    if (ttl === -1) {
      await redis.expire(key, CHAPTER_TTL_SEC);
      out(`  migrated ttl=3d: ${key}`);
      migrated += 1;
    } else {
      out(`  keep (ttl=${ttl}s): ${key}`);
      kept += 1;
    }
  }

  success(`deleted=${deleted}`);
  success(`kept=${kept}`);
  if (migrated > 0) success(`migrated=${migrated}`);
}

async function flushAllChapterKeys() {
  section("Flush All Chapter Keys");
  const keys = await listKeys("chapter:*");
  if (!keys.length) {
    warn("Tidak ada chapter key di Redis.");
    return;
  }
  const deleted = await deleteKeys(keys);
  success(`total deleted=${deleted}`);
}

async function flushWhitelist() {
  section("Flush Whitelist");
  const whitelist = (await redis.get("whitelist:manga")) || [];
  info(`found ${Array.isArray(whitelist) ? whitelist.length : 0} whitelist item(s)`);
  await redis.del("whitelist:manga");
  success("whitelist cleared");
}

async function flushChannelStore() {
  section("Flush Channel Store");
  const legacyKeys = await listKeys("channel:*");
  const deleted = await deleteKeys(legacyKeys);
  await redis.del("channels:guild-map");
  success(`legacy deleted=${deleted}`);
  success("hash deleted=channels:guild-map");
}

async function flushDashboardCaches() {
  section("Flush Dashboard Caches");
  const keys = [
    "cache:api:status:v1",
    "cache:api:whitelist:v1",
    "cache:api:recent:v1",
    "cache:api:logs:v1",
    "cron:last_run",
  ];
  const deleted = await deleteKeys(keys);
  success(`total deleted=${deleted}`);
}

async function flushAllSafe() {
  section("Flush All Safe Bot Data");
  await flushAllChapterKeys();
  await flushWhitelist();
  await flushChannelStore();
  await flushDashboardCaches();
  success("selesai");
}

function printUsage() {
  out("Usage:");
  out("  node flush.js");
  out("  node flush.js expired");
  out("  node flush.js chapter");
  out("  node flush.js whitelist");
  out("  node flush.js channels");
  out("  node flush.js cache");
  out("  node flush.js all");
  out("");
  out("Modes:");
  out("  expired   hapus chapter key yang expired > 3 hari atau set ttl legacy key");
  out("  chapter   hapus semua chapter key");
  out("  whitelist hapus whitelist");
  out("  channels  hapus channel store");
  out("  cache     hapus cache dashboard utama");
  out("  all       gabungan chapter + whitelist + channels + cache");
}

async function main() {
  const mode = String(process.argv[2] || "expired").toLowerCase().trim();

  switch (mode) {
    case "expired":
      await flushExpiredChapters();
      return;
    case "chapter":
      await flushAllChapterKeys();
      return;
    case "whitelist":
      await flushWhitelist();
      return;
    case "channels":
      await flushChannelStore();
      return;
    case "cache":
      await flushDashboardCaches();
      return;
    case "all":
      await flushAllSafe();
      return;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      fail(`Unknown mode: ${mode}`);
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  fail(err?.message || String(err));
  process.exitCode = 1;
});
