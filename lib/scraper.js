import axios from "axios";
import * as cheerio from "cheerio";
import {
  AJAX_PATH,
  SITE_URL,
  STATUS_EMOJI,
  baseHeaders,
  cleanImageUrl,
  formatTimeAgo,
  getCookie,
  getStatusColor,
  normalizeSource,
  normalizeTitleKey,
  parseIkiruDatetime,
  parseLooseRelativeTime,
  scrapeWithHeaders,
  shouldPrioritizeSecondaryEntry,
  shouldPrioritizeSecondaryTitle,
  toAbsoluteUrl,
  withRetry,
} from "./scrapers/shared.js";
import { orchestrateScrapeSources } from "./scrapers/orchestrator.js";
import {
  collectIkiruRecentChaptersFromAjaxHtml,
  collectIkiruRecentChaptersFromMangaPage,
  expandIkiruUpdatesFromDetailPages,
  fetchLatestMangaUpdateTime,
  scrapeIkiruUpdatesWithMeta,
} from "./scrapers/ikiru.js";
import {
  scrapeSecondarySourceUpdates,
  searchShngm,
} from "./scrapers/secondary.js";
import { getLogger } from "./logger.js";

export {
  STATUS_EMOJI,
  collectIkiruRecentChaptersFromAjaxHtml,
  collectIkiruRecentChaptersFromMangaPage,
  expandIkiruUpdatesFromDetailPages,
  fetchLatestMangaUpdateTime,
  formatTimeAgo,
  getStatusColor,
  parseIkiruDatetime,
  scrapeSecondarySourceUpdates,
  searchShngm,
  shouldPrioritizeSecondaryEntry,
  shouldPrioritizeSecondaryTitle,
};

export async function sendErrorLog(webhookUrl, error, context = "") {
  try {
    await axios.post(webhookUrl, {
      embeds: [
        {
          title: "Bot Error",
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
    desc = desc?.length > 300 ? `${desc.substring(0, 297)}...` : desc;

    if (redis && desc) {
      await redis
        .set(cacheKey, desc, { ex: 1800 })
        .catch((err) => console.warn("[fetchDescription] Redis set failed:", err.message));
    }
    return desc || null;
  } catch (err) {
    console.warn(`[fetchDescription] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

export async function scrapeMangaUpdatesWithMeta(redis = null, options = {}) {
  return orchestrateScrapeSources({
    redis,
    options,
    getCookie,
    scrapeIkiruUpdatesWithMeta,
    scrapeSecondarySourceUpdates,
    logger: getLogger({ scope: "scraper" }),
  });
}

export async function scrapeMangaUpdates(redis = null, options = {}) {
  const { items } = await scrapeMangaUpdatesWithMeta(redis, options);
  return items;
}

export async function scrapePopular() {
  try {
    const res = await scrapeWithHeaders(SITE_URL, null);
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $(".swiper-slide a[href*='/manga/'], [class*='slide'] a[href*='/manga/']").each((_, el) => {
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

const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
];
const NONCE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_SEARCH_OPTS = ["genre", "status", "type", "order"];
let nonceCache = { value: null, expiresAt: 0 };

async function fetchNonce() {
  if (nonceCache.value && nonceCache.expiresAt > Date.now()) {
    return nonceCache.value;
  }

  const urls = [
    `${SITE_URL}advanced-search/`,
    `${SITE_URL}manga/`,
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
          console.log(`Nonce found at: ${url}`);
          nonceCache = {
            value: match[1],
            expiresAt: Date.now() + NONCE_TTL_MS,
          };
          return nonceCache.value;
        }
      }
      console.warn(`[fetchNonce] No nonce matched at: ${url}`);
    } catch (err) {
      console.warn(`[fetchNonce] Failed for ${url}:`, err.message);
    }
  }

  throw new Error("Nonce not found in any URL");
}

function parseAdvancedSearchHTML(html) {
  if (!html || html.includes("No results found")) return [];

  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  $(".flex.rounded-lg.overflow-hidden").each((_, el) => {
    const $el = $(el);
    const $imgLink = $el.find("a[href*='/manga/']").first();
    const url = $imgLink.attr("href");
    if (!url) return;

    const slugMatch = /\/manga\/([^/]+)\/?$/.exec(url);
    const slug = slugMatch ? slugMatch[1] : null;
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);

    const rawTitle = $imgLink.find("img").attr("alt") || slug.replace(/-/g, " ");
    const title = rawTitle.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
    const cover = cleanImageUrl($imgLink.find("img").attr("src") || null);
    const chapter = $el.find("a[href*='/chapter-'] p").first().text().trim() || null;
    const rawUpdated =
      $el.find("time[datetime]").first().attr("datetime") ||
      $el.find("time").first().text().trim() ||
      $el.find("a[href*='/chapter-'] .text-gray-500, a[href*='/chapter-'] .text-xs").first().text().trim() ||
      null;
    const updatedTime =
      (parseIkiruDatetime(rawUpdated) || parseLooseRelativeTime(rawUpdated))?.toISOString() || null;
    const rating = $el.find(".numscore").first().text().trim() || null;

    results.push({
      title,
      url: toAbsoluteUrl(url),
      mangaUrl: toAbsoluteUrl(url),
      slug,
      cover,
      chapter,
      rating,
      updatedTime,
      source: "ikiru",
    });
  });

  return results;
}

export async function scrapeMangaCover(mangaUrl, redis = null) {
  try {
    const res = await scrapeWithHeaders(mangaUrl, redis);
    const $ = cheerio.load(res.data);
    const rawCover = $(".summary_image img, .thumb img, img.wp-post-image").first().attr("src");
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
      if (Array.isArray(cached)) {
        console.log(`Cache hit "${keyword}": ${cached.length} results`);
        return cached;
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

    const results = parseAdvancedSearchHTML(
      typeof res.data === "string" ? res.data : JSON.stringify(res.data),
    );

    if (redis && results.length > 0) {
      await redis
        .set(cacheKey, results, { ex: 600 })
        .catch((err) => console.warn("[searchIkiru] Redis set failed:", err.message));
    }

    console.log(`Search "${keyword}": ${results.length} results`);
    return results;
  } catch (err) {
    console.error(`[searchIkiru] Search failed for "${keyword}":`, err.message);
    return [];
  }
}

