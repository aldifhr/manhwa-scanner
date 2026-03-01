import { scrapeMangaUpdates } from "./lib/scraper.js";

const results = await scrapeMangaUpdates();
console.log(JSON.stringify(results, null, 2));
console.log("Total:", results.length);