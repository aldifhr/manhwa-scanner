import "dotenv/config";
import { redis } from "./lib/redis.js";

const PATTERNS = [
  "scrape:lastCheck:*",      // Old format
  "scrape:lastChecks:*",     // New format
  "manga:*",
  "chapter:*",
  "source:*",
  "dispatch:*",
  "status:*",
  "cron:*",
  "whitelist:*",
  "discord:*",
  "health:*",
  "api:*",
];

async function checkPattern(pattern) {
  try {
    const keys = [];
    let cursor = 0;

    do {
      const result = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = result?.cursor || 0;
      if (result?.keys) {
        keys.push(...result.keys);
      }
    } while (cursor !== 0 && keys.length < 1000); // Limit to 1000 per pattern

    return keys;
  } catch (err) {
    return [];
  }
}

async function main() {
  console.log("🔍 Checking Redis Key Patterns\n");

  let totalOldFormat = 0;
  let totalNewFormat = 0;

  for (const pattern of PATTERNS) {
    const keys = await checkPattern(pattern);
    const count = keys.length;

    if (count > 0) {
      console.log(`${pattern}:`);
      console.log(`  Count: ${count}`);

      if (count > 0 && count <= 5) {
        keys.forEach(k => console.log(`    - ${k.substring(0, 60)}`));
      } else if (count > 5) {
        keys.slice(0, 3).forEach(k => console.log(`    - ${k.substring(0, 60)}`));
        console.log(`    ... and ${count - 3} more`);
      }

      // Track old vs new format
      if (pattern === "scrape:lastCheck:*") {
        totalOldFormat = count;
      } else if (pattern === "scrape:lastChecks:*") {
        totalNewFormat = count;
      }

      console.log("");
    }
  }

  // Recommendations
  console.log("💡 Recommendations:");

  if (totalOldFormat > 0) {
    console.log(`  🔴 ${totalOldFormat} old format keys detected`);
    console.log("     Run: node migrate-timebased.js");
  } else {
    console.log("  ✅ All keys use new format");
  }

  const total = totalOldFormat + totalNewFormat;
  if (total > 100) {
    console.log(`  🟡 Total ${total} lastCheck entries - consider cleanup if old`);
  }

  console.log("\n✅ Check complete!");
}

main().catch(console.error);
