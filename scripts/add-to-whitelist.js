#!/usr/bin/env node
/**
 * Script untuk menambah manga ke whitelist via Redis langsung
 * Usage: node scripts/add-to-whitelist.js "Judul Manga" [URL] [source]
 *
 * Examples:
 *   node scripts/add-to-whitelist.js "Nano Machine" "https://ikiru.to/nano-machine" ikiru
 *   node scripts/add-to-whitelist.js "Solo Leveling" "https://shinigami.id/manga/solo-leveling" shinigami_project
 *   node scripts/add-to-whitelist.js "Omniscient Reader" (tanpa URL, akan dicari manual)
 */

import dotenv from "dotenv";
import { createClient } from "@upstash/redis";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("Error: UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN harus di-set di .env");
  process.exit(1);
}

const redis = createClient({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Key constants (harus sama dengan di lib/redis.js)
const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_INDEX_KEY = "whitelist:index";

function normalizeTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "ikiru" || s.includes("ikiru")) return "ikiru";
  if (s === "shinigami" || s.includes("shinigami") || s === "shinigami_project")
    return "shinigami_project";
  return "ikiru"; // default
}

function normalizeSourceUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Remove trailing slashes and hash/tracking params
    u.hash = "";
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    u.searchParams.delete("ref");
    const normalized = u.toString().replace(/\/+$/, "");
    return normalized;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

async function loadWhitelist() {
  try {
    const index = await redis.zrange(WHITELIST_INDEX_KEY, 0, -1);
    if (!index || index.length === 0) return [];

    const data = await redis.hmget(WHITELIST_DATA_KEY, ...index);
    const items = [];
    for (let i = 0; i < index.length; i++) {
      const raw = data[i];
      if (!raw) continue;
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        items.push(parsed);
      } catch (e) {
        console.warn(`Failed to parse entry ${index[i]}:`, e.message);
      }
    }
    return items;
  } catch (err) {
    console.error("Error loading whitelist:", err.message);
    return [];
  }
}

async function saveWhitelist(list) {
  const pipeline = redis.pipeline();

  // Build hash data
  const dataMap = {};
  const indexEntries = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const titleKey = normalizeTitleKey(item.title);
    if (!titleKey) continue;

    dataMap[titleKey] = JSON.stringify(item);
    indexEntries.push({ score: i, member: titleKey });
  }

  if (Object.keys(dataMap).length > 0) {
    pipeline.hset(WHITELIST_DATA_KEY, dataMap);
  }

  pipeline.del(WHITELIST_INDEX_KEY);
  if (indexEntries.length > 0) {
    pipeline.zadd(WHITELIST_INDEX_KEY, ...indexEntries.flatMap(e => [e.score, e.member]));
  }

  await pipeline.exec();
}

async function addWhitelistEntry(title, url = null, source = "ikiru") {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    console.error("Error: Judul manga wajib diisi");
    process.exit(1);
  }

  const effectiveSource = normalizeSource(source);
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;

  console.log(`\n📚 Menambahkan: "${normalizedTitle}"`);
  console.log(`   URL: ${normalizedUrl || "(tidak ada)"}`);
  console.log(`   Sumber: ${effectiveSource}\n`);

  const whitelist = await loadWhitelist();
  console.log(`📊 Whitelist saat ini: ${whitelist.length} manga`);

  // Check if exists
  const existingIndex = whitelist.findIndex(item => {
    if (item.title?.toLowerCase() === normalizedTitle.toLowerCase()) return true;
    if (normalizedUrl && item.sources?.some(s =>
      normalizeSourceUrl(s.url || "") === normalizedUrl,
    )) return true;
    return false;
  });

  const titleKey = normalizeTitleKey(normalizedTitle);

  // Update last_updates
  await redis.hset("manga:last_updates", {
    [titleKey]: new Date().toISOString(),
  });

  if (existingIndex !== -1) {
    const existing = whitelist[existingIndex];
    const hasSource = existing.sources?.some(
      s => normalizeSource(s.source) === effectiveSource &&
        (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl),
    );

    if (hasSource) {
      console.log(`⚠️  "${normalizedTitle}" sudah ada di whitelist dengan source yang sama`);
      return { status: "exists", whitelist };
    }

    // Add new source to existing
    existing.sources = existing.sources || [];
    existing.sources.push({
      url: normalizedUrl,
      source: effectiveSource,
      mark: null,
    });

    await saveWhitelist(whitelist);
    console.log(`✅ "${normalizedTitle}" - ditambahkan source baru (${effectiveSource})`);
    return { status: "updated", whitelist };
  }

  // Add new entry
  whitelist.push({
    title: normalizedTitle,
    sources: [{ url: normalizedUrl, source: effectiveSource, mark: null }],
  });

  await saveWhitelist(whitelist);
  console.log(`✅ "${normalizedTitle}" berhasil ditambahkan!`);
  console.log(`📊 Total whitelist sekarang: ${whitelist.length} manga`);

  return { status: "added", whitelist };
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: node scripts/add-to-whitelist.js "Judul Manga" [URL] [source]

Arguments:
  title    - Judul manga (wajib)
  url      - URL manga (opsional)
  source   - Sumber: ikiru atau shinigami (default: ikiru)

Examples:
  node scripts/add-to-whitelist.js "Nano Machine"
  node scripts/add-to-whitelist.js "Nano Machine" "https://ikiru.to/nano-machine" ikiru
  node scripts/add-to-whitelist.js "Solo Leveling" "https://shinigami.id/manga/solo-leveling" shinigami
`);
    process.exit(0);
  }

  const title = args[0];
  const url = args[1] || null;
  const source = args[2] || "ikiru";

  try {
    await addWhitelistEntry(title, url, source);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Error:", err.message);
    process.exit(1);
  }
}

main();
