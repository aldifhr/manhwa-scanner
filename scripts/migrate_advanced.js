import { redis } from "../lib/redis.js";
import { normalizeTitleKey } from "../lib/domain.js";

async function runAdvancedMigration() {
  console.log("🚀 Starting Advanced Redis Migration & Feature Initialization...");

  // 1. Whitelist Refactor (Handled by Lazy Migration in redis.js, but we'll do it explicitly here for completeness)
  console.log("\n--- Part 1: Whitelist Storage ---");
  const LEGACY_WHITELIST_KEY = "whitelist:manga";
  const rawLegacy = await redis.get(LEGACY_WHITELIST_KEY);
  
  if (rawLegacy && Array.isArray(rawLegacy)) {
      console.log(`Found legacy whitelist with ${rawLegacy.length} items. Migrating...`);
      // Simpan menggunakan saveWhitelist yang sudah diperbarui di lib/redis.js
      const { saveWhitelist } = await import("../lib/redis.js");
      await saveWhitelist(rawLegacy);
      console.log("✅ Whitelist migrated successfully.");
  } else {
      console.log("ℹ️ No legacy whitelist found or already migrated.");
  }

  // 2. Popularity Index Initialization
  console.log("\n--- Part 2: Manga Popularity Index ---");
  let cursor = "0";
  let count = 0;
  let totalSubs = 0;
  
  // SCAN manga:subscribers:*
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "manga:subscribers:*", count: 100 });
    cursor = nextCursor;

    if (keys.length > 0) {
      const p = keys.map(async (key) => {
        const titleKey = key.replace("manga:subscribers:", "");
        const subsCount = await redis.scard(key);
        if (subsCount > 0) {
          await redis.zadd("manga:popularity_index", { score: subsCount, member: titleKey });
          totalSubs += subsCount;
          count++;
        }
      });
      await Promise.all(p);
    }
  } while (cursor !== "0");

  console.log(`✅ Initialized popularity index for ${count} mangas (total followers: ${totalSubs}).`);

  console.log("\n✨ Advanced Migration Finished successfully!");
}

runAdvancedMigration().catch(err => {
  console.error("❌ Advanced Migration Failed:", err);
  process.exit(1);
});
