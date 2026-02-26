import axios from "axios";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { 
  formatTimeAgo, 
  getStatusColor, 
  fetchDescription, 
  scrapeMangaUpdates, 
  sendErrorLog,
  STATUS_EMOJI
} from "../lib/scraper.js";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function sendDiscord(data, channelId) {
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
        text: `🆕 Latest Release • ikiru.wtf`,
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png"
      },
      thumbnail: data.cover?.startsWith("http") ? { url: data.cover } : undefined
    }],
  };

  if (channelId && DISCORD_BOT_TOKEN) {
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      payload,
      {
        headers: {
          "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } else if (WEBHOOK) {
    await axios.post(WEBHOOK, payload);
  }
}

export default async function handler(req, res) {
  const userAgent = req.headers["user-agent"] || "";
  const isGitHubActions = userAgent.includes("GitHub-Actions");
  
  if (!isGitHubActions) {
    return res.status(403).json({ error: "Forbidden - Only GitHub Actions allowed" });
  }

  try {
    const items = await scrapeMangaUpdates();
    const sortedItems = items;

    const pageHash = hash(JSON.stringify(sortedItems));
    const lastHash = await redis.get("page_hash");

    if (lastHash === pageHash) {
      return res.status(200).json({ message: "No changes" });
    }

    // Get all guilds with notification channels
    const guildKeys = await redis.keys("channel:*");
    const guildChannels = {};
    for (const key of guildKeys) {
      const guildId = key.replace("channel:", "");
      guildChannels[guildId] = await redis.get(key);
    }

    // Load whitelist from Redis
    const whitelist = await redis.get("whitelist:manga") || [];

    for (const item of sortedItems) {
      const key = `chapter:${item.url}`;
      const exists = await redis.get(key);

      if (!exists) {
        // Check whitelist if it's not empty
        if (whitelist.length > 0) {
          const isWhitelisted = whitelist.some(title =>
            item.title.toLowerCase().includes(title.toLowerCase()) ||
            title.toLowerCase().includes(item.title.toLowerCase())
          );

          if (!isWhitelisted) {
            // Not in whitelist, skip without marking as sent
            // so it can be re-checked if user adds it to whitelist later
            continue;
          }
        }

        const description = await fetchDescription(item.mangaUrl);
        item.description = description;
        
        // Send to Discord channels
        if (Object.keys(guildChannels).length > 0) {
          for (const channelId of Object.values(guildChannels)) {
            await sendDiscord(item, channelId);
          }
        } else if (WEBHOOK) {
          await sendDiscord(item);
        }
        
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
}cl