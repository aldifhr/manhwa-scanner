import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const SITE_URL = "https://02.ikiru.wtf/";

async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`⚠️ Retry ${i + 1}/${retries} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

export async function sendErrorLog(webhookUrl, error, context = "") {
  try {
    const payload = {
      embeds: [{
        title: "❌ Bot Error",
        description: `\`\`\`${error.message || error}\`\`\``,
        color: 0xff0000,
        fields: [
          { name: "Context", value: context || "Unknown", inline: true },
          { name: "Time", value: new Date().toISOString(), inline: true }
        ],
        timestamp: new Date().toISOString()
      }]
    };
    await axios.post(webhookUrl, payload);
  } catch (err) {
    console.error("Failed to send error log:", err.message);
  }
}

export async function loadWhitelist(redis = null) {
  try {
    if (redis) {
      const data = await redis.get("whitelist:manga");
      if (data) {
        // Handle both array and string formats
        const manga = Array.isArray(data) ? data : JSON.parse(data);
        return manga.map(title => title.toLowerCase());
      }
    }
    // Fallback to file
    const data = JSON.parse(fs.readFileSync("./whitelist.json", "utf-8"));
    return data.manga.map(title => title.toLowerCase());
  } catch (err) {
    console.error("Load whitelist error:", err.message);
    return [];
  }
}

export function formatTimeAgo(datetime) {
  try {
    const date = new Date(datetime);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  } catch {
    return datetime;
  }
}

export function getStatusColor(status) {
  const colors = {
    "Ongoing": 0x22c55e,
    "Completed": 0x3b82f6,
    "Hiatus": 0xeab308,
    "Unknown": 0x6b7280
  };
  return colors[status] || 0x5814783;
}

export async function fetchDescription(mangaUrl, redis = null) {
  try {
    if (!mangaUrl) return null;
    
    // Check cache first
    const cacheKey = `desc:${mangaUrl}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    }
    
    const res = await withRetry(() => axios.get(mangaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    }));
    const $ = cheerio.load(res.data);
    
    let description = $('meta[name="description"]').attr("content");
    if (!description) {
      description = $(".description, .summary, [class*='description'], [class*='summary']").first().text().trim();
    }
    
    const result = description && description.length > 300 
      ? description.substring(0, 297) + "..." 
      : description;
    
    // Cache for 7 days
    if (redis && result) {
      await redis.set(cacheKey, result, { ex: 604800 });
    }
    
    return result;
  } catch {
    return null;
  }
}

export async function scrapeSection($, sectionName) {
  const results = [];
  let inSection = false;
  
  $("*").each((i, el) => {
    const tagName = el.tagName?.toLowerCase();
    const text = $(el).text().trim();
    
    if (tagName === "h1" && text === sectionName) {
      inSection = true;
    }
    
    if (inSection && tagName === "h1" && text !== sectionName && text.includes("Updates")) {
      return false;
    }
    
    if (inSection && tagName === "a") {
      const card = $(el);
      const link = card.attr("href");
      const chapterText = card.find("p").text().trim();
      
      if (chapterText.includes("Chapter")) {
        const parent = card.parent();
        let title = parent.find("h1").text().trim();
        if (!title) title = card.find("h3").text().trim();
        
        let cover = parent.find("img").first().attr("src");
        const rating = parent.find(".numscore").text().trim();
        const status = parent.find("p.font-normal.text-xs").filter((_, el) => {
          const t = $(el).text().trim();
          return ["Ongoing", "Completed", "Hiatus"].includes(t);
        }).text().trim() || "Unknown";
        
        const updatedTime = card.find("time").attr("datetime");
        
        let fixedUrl = link;
        if (fixedUrl && !fixedUrl.startsWith("http")) {
          fixedUrl = "https://02.ikiru.wtf" + fixedUrl;
        }
        if (cover && !cover.startsWith("http")) cover = "https://02.ikiru.wtf" + cover;
        
        const mangaUrl = fixedUrl.replace(/\/chapter-[^/]+\/$/, '/');
        
        if (link && title && chapterText) {
          results.push({
            title,
            chapter: chapterText,
            url: fixedUrl,
            cover,
            mangaUrl,
            rating: rating || "N/A",
            status,
            updatedTime,
            source: sectionName,
          });
        }
      }
    }
  });
  
  return results;
}

export async function scrapeMangaUpdates(redis = null) {
  const res = await withRetry(() => axios.get(SITE_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000,
  }));

  const $ = cheerio.load(res.data);
  
  const projectUpdates = await scrapeSection($, "Project Updates");
  const latestUpdates = await scrapeSection($, "Latest Updates");
  
  // Merge and deduplicate
  const seen = new Set();
  const allResults = [];
  
  for (const item of [...projectUpdates, ...latestUpdates]) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      allResults.push(item);
    }
  }
  
  // Filter: only last 24 hours
  const now = new Date();
  const freshResults = allResults.filter(item => {
    if (!item.updatedTime) return false;
    const updateDate = new Date(item.updatedTime);
    const diffHours = (now - updateDate) / (1000 * 60 * 60);
    return diffHours <= 24;
  });
  
  // Filter by whitelist
  const whitelist = await loadWhitelist();
  if (whitelist.length > 0) {
    return freshResults.filter(item => 
      whitelist.some(w => item.title.toLowerCase().includes(w))
    );
  }
  
  return freshResults;
}

export function sortBySource(results) {
  return results.sort((a, b) => {
    if (a.source === "Project Updates" && b.source !== "Project Updates") return -1;
    if (a.source !== "Project Updates" && b.source === "Project Updates") return 1;
    return 0;
  });
}
