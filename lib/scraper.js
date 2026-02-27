import axios        from "axios";
import * as cheerio from "cheerio";

const SITE_URL  = "https://02.ikiru.wtf/";
const AJAX_PATH = "wp-admin/admin-ajax.php";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`⚠️ Retry ${i + 1}/${retries} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export async function sendErrorLog(webhookUrl, error, context = "") {
  try {
    const payload = {
      embeds: [{
        title:       "❌ Bot Error",
        description: `\`\`\`${error.message || error}\`\`\``,
        color:       0xff0000,
        fields: [
          { name: "Context", value: context || "Unknown", inline: true },
          { name: "Time",    value: new Date().toISOString(), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    };
    await axios.post(webhookUrl, payload);
  } catch (err) {
    console.error("Failed to send error log:", err.message);
  }
}

export function formatTimeAgo(datetime) {
  try {
    const date      = new Date(datetime);
    const now       = new Date();
    const diffMs    = now - date;
    const diffMins  = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays  = Math.floor(diffMs / 86400000);

    if (diffMins  < 1)  return "Just now";
    if (diffMins  < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  } catch {
    return datetime;
  }
}

export const STATUS_EMOJI = {
  Ongoing:   "🟢",
  Completed: "🔵",
  Hiatus:    "🟡",
  Unknown:   "⚪",
};

export function getStatusColor(status) {
  const colors = {
    Ongoing:   0x22c55e,
    Completed: 0x3b82f6,
    Hiatus:    0xf59e0b,
    Unknown:   0x6b7280,
  };
  return colors[status] || 0x6b7280;
}

// ─── Fetch Description ────────────────────────────────────────────────────────

export async function fetchDescription(mangaUrl) {
  try {
    if (!mangaUrl) return null;

    const res = await withRetry(() => axios.get(mangaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    }));
    const $ = cheerio.load(res.data);

    let description = $('meta[name="description"]').attr("content");
    if (!description) {
      description = $(".description, .summary, [class*='description'], [class*='summary']")
        .first().text().trim();
    }

    return description && description.length > 300
      ? description.substring(0, 297) + "..."
      : description;
  } catch {
    return null;
  }
}

// ─── Scrape Section ───────────────────────────────────────────────────────────

export async function scrapeSection($, sectionName) {
  const results = [];
  let inSection = false;

  $("*").each((i, el) => {
    const tagName = el.tagName?.toLowerCase();
    const text    = $(el).text().trim();

    if (tagName === "h1" && text === sectionName) {
      inSection = true;
    }

    if (inSection && tagName === "h1" && text !== sectionName && text.includes("Updates")) {
      return false;
    }

    if (inSection && tagName === "a") {
      const card        = $(el);
      const link        = card.attr("href");
      const chapterText = card.find("p").text().trim();

      if (chapterText.includes("Chapter")) {
        const parent = card.parent();
        let title    = parent.find("h1").text().trim();
        if (!title) title = card.find("h3").text().trim();

        let cover     = parent.find("img").first().attr("src");
        const rating  = parent.find(".numscore").text().trim();
        const status  = parent.find("p.font-normal.text-xs").filter((_, el) => {
          const t = $(el).text().trim();
          return ["Ongoing", "Completed", "Hiatus"].includes(t);
        }).text().trim() || "Unknown";

        const updatedTime = card.find("time").attr("datetime");

        let fixedUrl = link;
        if (fixedUrl && !fixedUrl.startsWith("http")) {
          fixedUrl = "https://02.ikiru.wtf" + fixedUrl;
        }
        if (cover && !cover.startsWith("http")) cover = "https://02.ikiru.wtf" + cover;

        const mangaUrl = fixedUrl.replace(/\/chapter-[^/]+\/$/, "/");

        if (link && title && chapterText) {
          results.push({
            title,
            chapter:     chapterText,
            url:         fixedUrl,
            cover,
            mangaUrl,
            rating:      rating || "N/A",
            status,
            updatedTime,
            source:      sectionName,
          });
        }
      }
    }
  });

  return results;
}

// ─── Scrape Latest Updates ────────────────────────────────────────────────────

export async function scrapeMangaUpdates(redis = null) {
  if (redis) {
    try {
      const cached = await redis.get("cache:updates");
      if (cached) {
        console.log("⚡ Using cached updates");
        return cached;
      }
    } catch (err) {
      console.error("Redis get error:", err.message);
    }
  }

  const res = await withRetry(() => axios.get(SITE_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000,
  }));

  const $             = cheerio.load(res.data);
  const latestUpdates = await scrapeSection($, "Latest Updates");

  const now          = new Date();
  const freshResults = latestUpdates.filter(item => {
    if (!item.updatedTime) return false;
    const updateDate = new Date(item.updatedTime);
    const diffHours  = (now - updateDate) / (1000 * 60 * 60);
    return diffHours <= 24;
  });

  if (redis) {
    try {
      await redis.set("cache:updates", JSON.stringify(freshResults), { ex: 300 });
      console.log("💾 Updates cached for 5 minutes");
    } catch (err) {
      console.error("Failed to cache updates:", err.message);
    }
  }

  return freshResults;
}

// ─── Scrape Popular ───────────────────────────────────────────────────────────

export async function scrapePopular() {
  const res = await withRetry(() => axios.get(SITE_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000,
  }));

  const $       = cheerio.load(res.data);
  const results = [];
  let inPopularSection = false;

  $("*").each((i, el) => {
    const tagName = el.tagName?.toLowerCase();
    const text    = $(el).text().trim();

    if ((tagName === "h1" || tagName === "h2") && text.toLowerCase().includes("popular")) {
      inPopularSection = true;
    }

    if (inPopularSection && (tagName === "h1" || tagName === "h2") && !text.toLowerCase().includes("popular")) {
      inPopularSection = false;
    }

    if (inPopularSection) {
      const slide = $(el).closest(".swiper-slide, [class*='slide']");
      if (slide.length > 0) {
        const link   = slide.find("a").first().attr("href");
        const title  = slide.find("h4").text().trim() || slide.find("a").first().attr("title");
        const cover  = slide.find("img.cover-image, img").first().attr("src");
        const rating = slide.find(".details p, .rating").text().trim();

        if (title && link && !results.find(r => r.title === title)) {
          results.push({
            title,
            url:    link.startsWith("http")   ? link  : `https://02.ikiru.wtf${link}`,
            cover:  cover?.startsWith("http") ? cover : `https://02.ikiru.wtf${cover}`,
            rating: rating || "N/A",
          });
        }
      }
    }
  });

  if (results.length === 0) {
    $(".swiper-slide a[href*='/manga/'], .manga-swipe a[href*='/manga/']").each((i, el) => {
      const card   = $(el);
      const title  = card.attr("title") || card.find("h4").text().trim();
      const link   = card.attr("href");
      const cover  = card.find("img").first().attr("src");
      const rating = card.find(".details p").text().trim();

      if (title && link && !results.find(r => r.title === title)) {
        results.push({
          title,
          url:    link.startsWith("http")   ? link  : `https://02.ikiru.wtf${link}`,
          cover:  cover?.startsWith("http") ? cover : `https://02.ikiru.wtf${cover}`,
          rating: rating || "N/A",
        });
      }
    });
  }

  return results.slice(0, 10);
}

// ─── Nonce Fetcher ────────────────────────────────────────────────────────────

const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
  /nonce["'\s:=]+([a-f0-9]{10})/,
];

async function fetchNonce() {
  // Coba beberapa URL sumber nonce
  const sources = [
    `${SITE_URL}advanced-search/`,
    `${SITE_URL}manga/`,
    SITE_URL,
  ];

  for (const url of sources) {
    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
        timeout: 8000,
      });
      for (const pattern of NONCE_PATTERNS) {
        const match = res.data.match(pattern);
        if (match) {
          console.log(`✅ Nonce dari ${url}: ${match[1]}`);
          return match[1];
        }
      }
    } catch (err) {
      console.warn(`⚠️ Gagal fetch nonce dari ${url}: ${err.message}`);
    }
  }

  throw new Error("Nonce tidak ditemukan di semua sumber");
}

// ─── Advanced Search HTML Parser ─────────────────────────────────────────────

function parseAdvancedSearchHTML(html) {
  if (!html || html.trim().length === 0) return [];
  if (html.includes("No results found"))  return [];

  const results   = [];
  const seenSlugs = new Set();

  const cardBlocks = html.split('<div class="flex rounded-lg overflow-hidden h-46');

  for (let i = 1; i < cardBlocks.length; i++) {
    const block = cardBlocks[i];

    const urlM = /href="(https?:\/\/[^"]+\/manga\/([^"/]+)\/)"\s+class="min-w-\[120px\]/.exec(block);
    if (!urlM) continue;

    const url  = urlM[1];
    const slug = urlM[2];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const imgM   = /src="([^"]+128x\d+[^"]*)"/.exec(block);
    const cover  = imgM ? imgM[1] : null;

    const altM  = /alt="([^"]+)"/.exec(block);
    const title = altM ? decodeHtmlEntities(altM[1]) : slug.replace(/-/g, " ");

    const chapterM = /Chapter\s+([\d.]+)/.exec(block);
    const chapter  = chapterM ? `Chapter ${chapterM[1]}` : null;

    const statusM = /class="[^"]*(?:bg-green|bg-blue|bg-yellow|bg-orange|bg-accent)[^"]*"[^>]*>\s*([^<]+?)\s*<\/span/.exec(block);
    const status  = statusM ? statusM[1].trim() : extractStatus(block);

    const ratingM = /(?:>|\s)((?:10|\d)\.?\d{0,2})<\/span/.exec(block);
    const rating  = ratingM ? ratingM[1] : null;

    const genreM  = block.match(/class="[^"]*genre[^"]*"[^>]*>([^<]+)<\/a>/g) || [];
    const genres  = genreM.map(g => g.replace(/<[^>]+>/g, "").trim()).filter(Boolean);

    results.push({ title, url, slug, cover, chapter, status, rating,
      genres: genres.length ? genres : undefined });
  }

  // Fallback: regex URL saja kalau parser utama gagal
  if (results.length === 0) {
    const re   = /href="(https?:\/\/[^"]+\/manga\/([^"/]+)\/)"/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
      const [, furl, fslug] = m;
      if (!seen.has(fslug) && !fslug.includes("chapter")) {
        seen.add(fslug);
        results.push({ title: fslug.replace(/-/g, " "), url: furl,
          slug: fslug, cover: null, chapter: null, status: null, rating: null });
      }
    }
  }

  return results;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'");
}

function extractStatus(block) {
  const lower = block.toLowerCase();
  if (lower.includes("ongoing"))   return "Ongoing";
  if (lower.includes("completed")) return "Completed";
  if (lower.includes("hiatus"))    return "On-Hiatus";
  if (lower.includes("dropped"))   return "Dropped";
  return null;
}

// ─── Search Ikiru (Advanced) ──────────────────────────────────────────────────
// Menggunakan action=advanced_search dengan auto-pagination.
// Hasil di-cache ke Redis selama 10 menit per keyword+opts.
// Caller tinggal slice sesuai kebutuhan (search.js, search-page.js, dll).

export async function searchIkiru(keyword, opts = {}, redis = null) {
  const {
    genre        = [],
    excludeGenre = [],
    type         = [],
    status       = [],
    orderby      = "popular",
    order        = "",
    startPage    = 1,
    maxResults   = 0,   // 0 = semua
    delay        = 300, // ms antar halaman
  } = opts;

  // ── Cache key ─────────────────────────────────────────────────────────────
  const cacheKey = `cache:search:${keyword}:${JSON.stringify(opts)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        console.log(`⚡ Cache hit "${keyword}": ${parsed.length} hasil`);
        return parsed;
      }
    } catch (err) {
      console.error("Redis get error:", err.message);
    }
  }

  // ── Step 1: Ambil nonce ───────────────────────────────────────────────────
  let nonce;
  try {
    nonce = await fetchNonce();
  } catch (err) {
    console.error("❌ Gagal ambil nonce:", err.message);
    return [];
  }

  // ── Step 2: Helper build params ───────────────────────────────────────────
  const buildParams = (page) => {
    const params = new URLSearchParams();
    params.append("action",        "advanced_search");
    params.append("search_nonce",  nonce);
    params.append("query",         keyword);
    if (orderby)  params.append("orderby", orderby);
    if (order)    params.append("order",   order);
    if (page > 1) params.append("page",    page);

    for (const g of genre)        params.append("genre[]",          g);
    for (const g of excludeGenre) params.append("genre_exclude[]",  g);
    for (const t of type)         params.append("type[]",           t);
    for (const s of status)       params.append("status[]",         s);

    return params;
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── Step 3: Pagination loop ───────────────────────────────────────────────
  const allResults     = [];
  const seenSlugs      = new Set();
  let   currentPage    = startPage;
  let   consecutiveEmpty = 0;
  const MAX_EMPTY_RETRY  = 1;

  while (true) {
    let html;
    try {
      const res = await withRetry(() => axios.post(
        `${SITE_URL}${AJAX_PATH}`,
        buildParams(currentPage),
        {
          headers: {
            "Content-Type":     "application/x-www-form-urlencoded",
            "User-Agent":       "Mozilla/5.0",
            "Referer":          `${SITE_URL}advanced-search/`,
            "X-Requested-With": "XMLHttpRequest",
          },
          timeout: 15000,
        }
      ));
      html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    } catch (err) {
      console.error(`❌ Error fetch halaman ${currentPage}:`, err.message);
      break;
    }

    const pageResults  = parseAdvancedSearchHTML(html);
    const freshResults = pageResults.filter(r => !seenSlugs.has(r.slug));
    freshResults.forEach(r => seenSlugs.add(r.slug));

    console.log(`📄 Halaman ${currentPage}: ${freshResults.length} hasil baru`);

    if (freshResults.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty > MAX_EMPTY_RETRY) {
        console.log("✅ Semua halaman selesai di-fetch.");
        break;
      }
      console.log(`⚠️ Halaman kosong, retry (${consecutiveEmpty}/${MAX_EMPTY_RETRY})...`);
      currentPage++;
      await sleep(delay);
      continue;
    }

    consecutiveEmpty = 0;
    allResults.push(...freshResults);

    if (maxResults > 0 && allResults.length >= maxResults) {
      console.log(`✅ maxResults ${maxResults} tercapai.`);
      break;
    }

    currentPage++;
    await sleep(delay);
  }

  console.log(`✅ searchIkiru "${keyword}": ${allResults.length} total hasil`);
  const finalResults = maxResults > 0 ? allResults.slice(0, maxResults) : allResults;

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(finalResults), { ex: 600 }); // 10 menit
      console.log(`💾 Search "${keyword}" cached (${finalResults.length} hasil, 10 menit)`);
    } catch (err) {
      console.error("Redis set error:", err.message);
    }
  }

  return finalResults;
}