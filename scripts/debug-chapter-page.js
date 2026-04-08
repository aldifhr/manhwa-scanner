import { fetchRecentChaptersFromMangaPage } from "../lib/scrapers/ikiru.js";
import { redis } from "../lib/redis.js";

const url = "https://02.ikiru.wtf/manga/the-magic-theory-of-the-regressed-sword-saint/";

async function test() {
  console.log("Testing fetchRecentChaptersFromMangaPage...");
  console.log("URL:", url);

  const chapters = await fetchRecentChaptersFromMangaPage(url, redis);

  console.log("\n=== RESULT ===");
  console.log(`Found ${chapters.length} chapters`);

  if (chapters.length > 0) {
    console.log("\nFirst chapter:");
    console.log(JSON.stringify(chapters[0], null, 2));

    console.log("\nAll chapters:");
    chapters.forEach((c, i) => {
      console.log(`${i + 1}. ${c.chapter} | ${c.updatedTime}`);
    });
  } else {
    console.log("\nNo chapters found (may be >24h old or page structure changed)");
  }

  console.log("\nDone.");
}

test().catch(console.error);
