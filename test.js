import { scrapeMangaUpdates } from "./lib/scraper.js";
import { readFileSync } from "fs";

const allResults = await scrapeMangaUpdates();
const whitelist = JSON.parse(readFileSync("./whitelist.json", "utf-8")).map(w =>
  typeof w === "string" ? { title: w, url: null } : w
);

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}
function normalizeUrl(u) {
  return u?.replace(/\/+$/, "").toLowerCase().trim();
}

const matched = allResults.filter(item =>
  whitelist.some(w => {
    console.log(`w.url: "${w.url}" → truthy: ${!!w.url}`);
    if (w.url && item.mangaUrl) return normalizeUrl(item.mangaUrl) === normalizeUrl(w.url);
    if (w.title) {
      const a = normalizeTitle(item.title);
      const b = normalizeTitle(w.title);
      console.log(`🔍 Compare:\n   item: "${a}"\n   wl  : "${b}"\n   match: ${a === b}`);
      return a === b || a.includes(b) || b.includes(a);
    }
    return false;
  })
);

console.log(`📋 Whitelist: ${whitelist.length} items`);
console.log(`📦 Scraped: ${allResults.length} items`);
console.log(`✅ Matched: ${matched.length} items`);
matched.forEach(m => console.log(` - ${m.title} | ${m.chapter}`));