import { redis } from "../lib/redis.js";

async function debugWhitelist() {
  console.log("--- Debugging Whitelist ---");
  
  const INDEX_KEY = "whitelist:index";
  const DATA_KEY = "whitelist:data";
  const LEGACY_KEY = "whitelist:manga";

  const [index, legacy, dataSize] = await Promise.all([
    redis.zrange(INDEX_KEY, 0, -1),
    redis.get(LEGACY_KEY),
    redis.hlen(DATA_KEY)
  ]);

  console.log(`Index count: ${index.length}`);
  console.log(`Data hash size: ${dataSize}`);
  console.log(`Legacy key exists: ${!!legacy}`);

  if (index.length > 0) {
    console.log("Sample index members:", index.slice(0, 5));
    const sampleData = await redis.hmget(DATA_KEY, ...index.slice(0, 5));
    console.log("Sample data from Hash:", sampleData);
    
    const nullCount = sampleData.filter(x => x === null).length;
    console.log(`Nulls in sample: ${nullCount}`);
  }
}

debugWhitelist().catch(console.error);
