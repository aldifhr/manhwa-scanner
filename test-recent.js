// no-dupe-top5.js → STRICT horizontal only (no duplicate)
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

async function scrapeTop5Clean() {
  console.log("🧪 Top 5 TERATAS (HORIZONTAL ONLY - NO DOUBLE)\n");

  const SITE_URL = "https://02.ikiru.wtf";

  const { data } = await axios.get(SITE_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: 10000,
  });

  const $ = cheerio.load(data);
  const results = [];
  const seen = new Set();

  /**
   * TARGET:
   * Ambil container latest list horizontal saja
   * Biasanya item horizontal berupa card flex items-start
   */
  const horizontalItems = $(
    '#latest-list:not(.group-data-direction\\:horizontal\\:hidden) > div'
  );

  horizontalItems.each((i, el) => {
    if (results.length >= 5) return;

    const card = $(el);

    // === TITLE ===
    const title = card
      .find('a[href*="/manga/"] h1')
      .first()
      .text()
      .trim();

    if (!title) return;

    // === CHAPTER TERBARU SAJA (AMBIL YANG PERTAMA) ===
    const chapterLink = card
      .find('a[href*="/chapter-"]')
      .first();

    if (!chapterLink.length) return;

    const chapter = chapterLink
      .find('p:contains("Chapter")')
      .first()
      .text()
      .trim();

    const timeEl = chapterLink.find("time[datetime]").first();
    if (!timeEl.length) return;

    const iso = timeEl.attr("datetime");
    const hoursAgo =
      (Date.now() - new Date(iso).getTime()) / 3600000;

    // filter max 24 jam
    if (hoursAgo > 24) return;

    const key = `${title}-${chapter}`;
    if (seen.has(key)) return;
    seen.add(key);

    let url = chapterLink.attr("href");
    if (url?.startsWith("/")) {
      url = `${SITE_URL}${url}`;
    }

    results.push({
      pos: results.length + 1,
      title: title.slice(0, 35),
      chapter,
      hoursAgo: hoursAgo.toFixed(1),
      timeAgo: formatTimeAgo(iso),
      url,
    });
  });

  console.log("✅ TOP 5 UNIK (HORIZONTAL ONLY)\n");
  console.log(
    "#  TITLE".padEnd(32) +
      "CHAPTER".padEnd(12) +
      "JAM".padEnd(6) +
      "URL"
  );
  console.log("=".repeat(75));

  results.forEach((r) => {
    console.log(
      `${r.pos.toString().padStart(2)} ${r.title.padEnd(28)}${r.chapter.padEnd(
        12
      )}${r.hoursAgo.padEnd(6)}h${r.url}`
    );
  });

  fs.writeFileSync(
    "top5-clean.json",
    JSON.stringify(results, null, 2)
  );

  console.log("\n💾 Saved → top5-clean.json");
}

function formatTimeAgo(iso) {
  const diff = Date.now() - new Date(iso);
  const h = Math.floor(diff / 3600000);
  return h === 0
    ? `${Math.floor((diff % 3600000) / 60000)}m ago`
    : `${h}h ago`;
}

scrapeTop5Clean().catch(console.error);