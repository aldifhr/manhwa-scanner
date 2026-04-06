import "dotenv/config";
import { redis } from "./lib/redis.js";

const KEY_PATTERNS = [
  "scrape:lastChecks:*",
  "manga:*",
  "chapter:*",
  "source:*",
  "dispatch:*",
  "status:*",
  "cron:*",
  "whitelist:*",
  "discord:*",
  "api:*",
  "cache:*",
];

async function quickCheck() {
  console.log("⚡ Quick Redis Check");
  console.log("===================\n");

  const results = [];

  for (const pattern of KEY_PATTERNS) {
    try {
      // Use scan with limited count for each pattern
      const keys = [];
      let cursor = 0;
      let iterations = 0;
      const maxIterations = 10; // Limit to prevent hanging

      do {
        const result = await redis.scan(cursor, {
          match: pattern,
          count: 100,
        });

        // Handle result format
        if (Array.isArray(result)) {
          cursor = result[0] ?? 0;
          keys.push(...(result[1] || []));
        } else if (result && typeof result === "object") {
          cursor = result.cursor ?? 0;
          keys.push(...(result.keys || []));
        }

        iterations++;
        if (iterations >= maxIterations) break;
      } while (cursor !== 0);

      // Get details for first 5 keys
      const details = [];
      for (const key of keys.slice(0, 5)) {
        try {
          const type = await redis.type(key);
          const size =
            type === "hash"
              ? await redis.hlen(key)
              : type === "string"
                ? (await redis.get(key))?.length || 0
                : 0;
          const ttl = await redis.ttl(key);
          details.push({ key: key.substring(0, 40), type, size, ttl });
        } catch (e) {
          details.push({ key: key.substring(0, 40), error: true });
        }
      }

      results.push({
        pattern,
        count: keys.length,
        details,
      });
    } catch (err) {
      results.push({
        pattern,
        count: 0,
        error: err.message,
      });
    }
  }

  // Print results
  console.log("📊 Results:\n");

  let totalKeys = 0;

  for (const r of results) {
    totalKeys += r.count;
    const status = r.error ? "❌" : r.count > 0 ? "📦" : "📭";

    console.log(`${status} ${r.pattern}`);
    console.log(`   Count: ${r.count}`);

    if (r.details && r.details.length > 0) {
      console.log("   Samples:");
      r.details.forEach((d) => {
        const ttlStr =
          d.ttl > 0
            ? `${Math.round(d.ttl / 3600)}h`
            : d.ttl === -1
              ? "no TTL"
              : "expired";
        const sizeStr = d.size ? `(${d.size})` : "";
        console.log(
          `      - ${d.key} ${d.type || ""} ${sizeStr} ${ttlStr}`,
        );
      });
    }

    if (r.error) {
      console.log(`   Error: ${r.error}`);
    }

    console.log("");
  }

  console.log(`\n📈 Total keys found: ${totalKeys}`);
  console.log("\n✅ Quick check complete!");
}

quickCheck().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
