#!/usr/bin/env node
/**
 * Whitelist Check & Rebuild Script
 * Checks and fixes whitelist data/index consistency
 *
 * Usage: node scripts/check-whitelist.js [--fix]
 */

import dotenv from "dotenv";
dotenv.config();

import { redis } from "../lib/redis.js";

const WHITELIST_INDEX_KEY = "whitelist:index";
const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_KEY_LEGACY = "whitelist";

async function checkWhitelist() {
  console.log("🔍 Checking whitelist data...\n");

  // 1. Check legacy format
  console.log("1️⃣  Checking legacy format...");
  const legacyRaw = await redis.get(WHITELIST_KEY_LEGACY);
  if (legacyRaw) {
    try {
      const legacyData = JSON.parse(legacyRaw);
      console.log(`   ✅ Legacy data found: ${legacyData.length} items`);
    } catch {
      console.log("   ⚠️  Legacy data exists but invalid format");
    }
  } else {
    console.log("   ❌ No legacy data");
  }

  // 2. Check new format - index
  console.log("\n2️⃣  Checking new format index...");
  const index = await redis.zrange(WHITELIST_INDEX_KEY, 0, -1);
  console.log(`   Index entries: ${index.length}`);
  if (index.length > 0) {
    console.log(`   Sample keys: ${index.slice(0, 5).join(", ")}${index.length > 5 ? "..." : ""}`);
  }

  // 3. Check new format - data hash
  console.log("\n3️⃣  Checking new format data...");
  const allData = await redis.hgetall(WHITELIST_DATA_KEY);
  const dataKeys = Object.keys(allData);
  console.log(`   Data entries: ${dataKeys.length}`);
  if (dataKeys.length > 0) {
    console.log(`   Sample keys: ${dataKeys.slice(0, 5).join(", ")}${dataKeys.length > 5 ? "..." : ""}`);

    // Show sample data
    try {
      const sample = JSON.parse(allData[dataKeys[0]]);
      console.log(`   Sample entry: ${sample.title || "N/A"}`);
    } catch {
      console.log(`   Sample entry format: ${typeof allData[dataKeys[0]]}`);
    }
  }

  // 4. Compare index vs data
  console.log("\n4️⃣  Comparing index vs data...");
  const indexSet = new Set(index);
  const dataSet = new Set(dataKeys);

  const inIndexNotData = [...indexSet].filter(k => !dataSet.has(k));
  const inDataNotIndex = [...dataSet].filter(k => !indexSet.has(k));

  if (inIndexNotData.length > 0) {
    console.log(`   ⚠️  Keys in index but not in data: ${inIndexNotData.length}`);
    console.log(`      ${inIndexNotData.slice(0, 3).join(", ")}${inIndexNotData.length > 3 ? "..." : ""}`);
  }

  if (inDataNotIndex.length > 0) {
    console.log(`   ⚠️  Keys in data but not in index: ${inDataNotIndex.length}`);
    console.log(`      ${inDataNotIndex.slice(0, 3).join(", ")}${inDataNotIndex.length > 3 ? "..." : ""}`);
  }

  if (inIndexNotData.length === 0 && inDataNotIndex.length === 0) {
    console.log("   ✅ Index and data are synchronized");
  }

  // 5. Summary
  console.log("\n📊 Summary:");
  console.log(`   Legacy: ${legacyRaw ? "EXISTS" : "none"}`);
  console.log(`   Index: ${index.length} entries`);
  console.log(`   Data: ${dataKeys.length} entries`);

  if (index.length === 0 && dataKeys.length > 0) {
    console.log("\n   🔴 PROBLEM: Data exists but index is empty!");
    console.log("      /list will show 'Whitelist kosong.'");
    return { needsFix: true, missingFromIndex: [...dataSet] };
  }

  if (inDataNotIndex.length > 0) {
    console.log(`\n   🟡 WARNING: ${inDataNotIndex.length} items in data but missing from index`);
    return { needsFix: true, missingFromIndex: inDataNotIndex };
  }

  return { needsFix: false, missingFromIndex: [] };
}

async function fixWhitelist(missingKeys) {
  console.log(`\n🔧 Fixing ${missingKeys.length} missing index entries...\n`);

  let added = 0;
  let failed = 0;

  for (const key of missingKeys) {
    try {
      // Add to index with score (timestamp or just 0)
      await redis.zadd(WHITELIST_INDEX_KEY, { score: Date.now(), member: key });
      added++;
      process.stdout.write(`   ✅ Added: ${key.substring(0, 40)}\r`);
    } catch (err) {
      failed++;
      console.error(`\n   ❌ Failed to add ${key}: ${err.message}`);
    }
  }

  console.log("\n\n🎉 Fix complete!");
  console.log(`   Added: ${added}`);
  console.log(`   Failed: ${failed}`);

  // Verify
  const newIndex = await redis.zrange(WHITELIST_INDEX_KEY, 0, -1);
  console.log(`\n📊 New index count: ${newIndex.length}`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const shouldFix = args.includes("--fix") || args.includes("-f");

  console.log("═══════════════════════════════════════");
  console.log("   Whitelist Check & Fix Tool");
  console.log("═══════════════════════════════════════\n");

  const result = await checkWhitelist();

  if (result.needsFix) {
    if (shouldFix) {
      await fixWhitelist(result.missingFromIndex);
      console.log("\n🔄 Re-checking...");
      await checkWhitelist();
    } else {
      console.log("\n⚠️  Issues found! Run with --fix to repair:");
      console.log("   node scripts/check-whitelist.js --fix");
    }
  } else {
    console.log("\n✅ No issues found! Whitelist is healthy.");
  }

  console.log("\n═══════════════════════════════════════");
  process.exit(0);
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
