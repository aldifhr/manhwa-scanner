import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";
const LATEST_URL = "https://02.ikiru.wtf/latest-update/";
const AJAX_PATH = "wp-admin/admin-ajax.php";

// ─── COOKIE ───────────────────────────────────────────────────────────────────
import { refreshCookie } from "./cookie.js";

// Cache cookie di memory selama proses berjalan
let _cookie = process.env.IKIRU_COOKIE || "";
let _cookieTimestamp = _cookie ? Date.now() : 0;
let _refreshing = null;
/**
 * Ambil cookie — dari memory, Redis, atau login ulang
 * redis param opsional, kalau ada akan cache cookie di Redis
 */
async function getCookie(redis = null) {
  const MAX_AGE = 1000 * 60 * 60 * 24 * 10; // 10 hari

  // 1️⃣ Memory cache valid
  if (_cookie && Date.now() - _cookieTimestamp < MAX_AGE) {
    return _cookie;
  }

  // 2️⃣ Sedang refresh → tunggu
  if (_refreshing) {
    return _refreshing;
  }

  // 3️⃣ Coba Redis
  if (redis) {
    try {
      const cached = await redis.get("ikiru:cookie");
      if (cached) {
        _cookie = cached;
        _cookieTimestamp = Date.now();
        console.log("🍪 Cookie loaded from Redis");
        return _cookie;
      }
    } catch {}
  }

  // 4️⃣ Login ulang — lock supaya tidak double login
  _refreshing = (async () => {
    try {
      console.log("🔐 Refreshing cookie...");
      const fresh = await refreshCookie();

      if (!fresh) {
        _cookieTimestamp = 0; // ← reset supaya bisa retry lain kali
        return "";
      }

      _cookie = fresh;
      _cookieTimestamp = Date.now();

      if (redis) {
        await redis.set("ikiru:cookie", fresh, { ex: 60 * 60 * 24 * 12 });
      }

      return _cookie;
    } finally {
      _refreshing = null;
    }
  })();

  return _refreshing;
}

// ─── UTILS (FIXED) ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`⚠️ Retry ${i + 1}/${retries}...`);
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
}

// Base headers yang dipakai semua request
async function baseHeaders(redis = null, extra = {}) {
  const cookie = await getCookie(redis);
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

// Helper untuk scrape dengan headers (FIX UTAMA)
async function scrapeWithHeaders(url, redis = null, options = {}) {
  const timeout = options.timeout || 10000;

  try {
    const headers = await baseHeaders(redis, options.extraHeaders || {});

    return await withRetry(() =>
      axios.get(url, {
        headers,
        timeout,
      }),
    );
  } catch (err) {
    if (err.response?.status === 403) {
      console.log("🔄 Cookie expired. Refreshing...");

      _cookie = "";
      _cookieTimestamp = 0;

      await getCookie(redis);

      const headers = await baseHeaders(redis, options.extraHeaders || {});

      // Delay kecil supaya tidak terlihat brute-force
      await new Promise((r) => setTimeout(r, 1500));

      return withRetry(() => axios.get(url, { headers, timeout }));
    }

    throw err;
  }
}

export const formatTimeAgo = (datetime) => {
  try {
    const diffMs = new Date() - new Date(datetime);
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    return mins < 1
      ? "Just now"
      : mins < 60
        ? `${mins} min ago`
        : hours < 24
          ? `${hours} hour${hours > 1 ? "s" : ""} ago`
          : `${days} day${days > 1 ? "s" : ""} ago`;
  } catch {
    return datetime;
  }
};

export const STATUS_EMOJI = {
  Ongoing: "🟢",
  Completed: "🔵",
  Hiatus: "🟡",
  Unknown: "⚪",
};
export const getStatusColor = (status) =>
  ({
    Ongoing: 0x22c55e,
    Completed: 0x3b82f6,
    Hiatus: 0xf59e0b,
    Unknown: 0x6b7280,
  })[status] || 0x6b7280;

// ─── CORE FUNCTIONS ───────────────────────────────────────────────────────────
export async function sendErrorLog(webhookUrl, error, context = "") {
  try {
    await axios.post(webhookUrl, {
      embeds: [
        {
          title: "❌ Bot Error",
          description: `\`\`\`${error.message || error}\`\`\``,
          color: 0xff0000,
          fields: [
            { name: "Context", value: context || "Unknown", inline: true },
            { name: "Time", value: new Date().toISOString(), inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch {
    console.error("Failed to send error log");
  }
}

export async function fetchDescription(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `desc:${mangaUrl}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch {}
  }

  try {
    // GUNAKAN HELPER BARU
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 8000 });
    const $ = cheerio.load(res.data);

    let desc =
      $('meta[name="description"]').attr("content") ||
      $(".description, .summary, [class*='description']").first().text().trim();

    desc = desc?.length > 300 ? desc.substring(0, 297) + "..." : desc;

    if (redis && desc) {
      await redis.set(cacheKey, desc, { ex: 1800 });
    }

    return desc;
  } catch {
    return null;
  }
}

// ─── MAIN SCRAPER (FIXED) ─────────────────────────────────────────────────────
function parsePage($, seen) {
  const results = [];
  let foundOlderThan24h = false;

  const cards = $("#search-results").children();
  const now = Date.now();
  cards.each((_, card) => {
    if (foundOlderThan24h) return false;
    const $card = $(card);
    const $vertical = $card.children("div").first();
    if (!$vertical.length) return;

    let title = $vertical.find("h1").first().text().trim();
    if (!title) return;

    const mangaUrl =
      $vertical.find("a[href*='/manga/']").first().attr("href") || null;

    let cover = $vertical.find("img").first().attr("src") || null;
    if (cover?.startsWith("/")) cover = `${SITE_URL}${cover.slice(1)}`;
    if (cover) cover = cover.replace(/-\d+x\d+/, "");

    const rawRating = $vertical.find(".numscore").first().text().trim();
    const rating = normalizeRating(rawRating);

    const status =
      $vertical
        .find("p.font-normal.text-xs")
        .filter((_, el) =>
          ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()),
        )
        .first()
        .text()
        .trim() || "Unknown";

    const $chapterLinks = $vertical.find("a[href*='/chapter-']");
    if (!$chapterLinks.length) return;

    $chapterLinks.each((i, el) => {
      const $link = $(el);
      const chapterText = $link.find("p").text().trim();
      const updatedTime = $link.find("time[datetime]").attr("datetime");
      let url = $link.attr("href");

      if (!chapterText || !updatedTime || !url) return;

      if (url.startsWith("/")) {
        url = `${SITE_URL}${url.slice(1)}`;
      }

      const normalizedMangaUrl = mangaUrl
        ? mangaUrl.startsWith("http")
          ? mangaUrl.replace(/\/$/, "")
          : `${SITE_URL}${mangaUrl.replace(/^\//, "").replace(/\/$/, "")}`
        : null;
      if (!normalizedMangaUrl) return;
      const key = `${normalizedMangaUrl}-${updatedTime}`;
      if (seen.has(key)) return;
      seen.add(key);

      const updated = new Date(updatedTime);
      if (isNaN(updated)) return;

      const diffHours = (now - updated.getTime()) / 3600000;
      if (diffHours < 0) return; // skip future timestamps
      if (diffHours > 24) {
        foundOlderThan24h = true;
        return false; // STOP chapter loop
      }

      results.push({
        title: title.slice(0, 50),
        chapter: chapterText,
        url,
        cover,
        mangaUrl: normalizedMangaUrl,
        rating,
        status,
        updatedTime,
      });
    });
  });

  return { results, foundOlderThan24h };
}

function normalizeRating(raw) {
  if (!raw) return null;

  const num = parseFloat(raw);
  if (isNaN(num)) return null;

  // Valid rating biasanya 0–10
  if (num >= 0 && num <= 10) return num;

  return null;
}

export async function scrapeMangaUpdates(redis = null) {
  try {
    const allResults = [];
    const seen = new Set();
    const MAX_PAGES = 10;

    const cookie = await getCookie(redis);
    if (cookie) {
      console.log("🍪 Scraping with cookie (realtime mode)");
    } else {
      console.log(
        "⚠️ Scraping without cookie (cached mode) — set IKIRU_USERNAME/PASSWORD for realtime",
      );
    }

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? LATEST_URL : `${LATEST_URL}?the_page=${page}`;

      // GUNAKAN HELPER BARU (FIX UTAMA)
      const res = await scrapeWithHeaders(url, redis);
      const $ = cheerio.load(res.data);
      const { results, foundOlderThan24h } = parsePage($, seen);

      allResults.push(...results);
      console.log(`🔍 Page ${page}: ${results.length} items`);

      if (foundOlderThan24h) {
        console.log("⏹ Stop: older than 24h detected");
        break;
      }

      if (results.length === 0) {
        console.log("⏹ Stop: no results");
        break;
      }
    }

    console.log(`✅ Total scraped: ${allResults.length} items`);
    return allResults;
  } catch (err) {
    console.error("Scrape failed:", err.message);
    return [];
  }
}

// ─── POPULAR ──────────────────────────────────────────────────────────────────
export async function scrapePopular() {
  try {
    // GUNAKAN HELPER BARU
    const res = await scrapeWithHeaders(SITE_URL, null);
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $(
      ".swiper-slide a[href*='/manga/'], [class*='slide'] a[href*='/manga/']",
    ).each((i, el) => {
      const $el = $(el);
      const title = $el.attr("title") || $el.find("h4").text().trim();
      const link = $el.attr("href");
      const cover = $el.find("img").first().attr("src");

      if (title && link && !seen.has(title)) {
        seen.add(title);
        results.push({
          title,
          url: link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
          cover: !cover
            ? null
            : cover.startsWith("http")
              ? cover
              : `https://02.ikiru.wtf${cover}`,
          rating: $el.find(".rating, .details p").text().trim() || "N/A",
        });
      }
    });

    return results.slice(0, 10);
  } catch {
    return [];
  }
}

// ─── ADVANCED SEARCH ──────────────────────────────────────────────────────────
const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
];

let _nonce = null;
let _nonceExpiry = 0;
async function fetchNonce(redis = null) {
  // Memory cache
  if (_nonce && Date.now() < _nonceExpiry) return _nonce;

  // Redis cache
  if (redis) {
    try {
      const cached = await redis.get("ikiru:nonce");
      if (cached) {
        _nonce = cached;
        _nonceExpiry = Date.now() + 10 * 60 * 1000;
        return _nonce;
      }
    } catch {}
  }

  // Fetch dari website
  for (const url of [
    SITE_URL + "advanced-search/",
    SITE_URL + "manga/",
    SITE_URL,
  ]) {
    try {
      const res = await scrapeWithHeaders(url, redis, {
        extraHeaders: { Accept: "text/html" },
        timeout: 8000,
      });
      for (const pattern of NONCE_PATTERNS) {
        const match = res.data.match(pattern);
        if (match) {
          _nonce = match[1];
          _nonceExpiry = Date.now() + 10 * 60 * 1000; // 10 menit

          if (redis) {
            await redis.set("ikiru:nonce", _nonce, { ex: 600 });
          }

          return _nonce;
        }
      }
    } catch {}
  }

  throw new Error("Nonce not found");
}

function parseAdvancedSearchHTML(html) {
  if (!html || html.includes("No results found")) return [];

  const results = [];
  const seenSlugs = new Set();

  const blocks = html.split('class="flex rounded-lg overflow-hidden h-46');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const urlMatch =
      /href="(https?:\/\/[^"]+\/manga\/([^"/]+)\/)"\s+class="min-w-\[120px\]/.exec(
        block,
      );
    if (!urlMatch) continue;

    const [_, url, slug] = urlMatch;
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const titleMatch = /alt="([^"]+)"/.exec(block);
    const title = titleMatch
      ? titleMatch[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      : slug.replace(/-/g, " ");

    const srcsetMatch = /srcset="([^"]+)"/.exec(block);
    let cover = null;

    if (srcsetMatch) {
      const entries = srcsetMatch[1].split(",").map((s) => s.trim());
      // Ambil yang 320w, atau fallback ke terakhir
      const pick =
        entries.find((e) => e.includes("320x")) || entries[entries.length - 1];
      cover = pick.split(" ")[0];
    } else {
      // Fallback ke src biasa
      const imgMatch =
        /src="([^"]+\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/.exec(
          block,
        );
      cover = imgMatch ? imgMatch[1] : null;
    }
    const chapterMatch = /Chapter\s+([\d.]+)/.exec(block);
    const chapter = chapterMatch ? `Chapter ${chapterMatch[1]}` : null;

    const ratingMatch = /(?:>|\s)((?:10|\d)\.?\d{0,2})<\/span/.exec(block);
    const rawRating = ratingMatch ? ratingMatch[1] : null;
    const rating = normalizeRating(rawRating);

    results.push({ title, url, slug, cover, chapter, rating });
  }

  return results;
}

export async function searchIkiru(keyword, opts = {}, redis = null) {
  const cacheKey = `cache:search:${keyword}:${JSON.stringify(opts)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(
          `⚡ Cache hit "${keyword}": ${JSON.parse(cached).length} results`,
        );
        return JSON.parse(cached);
      }
    } catch {}
  }

  try {
    const nonce = await fetchNonce(redis);
    const params = new URLSearchParams({
      action: "advanced_search",
      search_nonce: nonce,
      query: keyword,
      ...opts,
    });

    const headers = await baseHeaders(redis, {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${SITE_URL}advanced-search/`,
      "X-Requested-With": "XMLHttpRequest",
    });

    const res = await withRetry(() =>
      axios.post(`${SITE_URL}${AJAX_PATH}`, params, {
        headers,
        timeout: 15000,
      }),
    );

    const results = parseAdvancedSearchHTML(
      typeof res.data === "string" ? res.data : JSON.stringify(res.data),
    );

    if (redis) {
      await redis.set(cacheKey, JSON.stringify(results), { ex: 600 });
    }

    console.log(`✅ Search "${keyword}": ${results.length} results`);
    return results;
  } catch (err) {
    console.error(`❌ Search failed: ${err.message}`);
    return [];
  }
}
