import axios from "axios";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { 
  formatTimeAgo, 
  getStatusColor, 
  fetchDescription, 
  scrapeMangaUpdates, 
  sortBySource,
  sendErrorLog
} from "../lib/scraper.js";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const STATUS_EMOJI = { 
  "Ongoing": "🟢", 
  "Completed": "🔵", 
  "Hiatus": "🟡", 
  "Unknown": "⚪" 
};

async function sendDiscord(data) {
  const sourceEmoji = data.source === "Project Updates" ? "📌" : "🆕";
  const sourceText = data.source === "Project Updates" ? "From Your Library" : "Latest Release";
  
  const fields = [
    { 
      name: "⭐ Rating", 
      value: data.rating !== "N/A" ? `**${data.rating}** / 10` : "No rating", 
      inline: true 
    },
    { 
      name: "📊 Status", 
      value: `${STATUS_EMOJI[data.status] || "⚪"} ${data.status}`, 
      inline: true 
    }
  ];
  
  if (data.updatedTime) {
    fields.push({ 
      name: "🕐 Updated", 
      value: formatTimeAgo(data.updatedTime), 
      inline: true 
    });
  }

  let descriptionText = `**${data.chapter}**`;
  if (data.description) {
    descriptionText += `\n\n📄 **Synopsis:**\n${data.description}`;
  }
  descriptionText += `\n\n[Read Chapter](${data.url})`;

  const payload = {
    embeds: [{
      title: `📖 ${data.title}`,
      description: descriptionText,
      url: data.url,
      color: getStatusColor(data.status),
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: `${sourceEmoji} ${sourceText} • ikiru.wtf`,
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png"
      },
      thumbnail: data.cover?.startsWith("http") ? { url: data.cover } : undefined
    }],
  };

  await axios.post(WEBHOOK, payload);
}

export default async function handler(req, res) {
  const userAgent = req.headers["user-agent"] || "";
  const isGitHubActions = userAgent.includes("GitHub-Actions");
  
  if (!isGitHubActions) {
    return res.status(403).json({ error: "Forbidden - Only GitHub Actions allowed" });
  }

  try {
    const items = await scrapeMangaUpdates(redis);
    const sortedItems = sortBySource(items);

    const pageHash = hash(JSON.stringify(sortedItems));
    const lastHash = await redis.get("page_hash");

    if (lastHash === pageHash) {
      return res.status(200).json({ message: "No changes" });
    }

    for (const item of sortedItems) {
      const key = `chapter:${item.url}`;
      const exists = await redis.get(key);

      if (!exists) {
        const description = await fetchDescription(item.mangaUrl, redis);
        item.description = description;
        
        await sendDiscord(item);
        await redis.set(key, "sent");
      }
    }

    await redis.set("page_hash", pageHash);

    return res.status(200).json({
      success: true,
      newItems: sortedItems.length,
    });
  } catch (err) {
    console.error(err);
    await sendErrorLog(WEBHOOK, err, "API Handler");
    return res.status(500).json({ error: err.message });
  }
}
