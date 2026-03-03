import { searchIkiru } from "./lib/scraper.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TEST_TITLE = "The Regressed Mercenary's Machinations"; // Ganti judul di sini

// ─── TEST ─────────────────────────────────────────────────────────────────────
async function testScrapeByTitle() {
  console.log("=".repeat(50));
  console.log(`🔍 Testing scrape for: "${TEST_TITLE}"`);
  console.log("=".repeat(50));

  const results = await searchIkiru(TEST_TITLE);

  if (!results.length) {
    console.log("❌ No results found!");
    return;
  }

  console.log(`\n✅ Found ${results.length} result(s)\n`);

  results.forEach((r, i) => {
    const hasImage = !!r.cover;
    const imageStatus = hasImage ? "✅ ADA" : "❌ TIDAK ADA";

    console.log(`[${i + 1}] ${r.title}`);
    console.log(`    URL    : ${r.url}`);
    console.log(`    Gambar : ${imageStatus}`);
    if (hasImage) {
      console.log(`    Cover  : ${r.cover}`);
    }
    console.log(`    Chapter: ${r.chapter || "N/A"}`);
    console.log(`    Rating : ${r.rating || "N/A"}`);
    console.log();
  });

  // ─── SUMMARY ─────────────────────────────────────────────────────────────────
  const withImage = results.filter(r => !!r.cover).length;
  const withoutImage = results.length - withImage;

  console.log("=".repeat(50));
  console.log("📊 SUMMARY");
  console.log("=".repeat(50));
  console.log(`Total hasil  : ${results.length}`);
  console.log(`✅ Ada gambar: ${withImage}`);
  console.log(`❌ Tanpa gambar: ${withoutImage}`);
}

testScrapeByTitle();