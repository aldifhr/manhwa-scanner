import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";
const AJAX_PATH = "wp-admin/admin-ajax.php";

// ─── UTILS ────────────────────────────────────────────────────────────────────
const withRetry = async (fn, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`⚠️ Retry ${i + 1}/${retries}...`);
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
};

export const formatTimeAgo = (datetime) => {
  try {
    const diffMs = new Date() - new Date(datetime);
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    return mins < 1 ? "Just now" :
           mins < 60 ? `${mins} min ago` :
           hours < 24 ? `${hours} hour${hours > 1 ? "s" : ""} ago` :
           `${days} day${days > 1 ? "s" : ""} ago`;
  } catch {
    return datetime;
  }
};

export const STATUS_EMOJI = { Ongoing: "🟢", Completed: "🔵", Hiatus: "🟡", Unknown: "⚪" };
export const getStatusColor = (status) => ({
  Ongoing: 0x22c55e, Completed: 0x3b82f6, Hiatus: 0xf59e0b, Unknown: 0x6b7280
}[status] || 0x6b7280);

// ─── CORE FUNCTIONS ───────────────────────────────────────────────────────────
export async function sendErrorLog(webhookUrl, error, context = "") {
  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title: "❌ Bot Error",
        description: `\`\`\`${error.message || error}\`\`\``,
        color: 0xff0000,
        fields: [
          { name: "Context", value: context || "Unknown", inline: true },
          { name: "Time", value: new Date().toISOString(), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }]
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
    const res = await withRetry(() => axios.get(mangaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    }));
    const $ = cheerio.load(res.data);

    let desc = $('meta[name="description"]').attr("content") ||
               $(".description, .summary, [class*='description']").first().text().trim();

    desc = desc?.length > 300 ? desc.substring(0, 297) + "..." : desc;

    if (redis && desc) {
      await redis.set(cacheKey, desc, { ex: 1800 }); // 30min
    }

    return desc;
  } catch {
    return null;
  }
}

// ─── MAIN SCRAPER (NO CACHE — always fresh for real-time detection) ───────────
export async function scrapeMangaUpdates() {
  try {
    const res = await withRetry(() => axios.get(SITE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 10000,
    }));

    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    const items = $("#latest-list:not(.group-data-direction\\:horizontal\\:hidden) > div");

    items.each((i, el) => {
      const card = $(el);

      const chapterLink = card.find('a[href*="/chapter-"]').first();
      if (!chapterLink.length) return;

      const $time = chapterLink.find("time[datetime]").first();
      const $chapterP = chapterLink.find('p:contains("Chapter")').first();
      if (!$time.length || !$chapterP.length) return;

      const updatedTime = $time.attr("datetime");
      const chapterText = $chapterP.text().trim();

      let title = card.find("h1,h3,.text-15px,.font-bold").first().text().trim();
      if (!title) {
        const href = chapterLink.attr("href");
        title = href?.split("/manga/")[1]?.split("/")[0]?.replace(/-/g, " ") || "Unknown";
      }

      const key = `${title}-${chapterText}`;
      if (seen.has(key)) return;
      seen.add(key);

      if (!updatedTime) return;
      const diffHours = (new Date() - new Date(updatedTime)) / 3600000;
      if (diffHours > 24) return;

      let url = chapterLink.attr("href");
      if (url?.startsWith("/")) url = `${SITE_URL}${url.slice(1)}`;

      const mangaUrl = url?.replace(/\/chapter-[^/]+\/?$/, "/") || null;

      let cover = card.find("img").first().attr("src") || null;
      if (cover?.startsWith("/")) cover = `${SITE_URL}${cover.slice(1)}`;
      if (cover) cover = cover.replace(/-\d+x\d+/, "");

      const rating = card.find(".numscore").text().trim() || "N/A";
      const status = card.find("p.font-normal.text-xs")
        .filter((_, el) => ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()))
        .text().trim() || "Unknown";

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

    console.log(`🔍 Scraped: ${results.length} items`);
    return results;
  } catch (err) {
    console.error("Scrape failed:", err.message);
    return [];
  }
}

// ─── POPULAR ──────────────────────────────────────────────────────────────────
export async function scrapePopular() {
  try {
    const res = await withRetry(() => axios.get(SITE_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    }));

    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $(".swiper-slide a[href*='/manga/'], [class*='slide'] a[href*='/manga/']").each((i, el) => {
      const $el = $(el);
      const title = $el.attr("title") || $el.find("h4").text().trim();
      const link = $el.attr("href");
      const cover = $el.find("img").first().attr("src");

      if (title && link && !seen.has(title)) {
        seen.add(title);
        results.push({
          title,
          url: link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
          cover: cover?.startsWith("http") ? cover : `https://02.ikiru.wtf${cover}`,
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

function parseAdvancedSearchHTML(html) {
  if (!html || html.includes("No results found")) return [];

  const results = [];
  const seenSlugs = new Set();

  const blocks = html.split('class="flex rounded-lg overflow-hidden h-46');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const urlMatch = /href="(https?:\/\/[^"]+\/manga\/([^"/]+)\/)"\s+class="min-w-\[120px\]/.exec(block);
    if (!urlMatch) continue;

    const [_, url, slug] = urlMatch;
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const titleMatch = /alt="([^"]+)"/.exec(block);
    const title = titleMatch ? titleMatch[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)) : slug.replace(/-/g, " ");

    const imgMatch = /src="([^"]+128x\d+[^"]*)"/.exec(block);
    const cover = imgMatch ? imgMatch[1] : null;

    const chapterMatch = /Chapter\s+([\d.]+)/.exec(block);
    const chapter = chapterMatch ? `Chapter ${chapterMatch[1]}` : null;

    const ratingMatch = /(?:>|\s)((?:10|\d)\.?\d{0,2})<\/span/.exec(block);
    const rating = ratingMatch ? ratingMatch[1] : null;

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
        console.log(`⚡ Cache hit "${keyword}": ${JSON.parse(cached).length} results`);
        return JSON.parse(cached);
      }
    } catch {}
  }

  try {
    const nonce = await fetchNonce();
    const params = new URLSearchParams({
      action: "advanced_search",
      search_nonce: nonce,
      query: keyword,
      ...opts
    });

    const res = await withRetry(() => axios.post(
      `${SITE_URL}${AJAX_PATH}`,
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0",
          "Referer": `${SITE_URL}advanced-search/`,
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 15000,
      }
    ));

    const results = parseAdvancedSearchHTML(typeof res.data === "string" ? res.data : JSON.stringify(res.data));

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