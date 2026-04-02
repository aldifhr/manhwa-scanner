import "dotenv/config";
import { performFullHealthCheck } from "../lib/services/health.js";
import { redis } from "../lib/redis.js";

async function test() {
  console.log("Running enhanced health check...");
  const broken = await performFullHealthCheck();
  console.log(`Found ${broken.length} broken links.`);
  
  const recommendations = await redis.get("health:recommendations");
  console.log("Recommendations:", JSON.stringify(recommendations, null, 2));
  
  // Clean up
  console.log("Done.");
  process.exit(0);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
