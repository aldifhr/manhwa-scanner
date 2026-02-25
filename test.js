import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";

dotenv.config();

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

async function main() {
  try {
    const res = await axios.get("https://02.ikiru.wtf/", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(res.data);
    const card = $("a:has(p:contains('Chapter'))").first();
    const parent = card.parent();

    const chapter = card.find("p").text().trim();
    let url = card.attr("href");
    let title = parent.find("h1").text().trim();
    if (!title) title = card.find("h3").text().trim();
    
    let cover = parent.find("img").first().attr("src");
    const rating = parent.find(".numscore").text().trim();
    const status = parent.find("p.font-normal.text-xs").filter((_, el) => {
      const text = $(el).text().trim();
      return ["Ongoing", "Completed", "Hiatus"].includes(text);
    }).text().trim() || "Unknown";
    const updatedTime = card.find("time").attr("datetime");

    // Get manga URL for description (extract base manga URL from chapter URL)
    // Chapter URL: https://02.ikiru.wtf/manga/hello-veterinarian/chapter-124.820368/
    // Manga URL:   https://02.ikiru.wtf/manga/hello-veterinarian/
    const mangaLink = url.replace(/\/chapter-[^/]+\/$/, '/');

    if (!url.startsWith("http")) url = "https://02.ikiru.wtf" + url;
    if (cover && !cover.startsWith("http")) cover = "https://02.ikiru.wtf" + cover;

    console.log("TITLE:", title);
    console.log("CHAPTER:", chapter);
    console.log("RATING:", rating);
    console.log("STATUS:", status);
    console.log("UPDATED:", updatedTime);
    console.log("COVER:", cover);

    // Fetch description
    console.log("Fetching description...");
    const description = await fetchDescription(mangaLink);
    console.log("DESCRIPTION:", description ? description.substring(0, 50) + "..." : "None");

    // Build embed
    const statusEmoji = { "Ongoing": "🟢", "Completed": "🔵", "Hiatus": "🟡", "Unknown": "⚪" };
    
    const fields = [
      { name: "⭐ Rating", value: rating ? `**${rating}** / 10` : "No rating", inline: true },
      { name: "📊 Status", value: `${statusEmoji[status] || "⚪"} ${status}`, inline: true }
    ];
    
    if (updatedTime) {
      fields.push({ name: "🕐 Updated", value: formatTimeAgo(updatedTime), inline: true });
    }

    let descriptionText = `**${chapter}**`;
    if (description) {
      descriptionText += `\n\n📄 **Synopsis:**\n${description}`;
    }
    descriptionText += `\n\n[Read Chapter](${url})`;

    const payload = {
      embeds: [{
        title: `📖 ${title}`,
        description: descriptionText,
        url: url,
        color: getStatusColor(status),
        fields: fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: "🔔 New Chapter Alert • ikiru.wtf",
          icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png"
        },
        thumbnail: cover && cover.startsWith("http") ? { url: cover } : undefined
      }],
    };

    await axios.post(WEBHOOK, payload);
    console.log("✅ Sent to Discord with full embed!");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
}

main();