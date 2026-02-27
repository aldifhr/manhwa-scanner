import axios        from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";
const keyword  = process.argv[2] || "genius";

async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`Testing search: "${keyword}"`);
  console.log("=".repeat(60));

  // Step 1: ambil nonce dari halaman utama (bukan advanced-search)
  // nonce ada di form hx-post="...?nonce=XXXX&action=search"
  console.log("\n[1] Fetching nonce from homepage...");
  let nonce = null;
  try {
    const pageRes = await axios.get(SITE_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    // Cari pattern: ?nonce=XXXX&action=search
    const match =
      pageRes.data.match(/admin-ajax\.php\?nonce=([a-f0-9]+)&(?:amp;)?action=search/) ||
      pageRes.data.match(/nonce=([a-f0-9]+)/);
    nonce = match?.[1] || null;
    console.log(nonce ? `  nonce: ${nonce}` : "  no nonce found");
  } catch (e) {
    console.log(`  failed: ${e.message}`);
  }

  if (!nonce) {
    console.log("  Cannot proceed without nonce.");
    return;
  }

  // Step 2: POST dengan action=search dan param query=
  console.log("\n[2] POST with action=search, query=...");
  try {
    const formData = new URLSearchParams({ query: keyword });

    const res = await withRetry(() => axios.post(
      `${SITE_URL}wp-admin/admin-ajax.php?nonce=${nonce}&action=search`,
      formData,
      {
        headers: {
          "Content-Type":     "application/x-www-form-urlencoded",
          "User-Agent":       "Mozilla/5.0",
          "Referer":          SITE_URL,
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 10000,
      }
    ));

    const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    console.log(`  status: ${res.status}, size: ${raw.length} chars`);
    console.log(`\n  raw (first 1000):\n${raw.substring(0, 1000)}\n`);

    // Parse hasilnya
    const $ = cheerio.load(raw);
    const results = [];

    $("a").each((_, el) => {
      const card = $(el);
      const url  = card.attr("href") || "";
      if (!url.includes("/manga/") || /\/chapter/i.test(url)) return;

      const fullUrl = url.startsWith("http") ? url : `${SITE_URL}${url.replace(/^\//, "")}`;
      if (results.find(r => r.url === fullUrl)) return;

      const title =
        card.find("[class*='title'], [class*='name'], h3, h4, h2").first().text().trim() ||
        card.attr("title") ||
        card.attr("alt") ||
        card.text().trim().split("\n")[0].trim();

      const cover =
        card.find("img").first().attr("src") ||
        card.find("img").first().attr("data-src") ||
        null;

      const desc = card.find("p, [class*='desc'], [class*='synopsis']").first().text().trim();

      if (title) {
        results.push({ title, url: fullUrl, cover, desc });
      }
    });

    console.log(`\n[3] RESULTS: ${results.length} found`);
    console.log("=".repeat(60));
    results.forEach((item, i) => {
      console.log(`${i + 1}. ${item.title}`);
      console.log(`   url:   ${item.url}`);
      console.log(`   cover: ${item.cover || "NONE"}`);
      console.log(`   desc:  ${item.desc || "NONE"}\n`);
    });

    // DEBUG: print container HTML item pertama
    if (results.length === 0 && raw.length > 10) {
      console.log("No results parsed. Printing full raw for inspection:");
      console.log(raw.substring(0, 3000));
    } else if (results.length > 0) {
      // Print container HTML item pertama buat cek cover/desc
      const firstA = $("a").filter((_, el) => {
        const href = $(el).attr("href") || "";
        return href.includes("/manga/") && !/\/chapter/i.test(href);
      }).first();
      let node = firstA.parent();
      for (let i = 0; i < 6; i++) {
        if (node.find("img").length && node.children().length > 1) break;
        node = node.parent();
      }
      console.log(`\n--- CONTAINER HTML item 1 ---\n${node.html()?.substring(0, 2000)}\n--- END ---`);
    }

  } catch (e) {
    console.log(`  error: ${e.message}`);
    if (e.response) console.log(`  body: ${JSON.stringify(e.response.data).substring(0, 300)}`);
  }
}

main().catch(console.error);