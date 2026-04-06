// Migration script: Add TTL to all fields in dispatch:history
// Usage: node migrate-dispatch-history-ttl.js [--dry-run] [--batch-size=100]

import { Redis } from "@upstash/redis";
import { DISPATCH_HISTORY_KEY } from "./lib/services/dispatch.js";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = parseInt(process.argv.find(arg => arg.startsWith("--batch-size="))?.split("=")[1] || "100", 10);
const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days default

function createRedisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set");
  }
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function migrateDispatchHistoryTTL(redis) {
  console.log("🔧 Starting dispatch:history TTL migration...");
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log();

  let cursor = 0;
  let processed = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  const startTime = Date.now();

  do {
    try {
      // Scan batch of fields
      const result = await redis.hscan(DISPATCH_HISTORY_KEY, cursor, { count: BATCH_SIZE });

      // Handle Upstash Redis array format: [cursor, [key, value, key, value, ...]]
      let fieldValues = [];
      if (Array.isArray(result)) {
        cursor = parseInt(result[0]) || 0;
        fieldValues = result[1] || [];
      } else {
        cursor = result?.cursor ?? 0;
        fieldValues = result?.fieldValues || [];
      }

      if (!fieldValues || fieldValues.length === 0) {
        continue;
      }

      // Process each field in the batch
      for (let i = 0; i < fieldValues.length; i += 2) {
        const field = fieldValues[i];
        const value = fieldValues[i + 1];
        processed++;

        try {
          // Parse the value to get expiresAt
          let expiresAt = null;
          try {
            const parsed = typeof value === "string" ? JSON.parse(value) : value;
            expiresAt = parsed?.expiresAt;
          } catch (parseErr) {
            console.warn(`   ⚠️ Could not parse value for ${field}, using default TTL`);
          }

          // Calculate TTL
          let ttlMs;
          if (expiresAt) {
            ttlMs = expiresAt - Date.now();
            if (ttlMs <= 0) {
              // Already expired, set minimum TTL or skip
              ttlMs = 60000; // 1 minute minimum
            }
          } else {
            // No expiresAt, use default TTL
            ttlMs = DEFAULT_TTL_SEC * 1000;
          }

          if (DRY_RUN) {
            console.log(`   [DRY RUN] Would set TTL for ${field}: ${Math.ceil(ttlMs / 1000)}s`);
            success++;
            continue;
          }

          // Set TTL using HPEXPIRE (Redis 7.4+) or HEXPIRE
          let ttlSet = false;
          try {
            if (typeof redis.hpexpire === "function") {
              await redis.hpexpire(DISPATCH_HISTORY_KEY, field, ttlMs);
              ttlSet = true;
            } else if (typeof redis.hexpire === "function") {
              await redis.hexpire(DISPATCH_HISTORY_KEY, Math.ceil(ttlMs / 1000), "FIELDS", 1, field);
              ttlSet = true;
            } else {
              skipped++;
              if (processed % 100 === 0) {
                console.log("   ⚠️ Redis does not support HPEXPIRE/HEXPIRE, skipping TTL");
              }
            }
          } catch (ttlErr) {
            // TTL not supported or failed, skip
            skipped++;
            if (processed % 100 === 0) {
              console.log(`   ⚠️ Could not set TTL for ${field}: ${ttlErr.message}`);
            }
          }

          if (ttlSet) {
            success++;
          }

          // Show progress every 100 items
          if (processed % 100 === 0) {
            console.log(`   Progress: ${processed} processed, ${success} success, ${failed} failed, ${skipped} skipped`);
          }

        } catch (fieldErr) {
          failed++;
          errors.push({ field, error: fieldErr.message });
          console.error(`   ❌ Error processing ${field}: ${fieldErr.message}`);
        }
      }

    } catch (scanErr) {
      console.error(`❌ Error scanning at cursor ${cursor}: ${scanErr.message}`);
      // Try to continue with next cursor
      cursor = cursor + BATCH_SIZE;
    }

  } while (cursor !== 0);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log();
  console.log("✅ Migration completed!");
  console.log(`   Duration: ${duration}s`);
  console.log(`   Total processed: ${processed}`);
  console.log(`   Success: ${success}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Skipped (no TTL support): ${skipped}`);

  if (errors.length > 0 && errors.length <= 10) {
    console.log();
    console.log("Errors:");
    errors.forEach(({ field, error }) => {
      console.log(`   - ${field}: ${error}`);
    });
  } else if (errors.length > 10) {
    console.log();
    console.log(`Errors: ${errors.length} total (showing first 10)`);
    errors.slice(0, 10).forEach(({ field, error }) => {
      console.log(`   - ${field}: ${error}`);
    });
  }
}

async function main() {
  try {
    const redis = createRedisClient();

    // Test connection
    await redis.ping();
    console.log("✅ Connected to Redis");
    console.log();

    await migrateDispatchHistoryTTL(redis);

    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
