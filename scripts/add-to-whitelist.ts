#!/usr/bin/env node
import "dotenv/config";
import { Redis } from "@upstash/redis";
import path from "path";
import fs from "fs";

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("Error: UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN harus di-set di .env");
  process.exit(1);
}

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Key constants
const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_INDEX_KEY = "whitelist:index";

function normalizeTitleKey(title: string) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSource(source: string) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "ikiru" || s.includes("ikiru")) return "ikiru";
  if (s === "shinigami" || s.includes("shinigami") || s === "shinigami_project" || s === "shinigami_mirror")
    return "shinigami";
  return "ikiru";
}

function normalizeSourceUrl(url: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
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
    const index: string[] = await redis.zrange(WHITELIST_INDEX_KEY, 0, -1);
    if (!index || index.length === 0) return [];

    const data: any[] = await redis.hmget(WHITELIST_DATA_KEY, ...index);
    const items: any[] = [];
    for (let i = 0; i < index.length; i++) {
      const raw = data[i];
      if (!raw) continue;
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        items.push(parsed);
      } catch (e: any) {
        console.warn(`Failed to parse entry ${index[i]}:`, e.message);
      }
    }
    return items;
  } catch (err: any) {
    console.error("Error loading whitelist:", err.message);
    return [];
  }
}

async function saveWhitelist(list: any[]) {
  const pipeline = redis.pipeline();

  const dataMap: Record<string, string> = {};
  const indexEntries: { score: number; member: string }[] = [];

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
  for (const entry of indexEntries) {
    pipeline.zadd(WHITELIST_INDEX_KEY, entry);
  }

  await pipeline.exec();
}

async function addWhitelistEntry(title: string, url: string | null = null, source = "ikiru") {
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

  const existingIndex = whitelist.findIndex(item => {
    if (item.title?.toLowerCase() === normalizedTitle.toLowerCase()) return true;
    if (normalizedUrl && item.sources?.some((s: any) =>
      normalizeSourceUrl(s.url || "") === normalizedUrl,
    )) return true;
    return false;
  });

  const titleKey = normalizeTitleKey(normalizedTitle);

  await redis.hset("manga:last_updates", {
    [titleKey]: new Date().toISOString(),
  });

  if (existingIndex !== -1) {
    const existing = whitelist[existingIndex];
    const hasSource = existing.sources?.some(
      (s: any) => normalizeSource(s.source) === effectiveSource &&
        (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl),
    );

    if (hasSource) {
      console.log(`⚠️  "${normalizedTitle}" sudah ada di whitelist dengan source yang sama`);
      return { status: "exists", whitelist };
    }

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

  whitelist.push({
    title: normalizedTitle,
    sources: [{ url: normalizedUrl, source: effectiveSource, mark: null }],
  });

  await saveWhitelist(whitelist);
  console.log(`✅ "${normalizedTitle}" berhasil ditambahkan!`);
  console.log(`📊 Total whitelist sekarang: ${whitelist.length} manga`);

  return { status: "added", whitelist };
}

function parseTitleFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/manga\/([^/]+)/);
    if (match) {
      return match[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }
  } catch {
    // ignore
  }
  return null;
}

async function addWhitelistEntryToList(whitelist: any[], title: string, url: string | null = null, source = "ikiru") {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Title required");

  const effectiveSource = normalizeSource(source);
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;

  const existingIndex = whitelist.findIndex(item => {
    if (item.title?.toLowerCase() === normalizedTitle.toLowerCase()) return true;
    if (normalizedUrl && item.sources?.some((s: any) =>
      normalizeSourceUrl(s.url || "") === normalizedUrl,
    )) return true;
    return false;
  });

  const titleKey = normalizeTitleKey(normalizedTitle);

  redis.hset("manga:last_updates", {
    [titleKey]: new Date().toISOString(),
  }).catch(() => {});

  if (existingIndex !== -1) {
    const existing = whitelist[existingIndex];
    const hasSource = existing.sources?.some(
      (s: any) => normalizeSource(s.source) === effectiveSource &&
        (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl),
    );

    if (hasSource) {
      return { status: "exists", whitelist };
    }

    existing.sources = existing.sources || [];
    existing.sources.push({
      url: normalizedUrl,
      source: effectiveSource,
      mark: null,
    });

    return { status: "updated", whitelist };
  }

  whitelist.push({
    title: normalizedTitle,
    sources: [{ url: normalizedUrl, source: effectiveSource, mark: null }],
  });

  return { status: "added", whitelist };
}

async function batchAddFromFile(filePath: string) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  console.log(`📁 Batch mode: ${lines.length} URLs from ${filePath}\n`);

  let whitelist = await loadWhitelist();
  console.log(`📊 Whitelist saat ini: ${whitelist.length} manga\n`);

  let added = 0;
  let exists = 0;
  let failed = 0;

  for (let i = 0; i < lines.length; i++) {
    const url = lines[i];
    const title = parseTitleFromUrl(url) || `Manga ${i + 1}`;

    console.log(`[${i + 1}/${lines.length}] ${title}`);
    console.log(`   URL: ${url}`);

    try {
      const result = await addWhitelistEntryToList(whitelist, title, url, "ikiru");
      if (result.status === "added") {
        added++;
        whitelist = result.whitelist;
        console.log("   ✅ Added");
      } else if (result.status === "exists") {
        exists++;
        console.log("   ⚠️  Already exists");
      } else {
        console.log(`   ℹ️  ${result.status}`);
      }
    } catch (err: any) {
      failed++;
      console.log(`   ❌ Failed: ${err.message}`);
    }
    console.log("");
  }

  if (added > 0) {
    console.log("💾 Saving whitelist to Redis...");
    await saveWhitelist(whitelist);
  }

  console.log("\n📊 Batch Summary:");
  console.log(`   Added:    ${added}`);
  console.log(`   Exists:   ${exists}`);
  console.log(`   Failed:   ${failed}`);
  console.log(`   Total:    ${lines.length}`);
  console.log(`   Final whitelist size: ${whitelist.length}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage:
  Single:  tsx scripts/add-to-whitelist.ts "Judul Manga" [URL] [source]
  Batch:   tsx scripts/add-to-whitelist.ts --file <path-to-urls.txt>

Arguments:
  title    - Judul manga (single mode)
  url      - URL manga (opsional)
  source   - Sumber: ikiru atau shinigami (default: ikiru)
  --file   - Batch mode: file dengan 1 URL per baris
`);
    process.exit(0);
  }

  if (args[0] === "--file") {
    if (!args[1]) {
      console.error("Error: --file membutuhkan path file");
      process.exit(1);
    }
    await batchAddFromFile(args[1]);
    process.exit(0);
  }

  const title = args[0];
  const url = args[1] || null;
  const source = args[2] || "ikiru";

  try {
    await addWhitelistEntry(title, url, source);
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ Error:", err.message);
    process.exit(1);
  }
}

main();
