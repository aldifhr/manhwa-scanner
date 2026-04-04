import { redis } from "../lib/redis.js";

async function run() {
  const index = await redis.zrange("whitelist:index", 0, -1);
  const data = await redis.hmget("whitelist:data", ...index);
  
  let list = [];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    list = Object.values(data).filter(Boolean);
  } else if (Array.isArray(data)) {
    list = data.filter(Boolean);
  }
  
  const matches = list.filter(m => m.title.toLowerCase().includes("sashimi"));
  console.log("Found matches:", JSON.stringify(matches, null, 2));
  process.exit(0);
}

run().catch(console.error);
