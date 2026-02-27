#!/usr/bin/env node
/**
 * advanced-search.js — ikiru.wtf Advanced Search CLI
 *
 * Usage:
 *   node advanced-search.js [options]
 *
 * Options:
 *   -q, --query <text>         Kata kunci pencarian
 *   -g, --genre <genre,...>    Filter genre (pisahkan koma): action,comedy,romance,...
 *   -t, --type <type,...>      Filter tipe: manga,manhwa,manhua,comic,novel
 *   -s, --status <status,...>  Filter status: ongoing,completed,on-hiatus
 *   -o, --orderby <order>      Urutan: popular|rating|updated|bookmarked|title
 *   -d, --order <dir>          Arah: asc|desc
 *   -p, --page <num>           Halaman awal (default: 1)
 *   -x, --exclude <genre,...>  Exclude genre
 *   --json                     Output sebagai JSON
 *   --limit <n>                Batasi jumlah hasil; stop fetch begitu terpenuhi
 *   --no-paginate              Hanya fetch 1 halaman saja (nonaktifkan auto-pagination)
 *   --delay <ms>               Jeda antar halaman dalam ms (default: 300)
 *   --url <url>                Base URL (default: https://02.ikiru.wtf)
 *   -h, --help                 Tampilkan bantuan
 *
 * Contoh:
 *   node advanced-search.js -q genius -t manhwa -o rating
 *   node advanced-search.js -g action,fantasy -s ongoing -o updated
 *   node advanced-search.js -q "solo leveling" --json
 */

// ─── DEPS ────────────────────────────────────────────────────────────────────

import https from "https";
import http from "http";
import { URL } from "url";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE = "https://02.ikiru.wtf";
const AJAX_PATH = "/wp-admin/admin-ajax.php";
const ACTION = "advanced_search";

// ANSI colors
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  magenta: "\x1b[35m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
};

const noColor = process.env.NO_COLOR || !process.stdout.isTTY;
const clr = (code, text) => (noColor ? text : `${code}${text}${C.reset}`);

// ─── ARG PARSER ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    query: "",
    genre: [],
    excludeGenre: [],
    type: [],
    status: [],
    author: [],
    artist: [],
    orderby: "popular",
    order: "",
    page: 1,
    json: false,
    limit: 0,
    paginate: true,   // auto-paginate by default
    delay: 300,       // ms between page requests
    url: DEFAULT_BASE,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];

    switch (a) {
      case "-q": case "--query":    opts.query = next(); break;
      case "-g": case "--genre":    opts.genre = next().split(",").map(s => s.trim()); break;
      case "-x": case "--exclude":  opts.excludeGenre = next().split(",").map(s => s.trim()); break;
      case "-t": case "--type":     opts.type = next().split(",").map(s => s.trim()); break;
      case "-s": case "--status":   opts.status = next().split(",").map(s => s.trim()); break;
      case "-a": case "--author":   opts.author = next().split(",").map(s => s.trim()); break;
      case "--artist":              opts.artist = next().split(",").map(s => s.trim()); break;
      case "-o": case "--orderby":  opts.orderby = next(); break;
      case "-d": case "--order":    opts.order = next(); break;
      case "-p": case "--page":     opts.page = parseInt(next(), 10); break;
      case "--limit":               opts.limit = parseInt(next(), 10); break;
      case "--no-paginate":         opts.paginate = false; break;
      case "--delay":               opts.delay = parseInt(next(), 10); break;
      case "--url":                 opts.url = next(); break;
      case "--json":                opts.json = true; break;
      case "-h": case "--help":     opts.help = true; break;
    }
  }

  return opts;
}

// ─── HELP ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${clr(C.bold + C.cyan, "ikiru.wtf Advanced Search CLI")}

${clr(C.bold, "USAGE")}
  node advanced-search.js [options]

${clr(C.bold, "OPTIONS")}
  ${clr(C.yellow, "-q, --query   <text>")}       Kata kunci pencarian
  ${clr(C.yellow, "-g, --genre   <g1,g2,...>")}  Include genre (koma-separated)
  ${clr(C.yellow, "-x, --exclude <g1,g2,...>")}  Exclude genre
  ${clr(C.yellow, "-t, --type    <t1,t2,...>")}  Tipe: manga|manhwa|manhua|comic|novel
  ${clr(C.yellow, "-s, --status  <s1,s2,...>")}  Status: ongoing|completed|on-hiatus
  ${clr(C.yellow, "-a, --author  <slug,...>")}   Filter penulis (slug)
  ${clr(C.yellow, "    --artist  <slug,...>")}   Filter artist (slug)
  ${clr(C.yellow, "-o, --orderby <order>")}      popular|rating|updated|bookmarked|title
  ${clr(C.yellow, "-d, --order   <dir>")}        asc|desc
  ${clr(C.yellow, "-p, --page    <num>")}        Halaman awal (default: 1)
  ${clr(C.yellow, "    --limit   <n>")}          Batasi jumlah hasil; stop fetch begitu terpenuhi
  ${clr(C.yellow, "    --no-paginate")}          Hanya fetch 1 halaman saja
  ${clr(C.yellow, "    --delay   <ms>")}         Jeda antar halaman (default: 300ms)
  ${clr(C.yellow, "    --json")}                 Output JSON mentah
  ${clr(C.yellow, "    --url     <base>")}       Override base URL
  ${clr(C.yellow, "-h, --help")}                 Tampilkan bantuan ini

${clr(C.bold, "CONTOH")}
  ${clr(C.dim, "# Cari manhwa genre action, urutkan rating")}
  node advanced-search.js -q genius -t manhwa -o rating

  ${clr(C.dim, "# Filter genre fantasy+action, status ongoing, halaman 2")}
  node advanced-search.js -g fantasy,action -s ongoing -p 2 -o updated

  ${clr(C.dim, "# Output JSON untuk piping")}
  node advanced-search.js -q "solo leveling" --json | jq '.[0]'

  ${clr(C.dim, "# Exclude genre adult, limit 5 hasil")}
  node advanced-search.js -g romance -x adult --limit 5

${clr(C.bold, "GENRE POPULER")}
  action, adventure, comedy, drama, fantasy, romance, thriller,
  slice-of-life, supernatural, school-life, martial-arts, system,
  regression, reincarnation, isekai, sports, music, harem
`);
}

// ─── HTTP FETCH ──────────────────────────────────────────────────────────────

function fetchNonce(baseUrl) {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}/advanced-search/`;
    const mod = url.startsWith("https") ? https : http;

    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (advanced-search.js/1.0)",
        "Accept": "text/html",
      }
    }, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        // Coba berbagai pattern nonce yang mungkin ada di halaman
        const patterns = [
          /search_nonce["'\s:=]+([a-f0-9]{10})/,   // search_nonce=XXXX
          /nonce=([a-f0-9]{10})/,                    // nonce=XXXX (di hx-get/hx-post attr)
          /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/, // "nonce":"XXXX" (JSON)
          /nonce["'\s:=]+([a-f0-9]{10})/,            // nonce: XXXX (generic)
        ];
        for (const pattern of patterns) {
          const match = data.match(pattern);
          if (match) return resolve(match[1]);
        }
        reject(new Error("Nonce tidak ditemukan di halaman"));
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Timeout fetch nonce"));
    });
  });
}

function fetchNonceFromManga(baseUrl) {
  // Fallback: ambil nonce dari halaman utama / manga list
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}/manga/`;
    const mod = url.startsWith("https") ? https : http;

    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (advanced-search.js/1.0)",
        "Accept": "text/html",
      }
    }, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        const patterns = [
          /search_nonce["'\s:=]+([a-f0-9]{10})/,
          /nonce=([a-f0-9]{10})/,
          /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
          /nonce["'\s:=]+([a-f0-9]{10})/,
        ];
        for (const pattern of patterns) {
          const match = data.match(pattern);
          if (match) return resolve(match[1]);
        }
        reject(new Error("Nonce tidak ditemukan di /manga/"));
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Timeout fetch nonce fallback")));
  });
}

function postSearch(baseUrl, params) {
  return new Promise((resolve, reject) => {
    const body = params.toString();
    const parsedUrl = new URL(AJAX_PATH, baseUrl);
    const mod = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Referer": `${baseUrl}/advanced-search/`,
        "User-Agent": "Mozilla/5.0 (advanced-search.js/1.0)",
        "Accept": "*/*",
        "X-Requested-With": "XMLHttpRequest",
      },
    };

    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout POST search")));
    req.write(body);
    req.end();
  });
}

// ─── HTML PARSER ─────────────────────────────────────────────────────────────

/**
 * Extract manga cards from the raw HTML response.
 *
 * Confirmed HTML structure (from test-search.js output):
 *
 * <div class="flex rounded-lg overflow-hidden h-46 group-data-[mode=vertical]:hidden">
 *   <a href="https://02.ikiru.wtf/manga/SLUG/" class="min-w-[120px] w-23 h-full relative">
 *     <img src="...128x184.png" alt="TITLE" />
 *   </a>
 *   <div class="flex flex-col justify-between px-4 py-1.5 w-full text-white">
 *     <div>
 *       <div class="flex flex-col ...">
 *         <!-- title link, chapter, etc. -->
 */
function parseResults(html) {
  if (!html || html.trim().length === 0) return [];
  if (html.includes("No results found")) return [];

  const results = [];
  const seenSlugs = new Set();

  // Split by card separator — each horizontal card starts with this class
  // We use the "h-46" marker which is unique to each card container
  const cardBlocks = html.split('<div class="flex rounded-lg overflow-hidden h-46');

  for (let i = 1; i < cardBlocks.length; i++) {
    const block = cardBlocks[i];

    // URL & slug
    const urlM = /href="(https?:\/\/[^"]+\/manga\/([^"/]+)\/)"\s+class="min-w-\[120px\]/.exec(block);
    if (!urlM) continue;

    const url = urlM[1];
    const slug = urlM[2];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    // Cover image (128xNNN)
    const imgM = /src="([^"]+128x\d+[^"]*)"/.exec(block);
    const cover = imgM ? imgM[1] : null;

    // Alt text = title (most reliable source)
    const altM = /alt="([^"]+)"/.exec(block);
    const title = altM ? decodeHtmlEntities(altM[1]) : slug.replace(/-/g, " ");

    // Chapter number
    const chapterM = /Chapter\s+([\d.]+)/.exec(block);
    const chapter = chapterM ? `Chapter ${chapterM[1]}` : null;

    // Status badge — appears as colored spans
    const statusM = /class="[^"]*(?:bg-green|bg-blue|bg-yellow|bg-orange|bg-accent)[^"]*"[^>]*>\s*([^<]+?)\s*<\/span/.exec(block);
    const status = statusM ? statusM[1].trim() : extractStatusFromText(block);

    // Rating — typically a numeric value like 8.5 or 7.20
    const ratingM = /(?:>|\s)((?:10|\d)\.?\d{0,2})<\/span/.exec(block);
    const rating = ratingM ? ratingM[1] : null;

    // Views/bookmarks — numbers like "1.2K", "345K", "1M"
    const statsM = block.match(/>([\d.]+[KMBk]?)<\/span/g) || [];
    const stats = statsM
      .map(s => s.replace(/^>|<\/span$/g, ""))
      .filter(s => /^\d/.test(s) && !s.includes(".") || /^\d+[KMBk]$/.test(s) || /^\d+\.\d+[KMBk]?$/.test(s));

    // Genre tags
    const genreM = block.match(/class="[^"]*genre[^"]*"[^>]*>([^<]+)<\/a>/g) || [];
    const genres = genreM.map(g => g.replace(/<[^>]+>/g, "").trim()).filter(Boolean);

    // Pub date / last updated
    const dateM = /(\d{4}-\d{2}-\d{2}|\d+ (?:hour|day|week|month|year)s? ago)/.exec(block);
    const updated = dateM ? dateM[1] : null;

    results.push({
      title,
      url,
      slug,
      cover,
      chapter,
      status,
      rating,
      genres: genres.length ? genres : undefined,
      updated: updated || undefined,
      stats: stats.length ? stats : undefined,
    });
  }

  // Fallback if no cards parsed (shouldn't happen with correct HTML)
  if (results.length === 0) {
    const fallback = /href="(https?:\/\/[^"]+\/manga\/([^"/]+)\/)"/g;
    const seen = new Set();
    let fm;
    while ((fm = fallback.exec(html)) !== null) {
      const [, furl, fslug] = fm;
      if (!seen.has(fslug) && !fslug.includes("chapter")) {
        seen.add(fslug);
        results.push({
          title: fslug.replace(/-/g, " "),
          url: furl,
          slug: fslug,
          cover: null, chapter: null, status: null, rating: null,
        });
      }
    }
  }

  return results;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractStatusFromText(block) {
  const lower = block.toLowerCase();
  if (lower.includes("ongoing"))   return "Ongoing";
  if (lower.includes("completed")) return "Completed";
  if (lower.includes("on-hiatus") || lower.includes("hiatus")) return "On-Hiatus";
  if (lower.includes("dropped"))   return "Dropped";
  return null;
}

// ─── DISPLAY ─────────────────────────────────────────────────────────────────

function statusColor(s) {
  if (!s) return clr(C.dim, "unknown");
  const lower = s.toLowerCase();
  if (lower === "ongoing") return clr(C.green, s);
  if (lower === "completed") return clr(C.blue, s);
  if (lower.includes("hiatus")) return clr(C.yellow, s);
  return clr(C.dim, s);
}

function ratingBar(rating) {
  if (!rating) return "";
  const r = parseFloat(rating);
  const filled = Math.round(r);
  const stars = "★".repeat(filled) + "☆".repeat(10 - filled);
  const color = r >= 8 ? C.green : r >= 6 ? C.yellow : C.red;
  return clr(color, stars.slice(0, 10)) + ` ${rating}`;
}

function displayResults(results, opts) {
  const list = results; // slicing sudah dilakukan di main()

  if (list.length === 0) {
    console.log(clr(C.yellow, "\n  Tidak ada hasil ditemukan.\n"));
    return;
  }

  console.log(clr(C.dim, `\n  Menampilkan ${list.length} hasil:\n`));

  list.forEach((item, i) => {
    const num = clr(C.dim, `${String(i + 1).padStart(3, " ")}.`);
    const title = clr(C.bold + C.white, item.title || "(no title)");
    const chapter = item.chapter ? clr(C.cyan, item.chapter) : "";
    const status = statusColor(item.status);
    const rating = item.rating ? `  ⭐ ${item.rating}` : "";
    const genres = item.genres?.length ? clr(C.dim, `  [${item.genres.slice(0, 3).join(", ")}]`) : "";
    const updated = item.updated ? clr(C.dim, `  🕒 ${item.updated}`) : "";
    const url = clr(C.dim, `     ${item.url}`);

    console.log(`${num} ${title}`);
    console.log(`      ${chapter}  ${status}${rating}${genres}${updated}`);
    console.log(url);
    console.log();
  });
}

function displayHeader(opts) {
  const parts = [];
  if (opts.query) parts.push(`query: "${opts.query}"`);
  if (opts.genre.length) parts.push(`genre: [${opts.genre.join(", ")}]`);
  if (opts.excludeGenre.length) parts.push(`exclude: [${opts.excludeGenre.join(", ")}]`);
  if (opts.type.length) parts.push(`type: [${opts.type.join(", ")}]`);
  if (opts.status.length) parts.push(`status: [${opts.status.join(", ")}]`);
  parts.push(`orderby: ${opts.orderby}`);
  if (opts.page > 1) parts.push(`halaman awal: ${opts.page}`);
  if (!opts.paginate) parts.push("single-page");
  if (opts.limit > 0) parts.push(`limit: ${opts.limit}`);

  console.log();
  console.log(clr(C.bold + C.cyan, "  🔍 ikiru.wtf Advanced Search"));
  console.log(clr(C.dim, `  ${parts.join("  ·  ")}`));
  console.log(clr(C.dim, "  " + "─".repeat(60)));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Step 1: Fetch fresh nonce
  process.stderr.write(clr(C.dim, "  Mengambil nonce... "));
  let nonce;
  try {
    nonce = await fetchNonce(opts.url);
    process.stderr.write(clr(C.green, `OK (${nonce})\n`));
  } catch (err) {
    process.stderr.write(clr(C.red, `GAGAL: ${err.message}\n`));
    // Fallback: coba ambil dari URL lain yang lebih sederhana
    try {
      process.stderr.write(clr(C.yellow, "  Mencoba fallback URL /manga/...\n"));
      nonce = await fetchNonceFromManga(opts.url);
      process.stderr.write(clr(C.green, `  Nonce dari fallback: ${nonce}\n`));
    } catch {
      nonce = "7506d022fd"; // last known good nonce
      process.stderr.write(clr(C.yellow, `  Menggunakan nonce hardcoded: ${nonce}\n`));
    }
  }

  // Step 2: Build base POST params (tanpa page, ditambah per iterasi)
  const buildParams = (page) => {
    const params = new URLSearchParams();
    params.append("action", ACTION);
    params.append("search_nonce", nonce);

    if (opts.query)   params.append("query", opts.query);
    if (opts.orderby) params.append("orderby", opts.orderby);
    if (opts.order)   params.append("order", opts.order);
    if (page > 1)     params.append("page", page);

    for (const g of opts.genre)        params.append("genre[]", g);
    for (const g of opts.excludeGenre) params.append("genre_exclude[]", g);
    for (const t of opts.type)         params.append("type[]", t);
    for (const s of opts.status)       params.append("status[]", s);
    for (const a of opts.author)       params.append("series-author[]", a);
    for (const a of opts.artist)       params.append("artist[]", a);

    return params;
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Step 3: Pagination loop
  const allResults = [];
  const seenSlugs = new Set();
  let currentPage = opts.page;
  let consecutiveEmpty = 0;
  const MAX_RETRY = 1; // retry 1x kalau halaman kosong sebelum stop

  while (true) {
    process.stderr.write(clr(C.dim, `  Fetching halaman ${currentPage}... `));

    let html;
    try {
      html = await postSearch(opts.url, buildParams(currentPage));
    } catch (err) {
      process.stderr.write(clr(C.red, `ERROR: ${err.message}\n`));
      break;
    }

    const pageResults = parseResults(html);

    // Deduplicate berdasarkan slug (kadang halaman overlap)
    const freshResults = pageResults.filter(r => !seenSlugs.has(r.slug));
    freshResults.forEach(r => seenSlugs.add(r.slug));

    process.stderr.write(clr(C.green, `${freshResults.length} hasil\n`));

    if (freshResults.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty > MAX_RETRY) {
        process.stderr.write(clr(C.dim, `  Halaman kosong 2x berturut-turut, selesai.\n`));
        break;
      }
      process.stderr.write(clr(C.yellow, `  Halaman kosong, retry (${consecutiveEmpty}/${MAX_RETRY})...\n`));
      currentPage++;
      await sleep(opts.delay);
      continue;
    }

    consecutiveEmpty = 0;
    allResults.push(...freshResults);

    // Stop early kalau limit sudah terpenuhi
    if (opts.limit > 0 && allResults.length >= opts.limit) {
      process.stderr.write(clr(C.dim, `  Limit ${opts.limit} tercapai, stop.\n`));
      break;
    }

    // Stop kalau hanya 1 halaman yang diminta
    if (!opts.paginate) break;

    currentPage++;
    await sleep(opts.delay);
  }

  // Step 4: Output
  const results = opts.limit > 0 ? allResults.slice(0, opts.limit) : allResults;
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  displayHeader(opts);
  displayResults(results, opts);

  // Footer stats
  if (results.length > 0) {
    const ongoingCount = results.filter(r => r.status?.toLowerCase() === "ongoing").length;
    const completedCount = results.filter(r => r.status?.toLowerCase() === "completed").length;
    const rated = results.filter(r => r.rating).map(r => parseFloat(r.rating));
    const avgRating = rated.length ? (rated.reduce((a, b) => a + b, 0) / rated.length).toFixed(2) : null;

    console.log(clr(C.dim, "  " + "─".repeat(60)));
    console.log(clr(C.dim, `  Total: ${results.length} · Ongoing: ${ongoingCount} · Completed: ${completedCount}${avgRating ? ` · Avg Rating: ${avgRating}` : ""}`));
    console.log();
  }
}

main().catch(err => {
  console.error(clr(C.red, `\n  Fatal: ${err.message}`));
  process.exit(1);
});