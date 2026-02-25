import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const SITE_URL = "https://02.ikiru.wtf/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function sendDiscord(data) {
  // Status emoji mapping
  const statusEmoji = {
    "Ongoing": "🟢",
    "Completed": "🔵",
    "Hiatus": "🟡",
    "Unknown": "⚪"
  };
  
  // Build fields array
  const fields = [
    {
      name: "⭐ Rating",
      value: data.rating !== "N/A" ? `**${data.rating}** / 10` : "No rating",
      inline: true
    },
    {
      name: "📊 Status",
      value: `${statusEmoji[data.status] || "⚪"} ${data.status}`,
      inline: true
    }
  ];
  
  // Add updated time if available
  if (data.updatedTime) {
    const timeAgo = formatTimeAgo(data.updatedTime);
    fields.push({
      name: "🕐 Updated",
      value: timeAgo,
      inline: true
    });
  }

  // Build description with synopsis if available
  let descriptionText = `**${data.chapter}**`;
  if (data.description) {
    descriptionText += `\n\n📄 **Synopsis:**\n${data.description}`;
  }
  descriptionText += `\n\n[Read Chapter](${data.url})`;
  
  // Add source badge
  const sourceEmoji = data.source === "Project Updates" ? "📌" : "🆕";
  const sourceText = data.source === "Project Updates" ? "From Your Library" : "Latest Release";

  const payload = {
    embeds: [
      {
        title: `📖 ${data.title}`,
        description: descriptionText,
        url: data.url,
        color: getStatusColor(data.status),
        fields: fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: `${sourceEmoji} ${sourceText} • ikiru.wtf`,
          icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png"
        }
      },
    ],
  };

  // Only add image if cover exists and is valid
  if (data.cover && data.cover.startsWith("http")) {
    payload.embeds[0].thumbnail = { url: data.cover };
  }

  await axios.post(WEBHOOK, payload);
}

function getStatusColor(status) {
  const colors = {
    "Ongoing": 0x22c55e,    // Green
    "Completed": 0x3b82f6,  // Blue
    "Hiatus": 0xeab308,     // Yellow
    "Unknown": 0x6b7280     // Gray
  };
  return colors[status] || 0x5814783;
}

function formatTimeAgo(datetime) {
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

async function scrapeSection($, sectionName) {
  const results = [];
  let inSection = false;
  
  $("*").each((i, el) => {
    const tagName = el.tagName?.toLowerCase();
    const text = $(el).text().trim();
    
    // Check if we hit the section header
    if (tagName === "h1" && text === sectionName) {
      inSection = true;
    }
    
    // Check if we hit the next section (stop)
    if (inSection && tagName === "h1" && text !== sectionName && text.includes("Updates")) {
      return false;
    }
    
    // Process chapter links in this section
    if (inSection && tagName === "a") {
      const card = $(el);
      const link = card.attr("href");
      const chapterText = card.find("p").text().trim();
      
      if (chapterText.includes("Chapter")) {
        const parent = card.parent();
        
        // Get title from h1 in parent element
        let title = parent.find("h1").text().trim();
        // Fallback to h3
        if (!title) {
          title = card.find("h3").text().trim();
        }
        
        // Get cover from parent element
        let cover = parent.find("img").first().attr("src");
        
        // Get rating from .numscore
        const rating = parent.find(".numscore").text().trim();
        
        // Get status (Ongoing/Completed)
        const status = parent.find("p.font-normal.text-xs").filter((_, el) => {
          const text = $(el).text().trim();
          return text === "Ongoing" || text === "Completed" || text === "Hiatus";
        }).text().trim();
        
        // Get last updated time
        const updatedTime = card.find("time").attr("datetime") || card.find("time").text().trim();

        // Fix relative URLs
        let fixedUrl = link;
        if (fixedUrl && !fixedUrl.startsWith("http")) {
          fixedUrl = "https://02.ikiru.wtf" + fixedUrl;
        }
        if (cover && !cover.startsWith("http")) {
          cover = "https://02.ikiru.wtf" + cover;
        }

        // Get manga detail page URL for description
        const mangaUrl = fixedUrl.replace(/\/chapter-[^/]+\/$/, '/');

        if (link && title && chapterText) {
          results.push({
            title,
            chapter: chapterText,
            url: fixedUrl,
            cover,
            mangaUrl,
            rating: rating || "N/A",
            status: status || "Unknown",
            updatedTime,
            source: sectionName, // Track which section this came from
          });
        }
      }
    }
  });
  
  return results;
}

async function scrape() {
  const res = await axios.get(SITE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  const html = res.data;
  const $ = cheerio.load(html);

  // Scrape both sections
  const projectUpdates = await scrapeSection($, "Project Updates");
  const latestUpdates = await scrapeSection($, "Latest Updates");
  
  // Merge and remove duplicates (same URL)
  const seen = new Set();
  const allResults = [];
  
  for (const item of [...projectUpdates, ...latestUpdates]) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      allResults.push(item);
    }
  }
  
  // Filter: only chapters updated within last 24 hours (fresh)
  const now = new Date();
  const freshResults = allResults.filter(item => {
    if (!item.updatedTime) return false;
    const updateDate = new Date(item.updatedTime);
    const diffHours = (now - updateDate) / (1000 * 60 * 60);
    return diffHours <= 24;
  });
  
  // Sort: Project Updates first, then Latest Updates
  const sortedResults = freshResults.sort((a, b) => {
    if (a.source === "Project Updates" && b.source !== "Project Updates") return -1;
    if (a.source !== "Project Updates" && b.source === "Project Updates") return 1;
    return 0;
  });

  return sortedResults;
}

async function fetchDescription(mangaUrl) {
  try {
    if (!mangaUrl) return null;
    const res = await axios.get(mangaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 5000,
    });
    const $ = cheerio.load(res.data);
    
    // Try to get description from meta tag
    let description = $('meta[name="description"]').attr("content");
    
    // Fallback: try to find description in page content
    if (!description) {
      description = $(".description, .summary, [class*='description'], [class*='summary']").first().text().trim();
    }
    
    // Truncate if too long (Discord limit is 4096 for description, but we want it concise)
    if (description && description.length > 300) {
      description = description.substring(0, 297) + "...";
    }
    
    return description;
  } catch (err) {
    console.error("Failed to fetch description:", err.message);
    return null;
  }
}

export default async function handler(req, res) {
  // Proteksi: hanya izinkan dari GitHub Actions atau manual trigger dengan secret
  const userAgent = req.headers["user-agent"] || "";
  const isGitHubActions = userAgent.includes("GitHub-Actions");
  
  if (!isGitHubActions) {
    return res.status(403).json({ error: "Forbidden - Only GitHub Actions allowed" });
  }

  try {
    const items = await scrape();

    const pageHash = hash(JSON.stringify(items));
    const lastHash = await redis.get("page_hash");

    if (lastHash === pageHash) {
      return res.status(200).json({ message: "No changes" });
    }

    for (const item of items) {
      const key = `chapter:${item.url}`;
      const exists = await redis.get(key);

      if (!exists) {
        // Fetch description for new chapters
        const description = await fetchDescription(item.mangaUrl);
        item.description = description;
        
        await sendDiscord(item);
        await redis.set(key, "sent");
      }
    }

    await redis.set("page_hash", pageHash);

    return res.status(200).json({
      success: true,
      newItems: items.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message,
    });
  }
}