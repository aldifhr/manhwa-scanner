import { runCronJob } from "./lib/cronRuntime.js";
import { redis } from "./lib/redis.js";
import { getLogger } from "./lib/logger.js";

const logger = getLogger({ scope: "test" });

async function main() {
  console.log("🚀 Running cron job locally...\n");

  const start = Date.now();

  try {
    const result = await runCronJob({
      redisClient: redis,
      logger,
    });

    const duration = ((Date.now() - start) / 1000).toFixed(2);

    console.log("\n✅ Cron completed in", duration + "s");
    console.log("Status Code:", result.statusCode);
    console.log("Body:", JSON.stringify(result.body, null, 2));
  } catch (err) {
    console.error("\n❌ Cron failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }

  process.exit(0);
}

main();
