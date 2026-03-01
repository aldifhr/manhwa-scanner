import dotenv from "dotenv";
dotenv.config();

import { loadWhitelist } from "./lib/redis.js";
import { scrapeMangaUpdates } from "./lib/scraper.js";

// ===== HELPERS =====

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

// ===== MAIN TEST =====

async function runTest() {
  console.log("🚀 Running local test...\n");

  const [whitelist, allResults] = await Promise.all([
    loadWhitelist(),
    scrapeMangaUpdates(),
  ]);

  console.log("📦 Total scraped:", allResults.length);
  console.log("📜 Whitelist size:", whitelist.length);

  if (!whitelist.length) {
    console.log("❌ Whitelist empty");
    return;
  }

  // ===== FILTER =====

  const matched = allResults.filter((item) =>
    whitelist.some((w) => {
      if (w.url && item.mangaUrl) {
        return normalizeUrl(item.mangaUrl) === normalizeUrl(w.url);
      }

      if (w.title) {
        const a = normalizeTitle(item.title);
        const b = normalizeTitle(w.title);
        return a === b || a.includes(b) || b.includes(a);
      }

      return false;
    }),
  );

  console.log("🎯 Matched count:", matched.length);

  if (!matched.length) {
    console.log("❌ No matched chapters");
    return;
  }

  // ===== SORT =====

  matched.sort((a, b) => {
    const getNum = (c) => {
      const match = c.chapter?.match(/\d+(\.\d+)?/);
      return match ? parseFloat(match[0]) : 0;
    };

    return getNum(a) - getNum(b);
  });

  console.log("\n=== 📚 FINAL ORDER AFTER SORT ===\n");

  matched.forEach((item, i) => {
    console.log(`${i + 1}. ${item.title} - ${item.chapter}`);
  });

  console.log("\n✅ Test finished (no Discord send, no Redis set)");
}

runTest().catch((err) => {
  console.error("FATAL:", err);
});