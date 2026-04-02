import "dotenv/config";
import { performFullHealthCheck } from "../lib/services/health.js";

async function run() {
  console.log("🚀 Checking all manga entries in the active whitelist (Redis/JSON)...");
  
  const deadLinks = await performFullHealthCheck();

  console.log("\n====================================");
  console.log("🏁 FINAL REPORT");
  console.log("====================================");
  console.log(`❌ DEAD    : ${deadLinks.length}`);
  console.log("====================================\n");

  if (deadLinks.length > 0) {
    console.log("List of Dead Links:");
    deadLinks.forEach(d => {
      const statusStr = d.status ? `[${d.status}]` : "[ERR]";
      console.log(`${statusStr.padEnd(7)} ${d.title.padEnd(40)} | ${d.source.padEnd(15)} | ${d.url}`);
    });
    
    // Suggest cleanup
    console.log("\n💡 Tip: You can remove these links using '/remove <URL>' or by manually editing whitelist.json");
    console.log("💡 Detailed Recommendations are also available in the Web Dashboard.");
  } else {
    console.log("✨ All links are active! Your whitelist is clean.");
  }
  
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
