import axios from "axios";
import { searchIkiru, scrapeMangaCover } from "./lib/scraper.js";

async function test() {
  const keyword = "The Regressed Mercenary's Machinations";

  console.log("\n===============================");
  console.log("🔍 Searching:", keyword);

  const results = await searchIkiru(keyword);

  if (!results.length) {
    console.log("❌ Tidak ditemukan");
    return;
  }

  const manga = results[0];

  console.log("\n📖 BASIC DATA");
  console.log("Title   :", manga.title);
  console.log("URL     :", manga.url);
  console.log("Search Cover :", manga.cover);

  console.log("\n📄 Fetching detail cover...");
  const realCover = await scrapeMangaCover(manga.url);

  console.log("Detail Cover :", realCover);

  if (!realCover) {
    console.log("❌ Tidak dapat cover dari detail page");
    return;
  }

  try {
    const res = await axios.head(realCover, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    console.log("Cover Test:", res.status, res.headers["content-type"]);
  } catch (err) {
    console.log("Cover Test: ❌ ERROR", err.response?.status || err.message);
  }
}

test();