import "dotenv/config";
import { performFullHealthCheck } from "../lib/services/health.js";
import { redis } from "../lib/redis.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WHITELIST_PATH = path.resolve(__dirname, "../whitelist.json");

async function verify() {
  console.log("🚀 Starting verification...");
  
  try {
    // 1. Run Health Check
    console.log("--- Testing performHealthCheck ---");
    const broken = await performFullHealthCheck();
    console.log(`Found ${broken.length} broken links.`);
    
    // 2. Read stats from Redis
    console.log("\n--- Testing Redis State ---");
    const lastCheck = await redis.get("health:last-check");
    console.log(`Last check stored: ${lastCheck}`);
    
    const cachedBroken = await redis.get("health:broken-links");
    console.log(`Cached broken count: ${cachedBroken?.length || 0}`);

    // 3. Test local stats logic
    console.log("\n--- Testing Whitelist Stats ---");
    const data = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
    const sources = {};
    data.forEach(item => {
      sources[item.source] = (sources[item.source] || 0) + 1;
    });
    console.log("Sources found:", sources);

    console.log("\n✅ Verification script completed!");
  } catch (err) {
    console.error("❌ Verification failed:", err);
    if (err.stack) console.error(err.stack);
  } finally {
    process.exit(0);
  }
}

verify();
