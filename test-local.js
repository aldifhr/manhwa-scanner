import { searchIkiru } from "./lib/scraper.js";

// ─── Ganti / tambah judul di sini ─────────────────────────────────────────────
const TEST_TITLES = [
  "The Regressed Mercenary's Machinations",
  "Myst, Might, Mayhem (Legend Of Heavenly Chaos Demon)",
  "Solo Leveling",
  "Nano Machine",
];

// ─── TEST ─────────────────────────────────────────────────────────────────────
async function testMultipleTitles() {
  let totalHit = 0;
  let withImage = 0;
  let withoutImage = 0;

  for (const title of TEST_TITLES) {
    console.log(`\n${"=".repeat(55)}`);
    console.log(`🔍 "${title}"`);
    console.log("=".repeat(55));

    const results = await searchIkiru(title);

    if (!results.length) {
      console.log("❌ Tidak ditemukan");
      continue;
    }

    const r = results[0];
    const hasImage = !!r.cover;
    totalHit++;
    hasImage ? withImage++ : withoutImage++;

    console.log(`   Title  : ${r.title}`);
    console.log(`   Gambar : ${hasImage ? "✅ ADA" : "❌ TIDAK ADA"}`);
    console.log(`   Cover  : ${r.cover ?? "(null)"}`);  // ← selalu print, ada atau tidak
  }

  console.log(`\n${"=".repeat(55)}`);
  console.log("📊 SUMMARY");
  console.log("=".repeat(55));
  console.log(`Total ditemukan : ${totalHit}/${TEST_TITLES.length}`);
  console.log(`✅ Ada gambar   : ${withImage}`);
  console.log(`❌ Tanpa gambar : ${withoutImage}`);
}

testMultipleTitles().catch(console.error);