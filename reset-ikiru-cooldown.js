import "dotenv/config";
import { redis } from "./lib/redis.js";
import { resetSourceCooldown } from "./lib/services/health.js";

async function main() {
  console.log("Resetting Ikiru cooldown...");

  try {
    const result = await resetSourceCooldown(redis, "ikiru");
    console.log("✅ Success! Ikiru cooldown reset:");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to reset cooldown:", err.message);
    process.exit(1);
  }
}

main();
