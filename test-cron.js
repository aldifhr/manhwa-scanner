/**
 * Test lokal untuk matching logic cron.js
 * Jalankan: node test-cron.js
 *
 * Pastikan whitelist.json ada di folder yang sama
 */

import { scrapeMangaUpdates } from "./lib/scraper.js";
import { readFileSync } from "fs";

// ===== LOAD WHITELIST =====
const rawWhitelist = JSON.parse(readFileSync("./whitelist.json", "utf-8"));
const whitelist = rawWhitelist.map((w) =>
  typeof w === "string" ? { title: w, url: null } : w,
);

// ===== NORMALIZE HELPERS =====
function normalizeTitle(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(u) {
  return u?.replace(/\/+$/, "").toLowerCase().trim();
}

// ===== MAIN =====
async function main() {
  console.log(`📋 Whitelist (${whitelist.length} entries):`);
  whitelist.forEach((w) =>
    console.log(
      `  - [${w.url ? "URL" : "TITLE"}] ${w.title} ${w.url ? `→ ${w.url}` : ""}`,
    ),
  );
  console.log("");

  console.log("🔍 Scraping latest updates...\n");
  const allResults = await scrapeMangaUpdates();
  console.log("\n🔎 All scraped mangaUrls:");
  allResults.forEach((r) => console.log(`  ${r.mangaUrl}`));
  console.log(`\n📦 Total scraped: ${allResults.length} items`);
  if (allResults.length > 0) {
    console.log("📦 Sample scraped:");
    allResults
      .slice(0, 5)
      .forEach((r) =>
        console.log(`  - ${r.title} | ${r.chapter} | ${r.mangaUrl}`),
      );
  }

  // ===== MATCHING =====
  const matched = allResults.filter((item) => {
    return whitelist.some((w) => {
      if (w.url && item.mangaUrl) {
        return normalizeUrl(item.mangaUrl) === normalizeUrl(w.url);
      }
      if (w.title) {
        const itemNorm = normalizeTitle(item.title);
        const wNorm = normalizeTitle(w.title);
        return (
          itemNorm === wNorm ||
          itemNorm.includes(wNorm) ||
          wNorm.includes(itemNorm)
        );
      }
      return false;
    });
  });

  console.log(`\n✅ Matched: ${matched.length} item(s)`);
  if (matched.length > 0) {
    matched.forEach((m) =>
      console.log(`  🎯 ${m.title} | ${m.chapter} | ${m.mangaUrl}`),
    );
  } else {
    console.log("  ⚠️  Tidak ada yang cocok.");
    console.log("\n💡 Debug — cek apakah URL whitelist cocok dengan scraped:");
    whitelist.forEach((w) => {
      if (!w.url) return;
      const normW = normalizeUrl(w.url);
      const closest = allResults.find((r) =>
        normalizeUrl(r.mangaUrl)?.includes(normW.split("/manga/")[1] ?? ""),
      );
      if (closest) {
        console.log(`  ❓ "${w.title}"`);
        console.log(`     whitelist : ${normW}`);
        console.log(`     scraped   : ${normalizeUrl(closest.mangaUrl)}`);
      }
    });
  }
}

main().catch(console.error);
