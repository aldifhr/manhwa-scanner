import { redis } from "../lib/redis.js";

async function checkKeys() {
  console.log("--- Scanning Redis Keys ---");
  
  const patterns = [
    { p: "user:progress:*", type: "count" },
    { p: "user:progress_data:*", type: "hash" },
    { p: "user:progress_list:*", type: "zset" },
    { p: "user:follows:*", type: "set" },
    { p: "user:settings:*", type: "hash" },
    { p: "manga:last_update:*", type: "count" },
    { p: "manga:subscribers:*", type: "set" },
    { p: "manga:mutes:*", type: "set" },
    { p: "manga:last_updates", type: "hash_single" },
    { p: "manga:popularity_index", type: "zset_single" },
    { p: "whitelist:data", type: "hash_single" },
    { p: "whitelist:index", type: "zset_single" },
    { p: "chapter:*", type: "count" },
  ];

  const results = {};

  for (const item of patterns) {
    const { p, type } = item;
    
    if (type.endsWith("_single")) {
        try {
            if (type === "hash_single") results[p] = await redis.hlen(p);
            else if (type === "zset_single") results[p] = await redis.zcard(p);
        } catch { results[p] = 0; }
        continue;
    }

    let cursor = "0";
    let count = 0;
    let totalItems = 0;
    try {
      do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: p, count: 100 });
        count += keys.length;
        
        if (type !== "count") {
            for (const key of keys) {
                if (type === "hash") totalItems += await redis.hlen(key);
                else if (type === "zset") totalItems += await redis.zcard(key);
                else if (type === "set") totalItems += await redis.scard(key);
            }
        }

        cursor = nextCursor;
      } while (cursor !== "0" && count < 10000); // Safety limit
      
      results[p] = type === "count" ? count : `${count} keys (${totalItems} total items)`;
    } catch (err) {
      results[p] = `Error: ${err.message}`;
    }
  }

  console.table(results);

  console.log("\n--- Summary ---");
  console.log("Optimization Check:");
  if (results["whitelist:data"] > 0) {
      console.log(`✅ Whitelist is now stored in a Hash with ${results["whitelist:data"]} entries.`);
  }
}

checkKeys().catch(console.error);
