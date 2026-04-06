import "dotenv/config";
import { redis } from "./lib/redis.js";

const OLD_SHARDS = "abcdefghijklmnopqrstuvwxyz_".split("");
const LAST_CHECK_HASH_PREFIX = "scrape:lastChecks";

/**
 * Get current month key for time-based sharding
 */
function getCurrentMonthKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${LAST_CHECK_HASH_PREFIX}:${year}-${month}`;
}

/**
 * Get all fields from an old shard
 */
async function getShardData(shard) {
  const hashKey = `${LAST_CHECK_HASH_PREFIX}:${shard}`;
  try {
    const data = await redis.hgetall(hashKey);
    return data || {};
  } catch {
    return {};
  }
}

/**
 * Migrate data from old shards to new time-based format
 */
async function migrate() {
  console.log("🔄 Migrating to Time-Based Sharding");
  console.log("=====================================\n");

  const targetKey = getCurrentMonthKey();
  console.log(`Target: ${targetKey}`);

  let totalMigrated = 0;
  let totalDeleted = 0;
  let emptyShards = 0;

  for (const shard of OLD_SHARDS) {
    const oldKey = `${LAST_CHECK_HASH_PREFIX}:${shard}`;
    const data = await getShardData(shard);

    const entries = Object.entries(data);
    if (entries.length === 0) {
      emptyShards++;
      continue;
    }

    console.log(`\n📦 Shard '${shard}': ${entries.length} entries`);

    // Migrate to new format
    const fields = Object.fromEntries(entries);
    await redis.hset(targetKey, fields);
    totalMigrated += entries.length;

    // Delete old shard
    await redis.del(oldKey);
    totalDeleted++;

    console.log(`   ✅ Migrated to ${targetKey}`);
  }

  console.log("\n📊 Migration Results");
  console.log("====================");
  console.log(`Total migrated: ${totalMigrated} entries`);
  console.log(`Old shards deleted: ${totalDeleted}`);
  console.log(`Empty shards skipped: ${emptyShards}`);
  console.log(`New format: ${targetKey}`);

  // Verify
  const newCount = await redis.hlen(targetKey);
  console.log(`\n✅ Verification: ${newCount} entries in new hash`);
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
