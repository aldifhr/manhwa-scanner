import { redis } from "../lib/redis.js";

async function runMigration() {
  console.log("🚀 Starting Mass Redis Migration...");

  // 1. Migration: user:progress:${userId}:${titleKey} -> user:progress_data:${userId}
  console.log("\n--- Part 1: User Progress ---");
  let cursor = "0";
  let progressCount = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "user:progress:*:*", count: 100 });
    cursor = nextCursor;

    if (keys.length > 0) {
      const values = await redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const val = values[i];
        if (!val) continue;

        const parts = key.split(":"); // user:progress:userId:titleKey
        const userId = parts[2];
        const titleKey = parts[3];

        if (userId && titleKey) {
          const hashKey = `user:progress_data:${userId}`;
          const indexKey = `user:progress_list:${userId}`;
          
          await Promise.all([
            redis.hset(hashKey, { [titleKey]: val }),
            redis.zadd(indexKey, { 
                score: val.timestamp ? new Date(val.timestamp).getTime() : Date.now(), 
                member: titleKey 
            }),
            redis.del(key)
          ]);
          progressCount++;
        }
      }
    }
  } while (cursor !== "0");
  console.log(`✅ Migrated ${progressCount} user progress keys.`);

  // 2. Migration: manga:last_update:${titleKey} -> manga:last_updates
  console.log("\n--- Part 2: Manga Timestamps ---");
  cursor = "0";
  let mangaCount = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "manga:last_update:*", count: 100 });
    cursor = nextCursor;

    if (keys.length > 0) {
      const values = await redis.mget(...keys);
      const hashUpdates = {};
      
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const val = values[i];
        if (!val) continue;

        const titleKey = key.replace("manga:last_update:", "");
        hashUpdates[titleKey] = val;
      }
      
      if (Object.keys(hashUpdates).length > 0) {
          await redis.hset("manga:last_updates", hashUpdates);
          await redis.del(...keys);
          mangaCount += Object.keys(hashUpdates).length;
      }
    }
  } while (cursor !== "0");
  console.log(`✅ Migrated ${mangaCount} manga update keys.`);

  console.log("\n✨ Migration Finished successfully!");
}

runMigration().catch(err => {
  console.error("❌ Migration Failed:", err);
  process.exit(1);
});
