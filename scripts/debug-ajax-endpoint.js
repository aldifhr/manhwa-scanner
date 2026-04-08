import { scrapeWithHeaders } from "../lib/scrapers/shared.js";
import * as cheerio from "cheerio";

const mangaUrl = "https://02.ikiru.wtf/manga/the-magic-theory-of-the-regressed-sword-saint/";
const ajaxUrl = "https://02.ikiru.wtf/wp-admin/admin-ajax.php?manga_id=828108&page=1&action=chapter_list";

async function test() {
  console.log("Testing AJAX endpoint...");
  console.log("URL:", ajaxUrl);

  try {
    const res = await scrapeWithHeaders(ajaxUrl, null, { timeout: 6000 });
    console.log("\nResponse status:", res.status);
    console.log("Content type:", res.headers?.["content-type"]);
    console.log("Content length:", res.data.length);

    const $ = cheerio.load(res.data);

    console.log("\n=== Chapter Elements ===");
    const chapterDivs = $("div[data-chapter-number]");
    console.log("div[data-chapter-number] count:", chapterDivs.length);

    if (chapterDivs.length === 0) {
      console.log("\nNo chapters found. HTML preview:");
      console.log(res.data.substring(0, 500));
    }

    chapterDivs.each((i, el) => {
      if (i >= 5) return; // Only show first 5
      const $el = $(el);
      const chapterNum = $el.attr("data-chapter-number");
      const link = $el.find("a[href*='/chapter-']").first();
      const href = link.attr("href");
      const chapterText = link.find("span").first().text().trim() || link.text().trim().substring(0, 30);
      const timeEl = $el.find("time").first();
      const datetime = timeEl.attr("datetime");
      const timeText = timeEl.text().trim();

      console.log(`\nChapter ${chapterNum}:`);
      console.log(`  href: ${href}`);
      console.log(`  text: "${chapterText}"`);
      console.log(`  datetime: ${datetime}`);
      console.log(`  timeText: "${timeText}"`);
    });
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test().catch(console.error);
