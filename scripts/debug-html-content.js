import { scrapeWithHeaders } from "../lib/scrapers/shared.js";
import * as cheerio from "cheerio";
import fs from "fs";

const url = "https://02.ikiru.wtf/manga/the-magic-theory-of-the-regressed-sword-saint/";

async function test() {
  console.log("Fetching page...");
  const res = await scrapeWithHeaders(url, null, { timeout: 6000 });

  console.log("\nResponse status:", res.status);
  console.log("Content length:", res.data.length);

  // Save HTML to file for inspection
  fs.writeFileSync("test-page.html", res.data);
  console.log("HTML saved to test-page.html");

  const $ = cheerio.load(res.data);

  // Check if chapter list is in the HTML
  const chapterListHtml = $("#chapter-list").html();
  console.log("\n=== Chapter List HTML (first 1000 chars) ===");
  console.log(chapterListHtml?.substring(0, 1000) || "NOT FOUND");

  // Check for htmx attributes
  console.log("\n=== HTMX Attributes ===");
  console.log("hx-get:", $("#chapter-list").attr("hx-get"));
  console.log("hx-trigger:", $("#chapter-list").attr("hx-trigger"));

  // Look for any indication of how chapters are loaded
  const scripts = $("script");
  console.log("\n=== Scripts with 'chapter' ===");
  scripts.each((i, el) => {
    const text = $(el).text();
    if (text.includes("chapter") && text.length < 500) {
      console.log(`Script ${i}:`, text.substring(0, 200));
    }
  });
}

test().catch(console.error);
