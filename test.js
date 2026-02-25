import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Load whitelist
let whitelist = [];
try {
  const whitelistData = JSON.parse(fs.readFileSync("./whitelist.json", "utf-8"));
  whitelist = whitelistData.manga.map(title => title.toLowerCase());
  console.log(`📋 Loaded ${whitelist.length} manga from whitelist`);
} catch (err) {
  console.log("⚠️ No whitelist found, sending all updates");
}

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

function getStatusColor(status) {
  const colors = {
    "Ongoing": 0x22c55e,
    "Completed": 0x3b82f6,
    "Hiatus": 0xeab308,
    "Unknown": 0x6b7280
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

async function fetchDescription(mangaUrl) {
  try {
    if (!mangaUrl) return null;
    const res = await axios.get(mangaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 5000,
    });
    const $ = cheerio.load(res.data);
    
    let description = $('meta[name="description"]').attr("content");
    
    if (!description) {
      description = $(".description, .summary, [class*='description'], [class*='summary']").first().text().trim();
    }
    
    if (description && description.length > 300) {
      description = description.substring(0, 297) + "...";
    }
    
    return description;
  } catch (err) {
    console.error("Failed to fetch description:", err.message);
    return null;
  }
}

async function scrapeSection($, sectionName) {
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
          const text = $(el).text().trim();
          return ["Ongoing", "Completed", "Hiatus"].includes(text);
        }).text().trim() || "Unknown";
        const updatedTime = card.find("time").attr("datetime");
        
        let fixedUrl = link;
        if (fixedUrl && !fixedUrl.startsWith("http")) {
          fixedUrl = "https://02.ikiru.wtf" + fixedUrl;
        }
        if (cover && !cover.startsWith("http")) cover = "https://02.ikiru.wtf" + cover;
        
        const mangaLink = fixedUrl.replace(/\/chapter-[^/]+\/$/, '/');
        
        if (link && title && chapterText) {
          results.push({
            title,
            chapter: chapterText,
            url: fixedUrl,
            cover,
            mangaLink,
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

async function main() {
  try {
    console.log("🌐 Fetching from https://02.ikiru.wtf/ ...");
    const res = await axios.get("https://02.ikiru.wtf/", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    console.log("✅ Data fetched successfully!\n");

    const $ = cheerio.load(res.data);
    
    // Scrape both sections
    const projectUpdates = await scrapeSection($, "Project Updates");
    const latestUpdates = await scrapeSection($, "Latest Updates");
    
    console.log(`📌 Project Updates: ${projectUpdates.length} chapters`);
    console.log(`🆕 Latest Updates: ${latestUpdates.length} chapters`);
    
    // Merge and remove duplicates
    const seen = new Set();
    const allResults = [];
    
    for (const item of [...projectUpdates, ...latestUpdates]) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        allResults.push(item);
      }
    }
    
    console.log(`\n📊 Total unique chapters: ${allResults.length}`);
    
    // Filter: only chapters updated today (within last 24 hours)
    const now = new Date();
    let todayResults = allResults.filter(item => {
      if (!item.updatedTime) return false;
      const updateDate = new Date(item.updatedTime);
      const diffHours = (now - updateDate) / (1000 * 60 * 60);
      return diffHours <= 24; // Within last 24 hours
    });
    
    // Filter by whitelist if exists
    if (whitelist.length > 0) {
      todayResults = todayResults.filter(item => 
        whitelist.some(w => item.title.toLowerCase().includes(w))
      );
    }
    
    console.log(`📅 Chapters updated today (≤24h): ${todayResults.length}`);
    
    if (todayResults.length === 0) {
      console.log("ℹ️ No new chapters today. Exiting.");
      return;
    }
    
    // Sort: Project Updates first, then Latest Updates
    const sortedResults = todayResults.sort((a, b) => {
      if (a.source === "Project Updates" && b.source !== "Project Updates") return -1;
      if (a.source !== "Project Updates" && b.source === "Project Updates") return 1;
      return 0;
    });
    
    // Send all chapters updated today (no limit)
    const testItems = sortedResults;
    
    for (const data of testItems) {
      console.log(`\n📝 Sending: ${data.title} - ${data.chapter} (${data.source})`);
      
      const description = await fetchDescription(data.mangaLink);
      
      const statusEmoji = { "Ongoing": "🟢", "Completed": "🔵", "Hiatus": "🟡", "Unknown": "⚪" };
      const sourceEmoji = data.source === "Project Updates" ? "📌" : "🆕";
      const sourceText = data.source === "Project Updates" ? "From Your Library" : "Latest Release";
      
      const fields = [
        { name: "⭐ Rating", value: data.rating ? `**${data.rating}** / 10` : "No rating", inline: true },
        { name: "📊 Status", value: `${statusEmoji[data.status] || "⚪"} ${data.status}`, inline: true }
      ];
      
      if (data.updatedTime) {
        fields.push({ name: "🕐 Updated", value: formatTimeAgo(data.updatedTime), inline: true });
      }

      let descriptionText = `**${data.chapter}**`;
      if (description) {
        descriptionText += `\n\n📄 **Synopsis:**\n${description}`;
      }
      descriptionText += `\n\n[Read Chapter](${data.url})`;

      const payload = {
        embeds: [{
          title: `📖 ${data.title}`,
          description: descriptionText,
          url: data.url,
          color: getStatusColor(data.status),
          fields: fields,
          timestamp: new Date().toISOString(),
          footer: {
            text: `${sourceEmoji} ${sourceText} • ikiru.wtf`,
            icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png"
          },
          thumbnail: data.cover && data.cover.startsWith("http") ? { url: data.cover } : undefined
        }],
      };

      await axios.post(WEBHOOK, payload);
      console.log("✅ Sent!");
    }
    
    console.log("\n🎉 All test notifications sent!");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
}

main();