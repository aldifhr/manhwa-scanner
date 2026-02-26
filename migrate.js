// migrate.js
import { Redis } from "@upstash/redis";
import dotenv from "dotenv";
dotenv.config();

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CHAPTER_TTL = 60 * 60 * 24 * 3; // 3 hari

async function migrate() {
  console.log("🔍 Scanning chapter keys...");
  const keys = await redis.keys("chapter:*");
  console.log(`📦 Found ${keys.length} keys`);

  let fixed   = 0;
  let skipped = 0;

  for (const key of keys) {
    const ttl = await redis.ttl(key);

    if (ttl === -1) {
      // -1 berarti tidak ada TTL sama sekali
      await redis.expire(key, CHAPTER_TTL);
      console.log(`✅ Set TTL: ${key}`);
      fixed++;
    } else {
      // Sudah punya TTL, skip
      skipped++;
    }
  }

  console.log(`\n📊 Done — fixed: ${fixed}, skipped: ${skipped}`);
}

migrate().catch(console.error);
