import { redis } from "../lib/redis.js";

async function cleanup() {
  console.log("Starting health cache cleanup...");

  const keys = [
    "health:broken-links",
    "health:recommendations",
    "health:stats:data",
  ];

  try {
    const result = await redis.del(...keys);
    console.log(`Successfully cleared ${result} health keys.`);
    console.log("Dashboard health section will now be fresh on next check.");
  } catch (err) {
    console.error("Failed to clear health cache:", err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

cleanup();
