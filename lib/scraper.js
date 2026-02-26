import axios        from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";

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
    const tagName     = el.tagName?.toLowerCase();
    const text        = $(el).text().trim();

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
      console.error("Scrape section error:", err.message);
  return [];
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

// ─── Search Ikiru ─────────────────────────────────────────────────────────────

export async function searchIkiru(keyword) {
  try {
    // Step 1: POST langsung ke advanced_search (no nonce needed)
    const formData = new URLSearchParams({
      action: 'advanced_search',
      search_term: keyword,
      the_page: 1,
      project: 0
    });

    const res = await withRetry(() => axios.post(
      `${SITE_URL}wp-admin/admin-ajax.php`,
      formData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": `${SITE_URL}advanced-search/?search_term=${encodeURIComponent(keyword)}`,
        },
        timeout: 10000,
      }
    ));

    // Parse HTML response
    const $ = cheerio.load(res.data);
    const results = [];

    // Selector dari HTML asli (h3 title, p desc, img cover)
    $("#searchResults a[href*='/manga/'], .search-item a[href*='/manga/']").each((_, el) => {
      const card = $(el);
      const url = card.attr('href');
      const title = card.find('h3, h4, .title').first().text().trim();
      const cover = card.find('img').first().attr('src') || card.find('.cover img').attr('src');
      const desc = card.find('p, .desc, .description').first().text().trim();

      if (title && url) {
        results.push({
          title,
          url: url.startsWith('http') ? url : `${SITE_URL}${url}`,
          cover: cover?.startsWith('http') ? cover : `${SITE_URL}${cover}`,
          desc: desc.substring(0, 150) + '...'
        });
      }
    });

    console.error(`✅ Search "${keyword}": ${results.length} results`);  // ESLint OK
    return results.slice(0, 10);
  } catch (err) {
    console.error("❌ Search error:", err.message);  // ESLint OK
    return [];
  }
}

