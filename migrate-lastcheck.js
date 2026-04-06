import "dotenv/config";
import { redis } from "./lib/redis.js";

const OLD_PREFIX = "scrape:lastCheck:";
const NEW_PREFIX = "scrape:lastChecks:";

/**
 * Get hash shard from title key
 */
function getShard(titleKey) {
  const firstChar = titleKey?.charAt(0)?.toLowerCase() || "_";
  return /^[a-z]$/.test(firstChar) ? firstChar : "_";
}

/**
 * Scan all old lastCheck keys
 */
async function scanOldKeys() {
  const keys = [];
  let cursor = 0;

  do {
    const result = await redis.scan(cursor, {
      match: `${OLD_PREFIX}*`,
      count: 100,
    });

    // Debug: log the result structure
    console.log("Scan result type:", typeof result);
    console.log("Scan result:", JSON.stringify(result, null, 2));

    cursor = result?.cursor ?? 0;

    // Handle different result formats
    let scannedKeys = [];
    if (Array.isArray(result)) {
      // Some Redis clients return [cursor, keys]
      scannedKeys = result[1] || [];
      cursor = result[0] ?? 0;
    } else if (result && typeof result === "object") {
      // Others return { cursor, keys }
      scannedKeys = result.keys || [];
    }

    console.log(`Scanned ${scannedKeys.length} keys in this iteration`);

    // Filter out new hash-based keys (scrape:lastChecks: with 's')
    const oldKeys = scannedKeys.filter((k) => !k.includes(`${OLD_PREFIX}s`));
    keys.push(...oldKeys);
  } while (cursor !== 0);

  return keys;
}

/**
 * Migrate a single key to hash format
 */
async function migrateKey(oldKey) {
  try {
    // Extract title from old key
    const titleKey = oldKey.slice(OLD_PREFIX.length);
    if (!titleKey) return { status: "skipped", reason: "empty_title" };

    // Get value
    const value = await redis.get(oldKey);
    if (!value) {
      return { status: "skipped", reason: "no_value" };
    }

    // Determine target hash
    const shard = getShard(titleKey);
    const hashKey = `${NEW_PREFIX}${shard}`;

    // Set in hash
    await redis.hset(hashKey, { [titleKey]: value });

    // Delete old key
    await redis.del(oldKey);

    return { status: "migrated", shard };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * Main migration
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--execute");
  const batchSize =
    parseInt(args.find((a) => a.startsWith("--batch="))?.split("=")[1]) || 100;

  console.log("🔄 LastCheck Migration Tool");
  console.log("==========================");
  console.log(dryRun ? "🔍 DRY RUN MODE" : "⚡ EXECUTE MODE");
  console.log(`Batch size: ${batchSize}\n`);

  // Scan old keys
  console.log("Scanning old keys...");
  const oldKeys = await scanOldKeys();
  console.log(`Found ${oldKeys.length} old key-based entries\n`);

  if (oldKeys.length === 0) {
    console.log("✅ No old keys to migrate. Already clean!");
    process.exit(0);
  }

  // Show sample
  console.log("Sample keys:");
  oldKeys.slice(0, 5).forEach((k) => console.log(`  - ${k}`));
  if (oldKeys.length > 5) console.log(`  ... and ${oldKeys.length - 5} more\n`);

  if (dryRun) {
    console.log("🔍 Dry run complete. Add --execute to migrate.");
    process.exit(0);
  }

  // Migration
  console.log("🚀 Starting migration...\n");

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const shardStats = {};

  for (let i = 0; i < oldKeys.length; i += batchSize) {
    const batch = oldKeys.slice(i, i + batchSize);

    const results = await Promise.all(batch.map((key) => migrateKey(key)));

    results.forEach((r) => {
      if (r.status === "migrated") {
        migrated++;
        shardStats[r.shard] = (shardStats[r.shard] || 0) + 1;
      } else if (r.status === "skipped") {
        skipped++;
      } else {
        failed++;
      }
    });

    console.log(
      `  Progress: ${Math.min(i + batchSize, oldKeys.length)}/${oldKeys.length}`,
    );

    // Small delay between batches
    if (i + batchSize < oldKeys.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Results
  console.log("\n📊 Migration Results:");
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);

  console.log("\n📁 Per-shard distribution:");
  Object.entries(shardStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([shard, count]) => {
      console.log(`  Shard '${shard}': ${count} entries`);
    });

  console.log("\n✅ Migration complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
