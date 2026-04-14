import { redis } from "../lib/redis.js";
import { fetchIkiruMetadata } from "../lib/scrapers/ikiru.js";
import { fetchSecondaryMetadata } from "../lib/scrapers/secondary.js";

async function test() {
  console.log("--- Testing Ikiru Metadata ---");
  const ikiruUrl = "https://02.ikiru.wtf/manga/solo-farming-in-the-tower/";
  try {
    const ikiruMeta = await fetchIkiruMetadata(ikiruUrl, redis);
    console.log("Ikiru Meta Result:", JSON.stringify(ikiruMeta, null, 2));
  } catch (err) {
    console.error("Ikiru test failed:", err.message);
  }

  console.log("\n--- Testing Shinigami Metadata ---");
  const shngmId = "43521cfc-ead5-435c-9c10-772d05316cd3"; // Return Of The All-Time Genius Ranker
  try {
    const shngmMeta = await fetchSecondaryMetadata("shinigami_project", shngmId, redis);
    console.log("Shinigami Meta Result:", JSON.stringify(shngmMeta, null, 2));
  } catch (err) {
    console.error("Shinigami test failed:", err.message);
  }

  process.exit(0);
}

test().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
