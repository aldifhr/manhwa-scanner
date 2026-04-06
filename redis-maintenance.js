import "dotenv/config";
import { redis } from "./lib/redis.js";

const MAINTENANCE_LOG_KEY = "maintenance:last_run";

/**
 * Add TTL to discord:button_payload keys
 */
async function fixButtonPayloadTTL() {
  console.log("\n🔧 Fixing discord:button_payload TTL...");

  try {
    const keys = await redis.keys("discord:button_payload:*");
    let fixed = 0;

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl === -1) { // No TTL set
        await redis.expire(key, 3600); // 1 hour TTL
        fixed++;
      }
    }

    console.log(`  ✅ Fixed ${fixed}/${keys.length} keys with 1-hour TTL`);
    return fixed;
  } catch (err) {
    console.error("  ❌ Error:", err.message);
    return 0;
  }
}

/**
 * Cleanup old dispatch:history entries
 */
async function cleanupDispatchHistory() {
  console.log("\n🧹 Cleaning up dispatch:history...");

  try {
    const count = await redis.hlen("dispatch:history");
    console.log(`  Current entries: ${count}`);

    if (count > 10000) {
      // Scan and remove old entries (> 7 days)
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      let cursor = 0;
      let deleted = 0;

      do {
        const result = await redis.hscan("dispatch:history", cursor, { count: 100 });
        cursor = result.cursor ?? 0;

        const toDelete = [];
        for (let i = 0; i < result.fieldValues.length; i += 2) {
          const field = result.fieldValues[i];
          const value = result.fieldValues[i + 1];
          const data = JSON.parse(value || "{}");

          if (data.expiresAt && data.expiresAt < cutoff) {
            toDelete.push(field);
          }
        }

        if (toDelete.length > 0) {
          await redis.hdel("dispatch:history", ...toDelete);
          deleted += toDelete.length;
        }
      } while (cursor !== 0);

      console.log(`  ✅ Deleted ${deleted} old entries`);
      return deleted;
    } else {
      console.log("  ✅ Size is reasonable, no cleanup needed");
      return 0;
    }
  } catch (err) {
    console.error("  ❌ Error:", err.message);
    return 0;
  }
}

/**
 * Rotate cron:logs (keep only last 7 days)
 */
async function rotateCronLogs() {
  console.log("\n📅 Rotating cron:logs...");

  try {
    const keys = await redis.keys("cron:stats:*");
    const today = new Date();
    const cutoff = new Date(today.getTime() - (7 * 24 * 60 * 60 * 1000));

    let deleted = 0;

    for (const key of keys) {
      const dateStr = key.split(":").pop();
      const keyDate = new Date(dateStr);

      if (keyDate < cutoff) {
        await redis.del(key);
        deleted++;
      }
    }

    console.log(`  ✅ Deleted ${deleted} old daily stats`);
    return deleted;
  } catch (err) {
    console.error("  ❌ Error:", err.message);
    return 0;
  }
}

/**
 * Log maintenance run
 */
async function logMaintenance(results) {
  try {
    const log = {
      timestamp: new Date().toISOString(),
      results,
    };
    await redis.set(MAINTENANCE_LOG_KEY, JSON.stringify(log));
  } catch (err) {
    // Ignore logging errors
  }
}

/**
 * Main maintenance function
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--execute");

  console.log("🔧 Redis Maintenance Tool");
  console.log("=========================");
  console.log(dryRun ? "🔍 DRY RUN MODE" : "⚡ EXECUTE MODE");
  console.log("");

  if (dryRun) {
    console.log("Add --execute to actually make changes\n");
  }

  const results = {
    buttonPayloadFixed: 0,
    dispatchCleaned: 0,
    cronLogsRotated: 0,
  };

  try {
    // Run maintenance tasks
    if (!dryRun) {
      results.buttonPayloadFixed = await fixButtonPayloadTTL();
      results.dispatchCleaned = await cleanupDispatchHistory();
      results.cronLogsRotated = await rotateCronLogs();
    } else {
      console.log("🔍 Would run:");
      console.log("  - Fix button_payload TTL");
      console.log("  - Cleanup dispatch:history");
      console.log("  - Rotate cron:logs");
    }

    // Log results
    if (!dryRun) {
      await logMaintenance(results);
    }

    // Summary
    console.log("\n📊 Maintenance Summary");
    console.log("======================");
    if (dryRun) {
      console.log("Run with --execute to see actual results");
    } else {
      console.log(`Button payloads fixed: ${results.buttonPayloadFixed}`);
      console.log(`Dispatch entries cleaned: ${results.dispatchCleaned}`);
      console.log(`Cron logs rotated: ${results.cronLogsRotated}`);
      console.log("\n✅ Maintenance complete!");
    }
  } catch (err) {
    console.error("\n❌ Maintenance failed:", err);
    process.exit(1);
  }

  process.exit(0);
}

main();
