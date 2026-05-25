import "dotenv/config";
import { Redis } from "@upstash/redis";
import { normalizeTitleKey, normalizeWhitelist } from "../lib/domain.js";

const WHITELIST_INDEX_KEY = "whitelist:index";
const WHITELIST_DATA_KEY = "whitelist:data";
const WHITELIST_KEY_LEGACY = "whitelist:manga";

async function repairWhitelist() {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  const redis = new Redis({ url, token });

  console.log("🔍 Reading all data from whitelist:data...");
  const rawAll = await redis.hgetall(WHITELIST_DATA_KEY);

  if (!rawAll || Object.keys(rawAll).length === 0) {
    console.log("❌ whitelist:data is empty, nothing to repair");
    return;
  }

  const entries: any[] = [];
  for (const [key, val] of Object.entries(rawAll)) {
    try {
      const parsed = typeof val === "string" ? JSON.parse(val) : val;
      if (parsed?.title) {
        entries.push(parsed);
        console.log(`  ✅ Found: ${parsed.title}`);
      }
    } catch {
      console.warn(`  ⚠️ Failed to parse key: ${key}`);
    }
  }

  console.log(`\n📊 Total entries found in data: ${entries.length}`);
  console.log("🔧 Rebuilding whitelist:data and whitelist:index...\n");

  const normalized = normalizeWhitelist(entries);
  const dataMap: Record<string, string> = {};
  const indexEntries: { score: number; member: string }[] = [];

  normalized.forEach((item, i) => {
    const tk = normalizeTitleKey(item.title);
    if (!tk) return;
    dataMap[tk] = JSON.stringify(item);
    indexEntries.push({ score: i, member: tk });
    console.log(`  ${i + 1}. ${item.title} (key: ${tk})`);
  });

  // Save data
  await redis.hset(WHITELIST_DATA_KEY, dataMap);

  // Rebuild index from scratch
  await redis.del(WHITELIST_INDEX_KEY);
  if (indexEntries.length > 0) {
    // Correctly call zadd with the first element and then the rest spread
    await redis.zadd(WHITELIST_INDEX_KEY, indexEntries[0], ...indexEntries.slice(1));
  }

  // Clean up legacy
  await redis.del(WHITELIST_KEY_LEGACY);

  // Verify
  const newIndexLen = await redis.zcard(WHITELIST_INDEX_KEY);
  console.log(`\n✅ Repair complete!`);
  console.log(`   whitelist:data → ${Object.keys(dataMap).length} entries`);
  console.log(`   whitelist:index → ${newIndexLen} entries`);
}

repairWhitelist().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
