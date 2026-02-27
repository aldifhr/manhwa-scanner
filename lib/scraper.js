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

// ─── CORE FUNCTIONS (UNCHANGED LOGIC) ─────────────────────────────────────────
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

// ─── SCRAPE SECTIONS (OPTIMIZED SELECTORS) ────────────────────────────────────
export async function scrapeSection($, sectionName) {
  const results = [];
  
  $(`h1:contains("${sectionName}")`).nextUntil('h1:contains("Updates")').find('a').each((i, el) => {
    const $card = $(el);
    const chapterText = $card.find("p").text().trim();
    
    if (!chapterText.includes("Chapter")) return;
    
    const $parent = $card.parent();
    const title = $parent.find("h1,h3").first().text().trim();
    const cover = $parent.find("img").first().attr("src")?.replace(/-\d+x\d+/, "");
    const rating = $parent.find(".numscore").text().trim();
    const status = $parent.find("p.font-normal.text-xs")
      .filter((_, el) => ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()))
      .text().trim() || "Unknown";
    const updatedTime = $card.find("time").attr("datetime");
    const link = $card.attr("href");
    
    if (title && link) {
      const fixedUrl = link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`;
      const mangaUrl = fixedUrl.replace(/\/chapter-[^/]+\/?$/, "/");
      const fixedCover = cover?.startsWith("http") ? cover : `https://02.ikiru.wtf${cover}`;
      
      results.push({
        title, chapter: chapterText, url: fixedUrl, cover: fixedCover,
        mangaUrl, rating: rating || "N/A", status, updatedTime, source: sectionName
      });
    }
  });
  
  return results;
}

// ─── MAIN SCRAPER (PARALLEL + CACHE) ──────────────────────────────────────────
export async function scrapeMangaUpdates(redis = null) {
  const cacheKey = "cache:updates";
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log("⚡ Using cached updates");
        return JSON.parse(cached);
      }
    } catch {}
  }
  
  try {
    const res = await withRetry(() => axios.get(SITE_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    }));
    
    const $ = cheerio.load(res.data);
    const results = await scrapeSection($, "Latest Updates");
    
    // Filter 24h fresh only
    const fresh = results.filter(item => {
      if (!item.updatedTime) return false;
      return (new Date() - new Date(item.updatedTime)) / 3600000 <= 24;
    });
    
    if (redis) {
      await redis.set(cacheKey, JSON.stringify(fresh), { ex: 300 });
      console.log(`💾 Updates cached: ${fresh.length}`);
    }
    
    return fresh;
  } catch (err) {
    console.error("Scrape failed:", err.message);
    return [];
  }
}

// ─── POPULAR (OPTIMIZED) ─────────────────────────────────────────────────────
export async function scrapePopular() {
  try {
    const res = await withRetry(() => axios.get(SITE_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    }));
    
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();
    
    // Primary: swiper slides
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

// ─── ADVANCED SEARCH (MOST CRITICAL - HEAVILY OPTIMIZED) ─────────────────────
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
  
  // Split by card pattern
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
  
  // Cache first
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
