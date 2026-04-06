import "dotenv/config";
import { redis } from "./lib/redis.js";

/**
 * Redis Database Analyzer
 * Scans and analyzes all keys to provide optimization recommendations
 */

// Configuration
const SCAN_COUNT = 100;
const LARGE_KEY_THRESHOLD = 10000; // 10KB
const OLD_KEY_THRESHOLD_DAYS = 30;

// Results storage
const analysis = {
  keysByPattern: {},
  keysByType: {},
  largeKeys: [],
  oldKeys: [],
  potentiallyUnused: [],
  memoryEstimate: 0,
  totalKeys: 0,
  recommendations: [],
};

/**
 * Scan all keys in Redis
 */
async function scanAllKeys() {
  const keys = new Set();
  let cursor = 0;

  console.log("🔍 Scanning all Redis keys...");

  do {
    try {
      const result = await redis.scan(cursor, { count: SCAN_COUNT });

      // Handle different result formats
      let scannedKeys = [];
      if (Array.isArray(result)) {
        // Some Redis clients return [cursor, keys]
        scannedKeys = result[1] || [];
        cursor = result[0] ?? 0;
      } else if (result && typeof result === "object") {
        // Others return { cursor, keys }
        scannedKeys = result.keys || [];
        cursor = result.cursor ?? 0;
      }

      scannedKeys.forEach((key) => keys.add(key));

      if (keys.size % 1000 === 0) {
        process.stdout.write(`\r  Found ${keys.size} keys...`);
      }
    } catch (err) {
      console.error("\nScan error:", err.message);
      break;
    }
  } while (cursor !== 0);

  console.log(`\r  Total keys found: ${keys.size}`);
  return Array.from(keys);
}

/**
 * Get key information (type, size, ttl)
 */
async function analyzeKey(key) {
  try {
    const [type, ttl, memory] = await Promise.all([
      redis.type(key),
      redis.ttl(key),
      redis.memory("usage", key).catch(() => 0),
    ]);

    const size = await getKeySize(key, type);

    return {
      key,
      type,
      ttl,
      size,
      memory: memory || 0,
    };
  } catch (err) {
    return { key, type: "unknown", ttl: -1, size: 0, memory: 0 };
  }
}

/**
 * Get approximate size of key based on type
 */
async function getKeySize(key, type) {
  try {
    switch (type) {
    case "string": {
      const str = await redis.get(key);
      return str ? str.length : 0;
    }
    case "hash":
      return await redis.hlen(key);
    case "list":
      return await redis.llen(key);
    case "set":
      return await redis.scard(key);
    case "zset":
      return await redis.zcard(key);
    default:
      return 0;
    }
  } catch {
    return 0;
  }
}

/**
 * Categorize key by pattern
 */
function categorizeKey(key) {
  const patterns = [
    { pattern: /^scrape:lastChecks?:/, category: "lastCheck" },
    { pattern: /^manga:/, category: "manga" },
    { pattern: /^chapter:/, category: "chapter" },
    { pattern: /^source:/, category: "source" },
    { pattern: /^dispatch:/, category: "dispatch" },
    { pattern: /^status:/, category: "status" },
    { pattern: /^cron:/, category: "cron" },
    { pattern: /^whitelist:/, category: "whitelist" },
    { pattern: /^discord:/, category: "discord" },
    { pattern: /^health:/, category: "health" },
    { pattern: /^api:/, category: "api" },
    { pattern: /^cache:/, category: "cache" },
    { pattern: /^temp:/, category: "temp" },
  ];

  for (const { pattern, category } of patterns) {
    if (pattern.test(key)) return category;
  }

  return "other";
}

/**
 * Analyze all keys
 */
async function analyzeKeys(keys) {
  console.log("\n📊 Analyzing keys...");

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const info = await analyzeKey(key);

    // Categorize
    const category = categorizeKey(key);
    if (!analysis.keysByPattern[category]) {
      analysis.keysByPattern[category] = [];
    }
    analysis.keysByPattern[category].push(info);

    // By type
    if (!analysis.keysByType[info.type]) {
      analysis.keysByType[info.type] = 0;
    }
    analysis.keysByType[info.type]++;

    // Large keys
    if (info.size > LARGE_KEY_THRESHOLD || info.memory > 1024) {
      analysis.largeKeys.push(info);
    }

    // Old keys (TTL > 30 days or no TTL)
    if (info.ttl === -1 || info.ttl > OLD_KEY_THRESHOLD_DAYS * 86400) {
      analysis.oldKeys.push(info);
    }

    // Keys without TTL (potentially unused)
    if (info.ttl === -1 && info.type !== "hash") {
      analysis.potentiallyUnused.push(info);
    }

    analysis.memoryEstimate += info.memory;
    analysis.totalKeys++;

    if ((i + 1) % 100 === 0 || i === keys.length - 1) {
      process.stdout.write(`\r  Analyzed ${i + 1}/${keys.length} keys...`);
    }
  }

  console.log(`\r  Analyzed ${keys.length} keys ✓`);
}

/**
 * Generate recommendations
 */
function generateRecommendations() {
  const recs = [];

  // 1. Keys without TTL
  const noTtlCount = analysis.potentiallyUnused.length;
  if (noTtlCount > 10) {
    recs.push({
      priority: "HIGH",
      issue: `${noTtlCount} keys without TTL`,
      recommendation:
        "Add TTL to temporary keys to prevent memory leaks. Keys: scrape:lastCheck:*, temp:*, cache:*",
      impact: "Memory savings",
    });
  }

  // 2. Large keys
  if (analysis.largeKeys.length > 0) {
    recs.push({
      priority: "MEDIUM",
      issue: `${analysis.largeKeys.length} large keys (>10KB or >10k items)`,
      recommendation:
        "Consider sharding large hashes/lists. Use HSCAN instead of HGETALL.",
      impact: "Better performance",
      examples: analysis.largeKeys.slice(0, 5).map((k) => k.key),
    });
  }

  // 3. Old key patterns
  const oldKeyPatterns = Object.entries(analysis.keysByPattern).filter(
    ([cat, keys]) =>
      keys.some(
        (k) => k.key.includes("scrape:lastCheck:") && !k.key.includes("s:"),
      ),
  );
  if (oldKeyPatterns.length > 0) {
    recs.push({
      priority: "HIGH",
      issue: "Old format scrape:lastCheck: keys detected",
      recommendation:
        "Migrate to new format scrape:lastChecks:YYYY-MM (time-based). Run: node migrate-timebased.js",
      impact: "Better organization & scalability",
    });
  }

  // 4. Too many 'other' keys
  const otherCount = analysis.keysByPattern["other"]?.length || 0;
  if (otherCount > 50) {
    recs.push({
      priority: "LOW",
      issue: `${otherCount} uncategorized keys`,
      recommendation: "Review and categorize keys with proper prefixes",
      impact: "Better maintainability",
    });
  }

  // 5. String keys that could be hashes
  const stringCount = analysis.keysByType["string"] || 0;
  if (stringCount > 100) {
    recs.push({
      priority: "MEDIUM",
      issue: `${stringCount} string keys`,
      recommendation:
        "Consider consolidating related strings into hashes for better memory efficiency",
      impact: "Memory optimization",
    });
  }

  analysis.recommendations = recs;
}

/**
 * Print analysis report
 */
function printReport() {
  console.log("\n" + "=".repeat(60));
  console.log("📋 REDIS DATABASE ANALYSIS REPORT");
  console.log("=".repeat(60));

  // Summary
  console.log("\n📊 Summary:");
  console.log(`  Total Keys: ${analysis.totalKeys}`);
  console.log(
    `  Memory Estimate: ${(analysis.memoryEstimate / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log("  Keys by Type:", analysis.keysByType);

  // Keys by Pattern
  console.log("\n📁 Keys by Pattern:");
  const sortedPatterns = Object.entries(analysis.keysByPattern).sort(
    (a, b) => b[1].length - a[1].length,
  );

  for (const [category, keys] of sortedPatterns) {
    const totalSize = keys.reduce((sum, k) => sum + k.size, 0);
    const avgTtl =
      keys.reduce((sum, k) => sum + (k.ttl > 0 ? k.ttl : 0), 0) /
        keys.filter((k) => k.ttl > 0).length || 0;

    console.log(`\n  ${category}:`);
    console.log(`    Count: ${keys.length}`);
    console.log(`    Total Size: ${totalSize.toLocaleString()}`);
    if (avgTtl > 0) {
      console.log(`    Avg TTL: ${(avgTtl / 3600).toFixed(1)} hours`);
    }

    // Show sample keys
    const samples = keys.slice(0, 3).map((k) => k.key);
    samples.forEach((s) => console.log(`      - ${s.substring(0, 50)}`));
  }

  // Large Keys
  if (analysis.largeKeys.length > 0) {
    console.log("\n⚠️  Large Keys:");
    analysis.largeKeys
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .forEach((k) => {
        console.log(
          `  ${k.key.substring(0, 40)} | ${k.type} | ${k.size.toLocaleString()} items | ${(
            k.memory / 1024
          ).toFixed(2)} KB`,
        );
      });
  }

  // Recommendations
  console.log("\n💡 Recommendations:");
  if (analysis.recommendations.length === 0) {
    console.log("  ✅ No major issues found!");
  } else {
    analysis.recommendations.forEach((rec, i) => {
      const icon =
        rec.priority === "HIGH"
          ? "🔴"
          : rec.priority === "MEDIUM"
            ? "🟡"
            : "🟢";
      console.log(`\n  ${icon} [${rec.priority}] ${rec.issue}`);
      console.log(`     💭 ${rec.recommendation}`);
      console.log(`     📈 Impact: ${rec.impact}`);
      if (rec.examples) {
        console.log(`     🔍 Examples: ${rec.examples.join(", ")}`);
      }
    });
  }

  console.log("\n" + "=".repeat(60));
  console.log("Analysis complete!");
  console.log("=".repeat(60));
}

/**
 * Main function
 */
async function main() {
  console.log("🔧 Redis Database Analyzer");
  console.log("==========================\n");

  try {
    const keys = await scanAllKeys();
    await analyzeKeys(keys);
    generateRecommendations();
    printReport();
  } catch (err) {
    console.error("\n❌ Analysis failed:", err);
    process.exit(1);
  }

  process.exit(0);
}

main();
