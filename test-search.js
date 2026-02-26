// test-search.js
import axios        from "axios";
import * as cheerio from "cheerio";
import { writeFileSync } from "fs";

const AJAX_URL = "https://02.ikiru.wtf/wp-admin/admin-ajax.php";
const nonceRes = await axios.get(`${AJAX_URL}?type=search_form&action=get_nonce`, {
  headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000,
});
const nonce = nonceRes.data.match(/value='([a-z0-9]+)'/)?.[1];

const params = new URLSearchParams({
  the_page: 1, the_genre: "", the_author: "", the_artist: "",
  the_exclude: "", the_type: "", the_status: "",
  search_term: "genius", project: 0, order: "desc", orderby: "popular",
});

const res = await axios.get(
  `${AJAX_URL}?action=advanced_search&nonce=${nonce}&${params}`,
  { headers: { "User-Agent": "Mozilla/5.0", "HX-Request": "true" }, timeout: 15000 }
);

const $ = cheerio.load(res.data);

// cek semua a href yang ada
console.log("=== SEMUA HREF ===");
$("a").slice(0, 10).each((_, el) => {
  console.log($(el).attr("href"));
});

// cek total a
console.log("\nTotal <a>:", $("a").length);

// simpan raw
writeFileSync("debug.html", res.data);
console.log("Saved debug.html, length:", res.data.length);
