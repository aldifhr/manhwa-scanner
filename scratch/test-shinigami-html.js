import { scrapeWithHeaders } from "../lib/scrapers/shared.js";
import * as cheerio from "cheerio";

async function test() {
  const url = "https://a.shinigami.asia/series/the-rebel-of-the-tyrant-noble-family/";
  const res = await scrapeWithHeaders(url, null, { retries: 1 });
  const html = res?.data || "";
  console.log("HTML Length:", html.length);
  const $ = cheerio.load(html);

  // Try to find description
  const desc = $(".summary__content, .manga-excerpt, .description, .synopsis").first().text().trim();
  console.log("Desc:", desc ? desc.substring(0, 100) : "NOT FOUND");

  // Try to find manga_id in scripts
  const scripts = $("script").map((_, el) => $(el).text()).get().join(" ");
  const match = scripts.match(/manga_id\s*[:=]\s*["']?(\d+)["']?/i);
  console.log("Manga ID:", match ? match[1] : "NOT FOUND");

  // Try rating
  const rate = $(".post-total-rating, .rating, .score").first().text().trim();
  console.log("Rating:", rate ? rate : "NOT FOUND");

  const postIdMatch = scripts.match(/post_id\s*[:=]\s*["']?(\d+)["']?/i);
  console.log("Post ID (often manga_id):", postIdMatch ? postIdMatch[1] : "NOT FOUND");
}
test().catch(console.error);
