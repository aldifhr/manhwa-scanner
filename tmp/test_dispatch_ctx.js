import { loadMatchedDispatchContext } from "../lib/services/dispatch.js";
import { redis } from "../lib/redis.js";

async function testDispatchContext() {
  console.log("--- Testing Match Dispatch Context ---");
  
  const ctx = await loadMatchedDispatchContext({
    scrapeUpdates: async (wl) => {
        console.log(`Scraping updates for ${wl.length} mangas...`);
        return []; // No results for now
    }
  });

  console.log("Context Status:", ctx.status);
  console.log("Whitelist Length:", ctx.whitelist.length);
  
  if (ctx.status === "empty_whitelist") {
      console.log("❌ ERROR: Still showing empty_whitelist!");
  } else {
      console.log("✅ Whitelist is NOT empty in context.");
  }
}

testDispatchContext().catch(console.error);
