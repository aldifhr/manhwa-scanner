import "dotenv/config";
import { redis } from "../lib/redis.js";
// import { performFullHealthCheck } from "../lib/services/health.js";

async function simulate() {
  const testUrl = "https://02.ikiru.wtf/manga/non-existent-manga-xyz/";
  const key = linkStatsKey(testUrl);

  console.log(`Simulating 5 failures for ${testUrl}...`);
  await redis.set(key, {
    url: testUrl,
    consecutiveFailures: 5,
    totalFailures: 5,
    lastSuccessAt: null,
    lastFailureAt: new Date().toISOString(),
    lastStatusCode: 404,
  });

  // Also add it to whitelist temporarily or just run performFullHealthCheck
  // and expect it to be in results if it was already there.
  // Actually, I'll just run performFullHealthCheck and see.
  // But I need that URL to be in the whitelist.

  console.log("Stats set. Now run the health check script.");
  process.exit(0);
}

simulate().catch(console.error);
