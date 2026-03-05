import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";
const LATEST_URL = "https://02.ikiru.wtf/latest-update/";
const AJAX_PATH = "wp-admin/admin-ajax.php";

// ─── COOKIE ───────────────────────────────────────────────────────────────────
import { refreshCookie } from "./cookie.js";

let _cookie = process.env.IKIRU_COOKIE || "";
let _cookiePromise = null; // lock untuk prevent race condition

/**
 * Ambil cookie — dari memory, Redis, atau login ulang.
 * Menggunakan promise lock agar tidak terjadi race condition
 * ketika banyak request concurrent masuk bersamaan.
 */
async function getCookie(redis = null) {
  // 1. Sudah ada di memory
  if (_cookie) return _cookie;

  // 2. Sudah ada promise yang sedang berjalan — tunggu hasilnya
  if (_cookiePromise) return _cookiePromise;

  _cookiePromise = (async () => {
    // 3. Coba dari Redis
    if (redis) {
      try {
        const cached = await redis.get("ikiru:cookie");
        if (cached) {
          _cookie = cached;
          console.log("🍪 Cookie loaded from Redis");
          return _cookie;
        }
      } catch (err) {
        console.warn("[getCookie] Redis fetch failed:", err.message);
      }
    }

    // 4. Login ulang dan simpan ke Redis
    try {
      const fresh = await refreshCookie();
      if (fresh) {
        _cookie = fresh;
        if (redis) {
          // Simpan 12 hari (cookie WP biasanya 14 hari)
          await redis
            .set("ikiru:cookie", fresh, { ex: 60 * 60 * 24 * 12 })
            .catch((err) =>
              console.warn("[getCookie] Redis set failed:", err.message),
            );
        }
      }
    } catch (err) {
      console.error("[getCookie] refreshCookie failed:", err.message);
    }

    return _cookie || "";
  })();

  try {
    return await _cookiePromise;
  } finally {
    _cookiePromise = null;
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

/**
 * Retry dengan exponential backoff, max delay 5 detik.
 */
async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 5000);
      console.log(`⚠️ Retry ${i + 1}/${retries} in ${delay}ms... (${err.message})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Konversi URL relatif ke absolut.
 */
const toAbsoluteUrl = (url, base = SITE_URL) => {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${base}${url.startsWith("/") ? url.slice(1) : url}`;
};

/**
 * Hapus suffix ukuran gambar WordPress, misal -300x450.
 */
const cleanImageUrl = (url) => url?.replace(/-\d+x\d+(\.\w+)$/, "$1") ?? null;

/**
 * Base headers yang dipakai semua request.
 */
async function baseHeaders(redis = null, extra = {}) {
  const cookie = await getCookie(redis);
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

/**
 * GET request dengan headers lengkap + retry.
 */
async function scrapeWithHeaders(url, redis = null, options = {}) {
  const headers = await baseHeaders(redis, options.extraHeaders || {});
  return withRetry(
    () =>
      axios.get(url, {
        headers,
        timeout: options.timeout || 10000,
      }),
    options.retries,
  );
}

// ─── EXPORTS HELPERS ──────────────────────────────────────────────────────────

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
  })[status] ?? 0x6b7280;

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
  } catch (err) {
    console.error("[sendErrorLog] Failed to send error log:", err.message);
  }
}

export async function fetchDescription(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `desc:${mangaUrl}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      console.warn("[fetchDescription] Redis get failed:", err.message);
    }
  }

  try {
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 8000 });
    const $ = cheerio.load(res.data);

    let desc =
      $('meta[name="description"]').attr("content") ||
      $(".description, .summary, [class*='description']").first().text().trim();

    desc = desc?.length > 300 ? desc.substring(0, 297) + "..." : desc;

    if (redis && desc) {
      await redis
        .set(cacheKey, desc, { ex: 1800 })
        .catch((err) =>
          console.warn("[fetchDescription] Redis set failed:", err.message),
        );
    }

    return desc || null;
  } catch (err) {
    console.warn(`[fetchDescription] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

// ─── MAIN SCRAPER ─────────────────────────────────────────────────────────────

/**
 * Parse satu halaman latest-update.
 * Mengembalikan results dalam 24 jam terakhir dan flag apakah
 * sudah menemukan chapter yang lebih lama dari 24 jam.
 */
function parsePage($, seen) {
  const results = [];
  let foundOlderThan24h = false;

  $("#search-results")
    .children()
    .each((_, card) => {
      const $card = $(card);
      const $vertical = $card.children("div").first();
      if (!$vertical.length) return;

      const title = $vertical.find("h1").first().text().trim();
      if (!title) return;

      const mangaUrl = toAbsoluteUrl(
        $vertical.find("a[href*='/manga/']").first().attr("href"),
      );

      const rawCover = $vertical.find("img").first().attr("src");
      const cover = cleanImageUrl(toAbsoluteUrl(rawCover));

      const rating = $vertical.find(".numscore").text().trim() || "N/A";

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

      $chapterLinks.each((_, el) => {
        const $link = $(el);
        const chapterText = $link.find("p").text().trim();
        const updatedTime = $link.find("time[datetime]").attr("datetime");
        const rawUrl = $link.attr("href");

        if (!chapterText || !updatedTime || !rawUrl) return;

        const url = toAbsoluteUrl(rawUrl);
        const diffHours = (new Date() - new Date(updatedTime)) / 3600000;

        if (diffHours > 24) {
          foundOlderThan24h = true;
          return; // skip chapter ini, tapi lanjutkan iterasi
        }

        const key = `${title}-${chapterText}`;
        if (seen.has(key)) return;
        seen.add(key);

        results.push({
          title: title.slice(0, 50),
          chapter: chapterText,
          url,
          cover,
          mangaUrl,
          rating,
          status,
          updatedTime,
        });
      });
    });

  return { results, foundOlderThan24h };
}

export async function scrapeMangaUpdates(redis = null) {
  try {
    const allResults = [];
    const seen = new Set();
    const MAX_PAGES = 10;

    const cookie = await getCookie(redis);
    console.log(
      cookie
        ? "🍪 Scraping with cookie (realtime mode)"
        : "⚠️ Scraping without cookie (cached mode) — set IKIRU_USERNAME/PASSWORD for realtime",
    );

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        page === 1 ? LATEST_URL : `${LATEST_URL}?the_page=${page}`;

      let res;
      try {
        res = await scrapeWithHeaders(url, redis);
      } catch (err) {
        console.error(`[scrapeMangaUpdates] Page ${page} fetch failed:`, err.message);
        break;
      }

      const $ = cheerio.load(res.data);
      const { results, foundOlderThan24h } = parsePage($, seen);

      allResults.push(...results);
      console.log(`🔍 Page ${page}: ${results.length} items`);

      // Berhenti kalau tidak ada hasil sama sekali ATAU sudah ada yang > 24 jam
      if (results.length === 0 || foundOlderThan24h) break;
    }

    console.log(`✅ Total scraped: ${allResults.length} items`);
    return allResults;
  } catch (err) {
    console.error("[scrapeMangaUpdates] Fatal error:", err.message);
    return [];
  }
}

// ─── POPULAR ──────────────────────────────────────────────────────────────────

export async function scrapePopular() {
  try {
    const res = await scrapeWithHeaders(SITE_URL, null);
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $(
      ".swiper-slide a[href*='/manga/'], [class*='slide'] a[href*='/manga/']",
    ).each((_, el) => {
      const $el = $(el);
      const title = $el.attr("title") || $el.find("h4").text().trim();
      const link = $el.attr("href");
      const cover = $el.find("img").first().attr("src");

      if (!title || !link || seen.has(title)) return;
      seen.add(title);

      results.push({
        title,
        url: toAbsoluteUrl(link),
        cover: cleanImageUrl(toAbsoluteUrl(cover)),
        rating: $el.find(".rating, .details p").text().trim() || "N/A",
      });
    });

    return results.slice(0, 10);
  } catch (err) {
    console.error("[scrapePopular] Failed:", err.message);
    return [];
  }
}

// ─── ADVANCED SEARCH ──────────────────────────────────────────────────────────

const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
];

/** Whitelist parameter yang boleh dikirim ke AJAX search */
const ALLOWED_SEARCH_OPTS = ["genre", "status", "type", "order"];

async function fetchNonce() {
  const urls = [
    SITE_URL + "advanced-search/",
    SITE_URL + "manga/",
    SITE_URL,
  ];

  for (const url of urls) {
    try {
      const res = await scrapeWithHeaders(url, null, {
        extraHeaders: { Accept: "text/html" },
        timeout: 8000,
      });
      for (const pattern of NONCE_PATTERNS) {
        const match = res.data.match(pattern);
        if (match) {
          console.log(`✅ Nonce found at: ${url}`);
          return match[1];
        }
      }
      console.warn(`[fetchNonce] No nonce matched at: ${url}`);
    } catch (err) {
      console.warn(`[fetchNonce] Failed for ${url}:`, err.message);
    }
  }

  throw new Error("Nonce not found in any URL");
}

/**
 * Parse HTML hasil AJAX advanced search menggunakan cheerio
 * agar lebih robust dibanding string splitting.
 */
function parseAdvancedSearchHTML(html) {
  if (!html || html.includes("No results found")) return [];

  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  // Tiap item manga adalah card dengan class flex + rounded-lg
  $(".flex.rounded-lg.overflow-hidden").each((_, el) => {
    const $el = $(el);

    // URL & slug dari link gambar
    const $imgLink = $el.find("a[href*='/manga/']").first();
    const url = $imgLink.attr("href");
    if (!url) return;

    const slugMatch = /\/manga\/([^/]+)\/?$/.exec(url);
    const slug = slugMatch ? slugMatch[1] : null;
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);

    // Title dari alt gambar atau fallback ke slug
    const rawTitle =
      $imgLink.find("img").attr("alt") ||
      slug.replace(/-/g, " ");
    const title = rawTitle.replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(n),
    );

    // Cover — bersihkan suffix ukuran WP
    const rawCover = $imgLink.find("img").attr("src") || null;
    const cover = cleanImageUrl(rawCover);

    // Chapter terbaru
    const chapterText = $el.find("a[href*='/chapter-'] p").first().text().trim();
    const chapter = chapterText || null;

    // Rating
    const rating = $el.find(".numscore").first().text().trim() || null;

    results.push({
      title,
      url: toAbsoluteUrl(url),
      slug,
      cover,
      chapter,
      rating,
    });
  });

  return results;
}

export async function scrapeMangaCover(mangaUrl, redis = null) {
  try {
    const res = await scrapeWithHeaders(mangaUrl, redis);
    const $ = cheerio.load(res.data);

    const rawCover = $(".summary_image img, .thumb img, img.wp-post-image")
      .first()
      .attr("src");

    return cleanImageUrl(toAbsoluteUrl(rawCover)) || null;
  } catch (err) {
    console.warn(`[scrapeMangaCover] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

export async function searchIkiru(keyword, opts = {}, redis = null) {
  const safeOpts = Object.fromEntries(
    Object.entries(opts).filter(([k]) => ALLOWED_SEARCH_OPTS.includes(k)),
  );

  const cacheKey = `cache:search:${keyword}:${JSON.stringify(safeOpts)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        console.log(`⚡ Cache hit "${keyword}": ${parsed.length} results`);
        return parsed;
      }
    } catch (err) {
      console.warn("[searchIkiru] Redis get failed:", err.message);
    }
  }

  try {
    const nonce = await fetchNonce();
    const params = new URLSearchParams({
      action: "advanced_search",
      search_nonce: nonce,
      query: keyword,
      ...safeOpts,
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

    const rawHtml =
      typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const results = parseAdvancedSearchHTML(rawHtml);

    if (redis && results.length > 0) {
      await redis
        .set(cacheKey, JSON.stringify(results), { ex: 600 })
        .catch((err) =>
          console.warn("[searchIkiru] Redis set failed:", err.message),
        );
    }

    console.log(`✅ Search "${keyword}": ${results.length} results`);
    return results;
  } catch (err) {
    console.error(`[searchIkiru] Search failed for "${keyword}":`, err.message);
    return [];
  }
}