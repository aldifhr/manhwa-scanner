import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";
const AJAX_PATH = "wp-admin/admin-ajax.php";
const TEST_TITLE = "Myst, Might, Mayhem (Legend Of Heavenly Chaos Demon)";

const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
];

async function fetchNonce() {
  for (const url of [SITE_URL + "advanced-search/", SITE_URL + "manga/", SITE_URL]) {
    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
        timeout: 8000,
      });
      for (const pattern of NONCE_PATTERNS) {
        const match = res.data.match(pattern);
        if (match) return match[1];
      }
    } catch {}
  }
  throw new Error("Nonce not found");
}

async function debugSearch() {
  console.log("=".repeat(60));
  console.log(`🔍 DEBUG: "${TEST_TITLE}"`);
  console.log("=".repeat(60));

  const nonce = await fetchNonce();
  const params = new URLSearchParams({
    action: "advanced_search",
    search_nonce: nonce,
    query: TEST_TITLE,
  });

  const res = await axios.post(`${SITE_URL}${AJAX_PATH}`, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      "Referer": `${SITE_URL}advanced-search/`,
      "X-Requested-With": "XMLHttpRequest",
    },
    timeout: 15000,
  });

  const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

  console.log("\n📦 RAW HTML RESPONSE (500 char pertama):");
  console.log(html.substring(0, 500));
  console.log("\n...\n");

  // Split sama seperti parseAdvancedSearchHTML
  const blocks = html.split('class="flex rounded-lg overflow-hidden h-46');
  console.log(`🧩 Total blocks: ${blocks.length - 1}`);

  if (blocks.length < 2) {
    console.log("❌ Tidak ada block ditemukan — cek apakah HTML structure berubah");
    console.log("\n📄 Full HTML:");
    console.log(html);
    return;
  }

  // Analisa block pertama
  const block = blocks[1];
  console.log("\n📄 BLOCK 1 RAW (full):");
  console.log(block);

  // Cek semua img src yang ada
  console.log("\n🖼️  Semua img src di block:");
  const allImgs = [...block.matchAll(/src="([^"]+)"/g)];
  if (allImgs.length) {
    allImgs.forEach((m, i) => console.log(`  [${i+1}] ${m[1]}`));
  } else {
    console.log("  ❌ Tidak ada img src ditemukan!");
  }

  // Cek dengan regex lama
  const oldMatch = /src="([^"]+128x\d+[^"]*)"/.exec(block);
  console.log(`\n🔎 Regex lama (128x): ${oldMatch ? oldMatch[1] : "❌ tidak match"}`);

  // Cek dengan regex baru
  const newMatch = /src="([^"]+\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/.exec(block);
  console.log(`🔎 Regex baru (wp-content): ${newMatch ? newMatch[1] : "❌ tidak match"}`);

  // Cek semua attr img (termasuk data-src, lazy load)
  console.log("\n🔎 Semua image attributes:");
  const allAttrs = [...block.matchAll(/(?:src|data-src|data-lazy-src|srcset)="([^"]+)"/g)];
  allAttrs.forEach(m => console.log(`  ${m[0]}`));
}

debugSearch().catch(console.error);