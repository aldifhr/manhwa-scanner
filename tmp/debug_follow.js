import { redis } from "../lib/redis.js";
import { normalizeTitleKey } from "../lib/domain.js";

async function debug() {
  const title = "I Took over The Academy With a Single Sashimi Knife";
  const tk = normalizeTitleKey(title);
  console.log(`Title: ${title}`);
  console.log(`Normalized Key: "${tk}"`);

  const existsInWhitelist = await redis.hget("whitelist:data", tk);
  console.log(`Exists in whitelist:data: ${existsInWhitelist ? "YES" : "NO"}`);

  if (!existsInWhitelist) {
    // Check all keys in whitelist:data to see if there's a similar one
    const allKeys = await redis.hkeys("whitelist:data");
    const similar = allKeys.find(k => k.includes("sashimi") || k.includes("academy"));
    console.log(`Similar keys in whitelist:data:`, similar);
  }

  // Check user:follows:*
  let cursor = "0";
  const followKeys = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "user:follows:*", count: 100 });
    followKeys.push(...keys);
    cursor = nextCursor;
  } while (cursor !== "0");

  console.log(`Found ${followKeys.length} user:follows keys.`);
  for (const key of followKeys) {
    const members = await redis.smembers(key);
    if (members.includes(tk)) {
      console.log(`User ${key} follows ${tk}`);
    }
  }
}

debug();
