import { scrapeWithHeaders } from "../lib/scrapers/shared.js";
import * as cheerio from "cheerio";

const url = "https://02.ikiru.wtf/manga/the-magic-theory-of-the-regressed-sword-saint/";

async function test() {
  console.log("Fetching page...");
  const res = await scrapeWithHeaders(url, null, { timeout: 6000 });
  const $ = cheerio.load(res.data);

  console.log("\n=== Chapter List Container ===");
  console.log("#chapter-list exists:", $("#chapter-list").length);
  console.log("#chapter-list children:", $("#chapter-list").children().length);

  console.log("\n=== Data Chapter Number Elements ===");
  const chapterDivs = $("div[data-chapter-number]");
  console.log("div[data-chapter-number] count:", chapterDivs.length);

  chapterDivs.each((i, el) => {
    if (i >= 3) return; // Only show first 3
    const $el = $(el);
    const chapterNum = $el.attr("data-chapter-number");
    const link = $el.find("a[href*='/chapter-']").first();
    const href = link.attr("href");
    const chapterText = link.find("span").first().text().trim() || link.text().trim();
    const timeEl = $el.find("time").first();
    const datetime = timeEl.attr("datetime");
    const timeText = timeEl.text().trim();

    console.log(`\nChapter ${chapterNum}:`);
    console.log(`  href: ${href}`);
    console.log(`  text: "${chapterText}"`);
    console.log(`  datetime: ${datetime}`);
    console.log(`  timeText: "${timeText}"`);
  });

  console.log("\n=== Testing Selector ===");
  // Test the new selector
  const selectors = [
    "div[data-chapter-number]",
    "#chapter-list > div",
    "#tabpanel-chapters div[data-chapter-number]",
    "#tabpanel-chapters #chapter-list > div",
  ];

  for (const selector of selectors) {
    const count = $(selector).length;
    console.log(`${selector}: ${count}`);
  }
}

test().catch(console.error);
