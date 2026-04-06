import "dotenv/config";
import { redis } from "./lib/redis.js";

const BUTTON_PAYLOAD_HASH_KEY = "discord:button_payload";
const BUTTON_PAYLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Migrate discord:button_payload from individual keys to hash structure
 */
async function migrateButtonPayloadToHash() {
  console.log("🔄 Migrating discord:button_payload to hash structure...");
  console.log("=====================================================\n");

  try {
    // Find all old format keys
    const oldKeys = await redis.keys("discord:button_payload:*");
    console.log(`Found ${oldKeys.length} old format keys`);

    if (oldKeys.length === 0) {
      console.log("✅ No old format keys to migrate");
      return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const oldKey of oldKeys) {
      try {
        // Extract the hash/id from the key
        const keyParts = oldKey.split(":");
        const fieldName = keyParts[keyParts.length - 1];

        // Get the value
        const value = await redis.get(oldKey);
        if (!value) {
          console.log(`  ⚠️  Empty value for ${oldKey}, skipping`);
          skipped++;
          continue;
        }

        // Parse and validate
        let parsedValue;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // If not JSON, store as string
          parsedValue = value;
        }

        // Add expiresAt if not present
        if (typeof parsedValue === "object" && !parsedValue.expiresAt) {
          parsedValue.expiresAt = Date.now() + BUTTON_PAYLOAD_TTL_MS;
        }

        // Set in hash
        await redis.hset(BUTTON_PAYLOAD_HASH_KEY, {
          [fieldName]: JSON.stringify(parsedValue),
        });

        // Add TTL to the field (Redis 7.4+)
        try {
          if (typeof redis.hpexpire === "function") {
            await redis.hpexpire(
              BUTTON_PAYLOAD_HASH_KEY,
              fieldName,
              BUTTON_PAYLOAD_TTL_MS,
            );
          } else if (typeof redis.hexpire === "function") {
            await redis.hexpire(
              BUTTON_PAYLOAD_HASH_KEY,
              Math.ceil(BUTTON_PAYLOAD_TTL_MS / 1000),
              "FIELDS",
              1,
              fieldName,
            );
          }
        } catch {
          // TTL not supported, will rely on cleanup job
        }

        // Delete old key
        await redis.del(oldKey);

        migrated++;
        console.log(`  ✅ Migrated: ${fieldName.substring(0, 20)}...`);
      } catch (err) {
        console.error(`  ❌ Error migrating ${oldKey}:`, err.message);
        skipped++;
      }
    }

    // Verify result
    const hashSize = await redis.hlen(BUTTON_PAYLOAD_HASH_KEY);
    console.log("\n📊 Migration Results");
    console.log("====================");
    console.log(`Migrated: ${migrated} entries`);
    console.log(`Skipped: ${skipped} entries`);
    console.log(`New hash size: ${hashSize} fields`);

    return { migrated, skipped };
  } catch (err) {
    console.error("\n❌ Migration failed:", err);
    throw err;
  }
}

/**
 * Helper function to set button payload with TTL (for future use)
 */
export async function setButtonPayload(payloadId, data, ttlMs = BUTTON_PAYLOAD_TTL_MS) {
  const value =
    typeof data === "object" ? JSON.stringify(data) : String(data);

  // Set in hash
  await redis.hset(BUTTON_PAYLOAD_HASH_KEY, { [payloadId]: value });

  // Add TTL
  try {
    if (typeof redis.hpexpire === "function") {
      await redis.hpexpire(BUTTON_PAYLOAD_HASH_KEY, payloadId, ttlMs);
    } else if (typeof redis.hexpire === "function") {
      await redis.hexpire(
        BUTTON_PAYLOAD_HASH_KEY,
        Math.ceil(ttlMs / 1000),
        "FIELDS",
        1,
        payloadId,
      );
    }
  } catch {
    // TTL not supported
  }

  return true;
}

/**
 * Helper function to get button payload
 */
export async function getButtonPayload(payloadId) {
  try {
    const value = await redis.hget(BUTTON_PAYLOAD_HASH_KEY, payloadId);
    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } catch {
    return null;
  }
}

/**
 * Helper function to delete button payload
 */
export async function deleteButtonPayload(payloadId) {
  return await redis.hdel(BUTTON_PAYLOAD_HASH_KEY, payloadId);
}

/**
 * Cleanup expired entries from hash (for Redis < 7.4)
 */
async function cleanupExpiredButtonPayloads() {
  console.log("\n🧹 Cleaning up expired button payloads...");

  try {
    const now = Date.now();
    let cursor = 0;
    let deleted = 0;

    do {
      const result = await redis.hscan(BUTTON_PAYLOAD_HASH_KEY, cursor, {
        count: 100,
      });

      let fieldValues = [];
      if (Array.isArray(result)) {
        cursor = parseInt(result[0]) || 0;
        fieldValues = result[1] || [];
      } else {
        cursor = result?.cursor ?? 0;
        fieldValues = result?.fieldValues || [];
      }

      const toDelete = [];
      for (let i = 0; i < fieldValues.length; i += 2) {
        const field = fieldValues[i];
        const value = fieldValues[i + 1];

        try {
          const parsed = JSON.parse(value);
          if (parsed.expiresAt && parsed.expiresAt < now) {
            toDelete.push(field);
          }
        } catch {
          // Invalid JSON, mark for deletion
          toDelete.push(field);
        }
      }

      if (toDelete.length > 0) {
        await redis.hdel(BUTTON_PAYLOAD_HASH_KEY, ...toDelete);
        deleted += toDelete.length;
      }
    } while (cursor !== 0);

    console.log(`  ✅ Deleted ${deleted} expired entries`);
    return deleted;
  } catch (err) {
    console.error("  ❌ Cleanup error:", err.message);
    return 0;
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--execute");

  console.log("🔧 Button Payload Migration Tool");
  console.log("=================================");
  console.log(dryRun ? "🔍 DRY RUN MODE" : "⚡ EXECUTE MODE");
  console.log("");

  try {
    if (dryRun) {
      // Just check what would be migrated
      const keys = await redis.keys("discord:button_payload:*");
      console.log(`Would migrate ${keys.length} keys to hash structure`);
      console.log("Sample keys:");
      keys.slice(0, 5).forEach((k) => console.log(`  - ${k}`));
      console.log("\nRun with --execute to perform migration");
      process.exit(0);
    }

    // Perform migration
    const result = await migrateButtonPayloadToHash();

    // Cleanup any expired entries in the new hash
    await cleanupExpiredButtonPayloads();

    console.log("\n✅ Migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Fatal error:", err);
    process.exit(1);
  }
}

main();
