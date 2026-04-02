import "dotenv/config";
import { searchIkiru } from "../lib/scrapers/ikiru.js";
import { searchShngm } from "../lib/scrapers/secondary.js";
import { scrapeMangaUpdates } from "../lib/scrapers/orchestrator.js";
import { redis } from "../lib/redis.js";

async function audit() {
  console.log("🔍 Starting Scraper Audit...");
  console.log(`📡 Redis URL: ${process.env.UPSTASH_REDIS_REST_URL ? "SET" : "MISSING"}`);
  console.log(`📡 Redis Token: ${process.env.UPSTASH_REDIS_REST_TOKEN ? "SET (Length: " + process.env.UPSTASH_REDIS_REST_TOKEN.length + ")" : "MISSING"}`);
  console.log(`📡 Ikiru Base: ${process.env.IKIRU_BASE_URL || "DEFAULT"}`);
  console.log("");

  try {
    // 1. Test Ikiru Search
    console.log("📡 Testing Ikiru Search ('Solo')...");
    const ikiruResults = await searchIkiru("Solo", {}, redis);
    console.log(`✅ Ikiru Search: Found ${ikiruResults.length} results.`);
    if (ikiruResults.length > 0) {
      console.log(`   Sample: ${ikiruResults[0].title} (${ikiruResults[0].url})`);
    }

    // 2. Test Shinigami Search
    console.log("\n📡 Testing Shinigami Search ('a')...");
    const shngmResults = await searchShngm("a", "shinigami_project");
    if (shngmResults.length > 0) {
      console.log(`✅ Shinigami Search: Found ${shngmResults.length} results.`);
      console.log(`   Sample: ${shngmResults[0].title} (${shngmResults[0].mangaUrl})`);
    } else {
      console.warn("⚠️  Shinigami Search: No results found in top 4 pages.");
    }

    // 3. Test Latest Updates (Orchestrator)
    console.log("\n📡 Testing Latest Updates (Orchestrated)...");
    const updates = await scrapeMangaUpdates(redis, { limit: 5 });
    console.log(`✅ Orchestrator: Found ${updates.length} recent updates.`);
    if (updates.length > 0) {
      updates.slice(0, 3).forEach((u, i) => {
        console.log(`   ${i+1}. [${u.source}] ${u.title} - ${u.chapter}`);
      });
    }

    console.log("\n✨ Scraper Audit Complete: SUCCESS");
  } catch (err) {
    console.error("\n❌ Scraper Audit FAILED:");
    console.error(err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

audit();
