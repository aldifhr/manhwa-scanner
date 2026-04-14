import fs from "fs";
import { scrapeWithHeaders } from "../lib/scrapers/shared.js";

async function test() {
  const url = "https://a.shinigami.asia/series/the-rebel-of-the-tyrant-noble-family/";
  const res = await scrapeWithHeaders(url, null, { retries: 1 });
  const html = res?.data || "";
  fs.writeFileSync("shinigami-dump.html", html);
  console.log("Saved", html.length, "bytes");
}
test().catch(console.error);
