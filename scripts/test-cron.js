import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, ".env") });

import { runCronJob } from "../lib/cronRuntime.js";
import { redis } from "../lib/redis.js";

const logger = {
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ""),
};

async function test() {
  console.log("Clearing Redis caches...\n");
  await redis.del("dispatch:history");

  const shiniKeys = await redis.keys("shinigami:*");
  if (shiniKeys.length) await redis.del(...shiniKeys);

  const ikiruKeys = await redis.keys("ikiru:latest:page:*");
  if (ikiruKeys.length) await redis.del(...ikiruKeys);

  console.log("Running cron job...\n");

  try {
    const result = await runCronJob({ dryRun: false, logger });

    console.log("\n=== RESULTS ===");
    console.log(`Sent: ${result.data.sent}`);
    console.log(`Skipped: ${result.data.skipped}`);
    console.log(`Failed: ${result.data.failed}`);

    if (result.data.sent > 0 || result.data.skipped > 0) {
      console.log("\nScrape metrics:");
      console.log(JSON.stringify(result.data.scrapeMetrics, null, 2));
    }

    // Check dispatch history
    const allHistory = await redis.hgetall("dispatch:history");
    const sichuanKeys = Object.keys(allHistory).filter(k =>
      k.toLowerCase().includes("sichuan") || k.includes("8016654b"),
    );

    console.log("\n=== SICHUAN DISPATCH HISTORY ===");
    console.log(`Found ${sichuanKeys.length} entries`);
    for (const key of sichuanKeys) {
      console.log(`\n${key}:`);
      try {
        console.log(JSON.stringify(JSON.parse(allHistory[key]), null, 2));
      } catch {
        console.log(allHistory[key]);
      }
    }

  } catch (err) {
    console.error("Error:", err.message);
  }

  process.exit(0);
}

test().catch((err) => {
  console.error(err);
  process.exit(1);
});
