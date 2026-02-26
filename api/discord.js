import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import { Redis } from "@upstash/redis";
import axios from "axios";
import * as cheerio from "cheerio";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const SITE_URL = "https://02.ikiru.wtf/";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function loadWhitelist() {
  try {
    const data = await redis.get("whitelist:manga");
    return data || [];
  } catch {
    return [];
  }
}

async function saveWhitelist(manga) {
  await redis.set("whitelist:manga", manga);
}

async function getNotificationChannel(guildId) {
  try {
    const channelId = await redis.get(`channel:${guildId}`);
    return channelId;
  } catch {
    return null;
  }
}

async function setNotificationChannel(guildId, channelId) {
  await redis.set(`channel:${guildId}`, channelId);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    
    if (!PUBLIC_KEY) {
      return res.status(401).json({ error: "Public key not configured" });
    }

    const rawBody = await getRawBody(req);
    const body = rawBody.toString();

    // Verify signature FIRST (Discord requires this even for PING)
    console.log("Verifying with public key:", PUBLIC_KEY?.slice(0, 20) + "...");
    const isValid = await verifyKey(body, signature, timestamp, PUBLIC_KEY);
    console.log("Signature valid:", isValid);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(body);

    // Handle PING after verification
    if (payload.type === 1) {
      return res.json({ type: 1 });
    }

    const { type, data: interactionData, member } = payload;

    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interactionData;

      if (name === "add") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        const whitelist = await loadWhitelist();
        if (whitelist.some(t => t.toLowerCase() === title.toLowerCase())) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `⚠️ "${title}" is already in the whitelist!` },
          });
        }

        whitelist.push(title);
        await saveWhitelist(whitelist);

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `✅ Added "${title}" to the whitelist!\n📋 Total: ${whitelist.length} manga`,
          },
        });
      }

      if (name === "remove") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        const whitelist = await loadWhitelist();
        const index = whitelist.findIndex(
          t => t.toLowerCase() === title.toLowerCase()
        );

        if (index === -1) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `⚠️ "${title}" is not in the whitelist!` },
          });
        }

        whitelist.splice(index, 1);
        await saveWhitelist(whitelist);

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `✅ Removed "${title}" from the whitelist!\n📋 Total: ${whitelist.length} manga`,
          },
        });
      }

      if (name === "list") {
        const whitelist = await loadWhitelist();
        if (whitelist.length === 0) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "📋 Whitelist is empty!" },
          });
        }

        const list = whitelist.map((t, i) => `${i + 1}. ${t}`).join("\n");
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `📋 **Whitelisted Manga (${whitelist.length}):**\n\n${list}`,
          },
        });
      }

      if (name === "status") {
        const whitelist = await loadWhitelist();
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `📊 **Bot Status**\n\n📋 Whitelisted: ${whitelist.length} manga\n⏱️ Check interval: Every 5 minutes\n🔔 Notifications: Discord + Telegram`,
          },
        });
      }

      if (name === "search") {
        const query = options?.[0]?.value;
        if (!query) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a search query!" },
          });
        }

        try {
          // Use the website's search API
          const searchResponse = await axios.post(
            "https://02.ikiru.wtf/wp-admin/admin-ajax.php?nonce=eecc652792&action=search",
            new URLSearchParams({ query }),
            {
              headers: { 
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/x-www-form-urlencoded"
              },
              timeout: 10000,
            }
          );
          
          const $ = cheerio.load(searchResponse.data);
          const results = [];
          
          $("a").each((i, el) => {
            const title = $(el).find("h3, .title, h2").text().trim();
            const link = $(el).attr("href");
            if (title && link) {
              results.push({ title, link });
            }
          });

          if (results.length === 0) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: `🔍 No manga found for "${query}"` },
            });
          }

          const list = results.slice(0, 5).map(r => {
            const url = r.link.startsWith("http") ? r.link : `https://02.ikiru.wtf${r.link}`;
            return `• **[${r.title}](${url})**`;
          }).join("\n");
          
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `🔍 **Search results for "${query}":**\n\n${list}\n\n💡 Use \`/add "title"\` to add to whitelist`,
            },
          });
        } catch (err) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error searching: ${err.message}` },
          });
        }
      }

      if (name === "info") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        try {
          // First, search for the manga
          const searchResponse = await axios.post(
            "https://02.ikiru.wtf/wp-admin/admin-ajax.php?nonce=eecc652792&action=search",
            new URLSearchParams({ query: title }),
            {
              headers: { 
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/x-www-form-urlencoded"
              },
              timeout: 10000,
            }
          );
          
          const $search = cheerio.load(searchResponse.data);
          let mangaUrl = null;
          let mangaTitle = null;
          
          $search("a").each((i, el) => {
            const foundTitle = $search(el).find("h3, .title, h2").text().trim();
            if (foundTitle && foundTitle.toLowerCase().includes(title.toLowerCase())) {
              mangaUrl = $search(el).attr("href");
              mangaTitle = foundTitle;
              return false;
            }
          });

          if (!mangaUrl) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: `🔍 Manga "${title}" not found` },
            });
          }

          // Fix URL if needed
          const fullUrl = mangaUrl.startsWith("http") ? mangaUrl : `https://02.ikiru.wtf${mangaUrl}`;
          
          // Scrape the manga detail page
          const detailResponse = await axios.get(fullUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
          });
          
          const $detail = cheerio.load(detailResponse.data);
          
          // Extract all information
          const description = $detail('meta[name="description"]').attr("content") || 
                             $detail(".description, .summary, [class*='description']").first().text().trim() ||
                             "No synopsis available";
          
          const rating = $detail(".numscore").first().text().trim() || "N/A";
          const status = $detail("p.font-normal.text-xs, .status").filter((_, el) => {
            const t = $detail(el).text().trim();
            return ["Ongoing", "Completed", "Hiatus", "Dropped"].includes(t);
          }).first().text().trim() || "Unknown";
          
          // Count chapters
          const chapters = $detail("a[href*='chapter']").length || "Unknown";
          
          // Get cover image
          const cover = $detail("img").first().attr("src") || $detail(".cover img").first().attr("src");
          
          // Format description (truncate if too long)
          const shortDesc = description.length > 200 ? description.substring(0, 197) + "..." : description;
          
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `📖 **[${mangaTitle}](${fullUrl})**\n\n` +
                       `⭐ **Rating:** ${rating}/10\n` +
                       `📊 **Status:** ${status}\n` +
                       `📚 **Chapters:** ${chapters}\n\n` +
                       `📝 **Synopsis:**\n${shortDesc}\n\n` +
                       `💡 Use \`/add "${mangaTitle}"\` to add to whitelist`,
            },
          });
        } catch (err) {
          console.error("Info error:", err);
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error getting manga info` },
          });
        }
      }

      if (name === "clear") {
        const whitelist = await loadWhitelist();
        const count = whitelist.length;
        
        await saveWhitelist([]);
        
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🗑️ **Whitelist cleared!**\nRemoved ${count} manga from whitelist.`,
          },
        });
      }

      if (name === "recent") {
        try {
          const response = await axios.get(SITE_URL, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
          });
          const $ = cheerio.load(response.data);
          
          const results = [];
          $("a").each((i, el) => {
            const title = $(el).find("h3").text().trim();
            const chapter = $(el).find("p").text().trim();
            if (title && chapter.includes("Chapter")) {
              const updatedTime = $(el).find("time").attr("datetime");
              results.push({ title, chapter, updatedTime });
            }
          });

          if (results.length === 0) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "🕐 No recent chapters found." },
            });
          }

          const recent = results.slice(0, 5);
          const list = recent.map(r => `• **${r.title}** - ${r.chapter}`).join("\n");
          
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `🕐 **5 Latest Chapters:**\n\n${list}`,
            },
          });
        } catch (err) {
          console.error("Recent error:", err);
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error fetching recent chapters` },
          });
        }
      }

      if (name === "setchannel") {
        const guildId = payload.guild_id;
        const channelId = options?.[0]?.value;
        
        if (!guildId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ This command only works in servers!" },
          });
        }
        
        if (!channelId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a channel!" },
          });
        }

        await setNotificationChannel(guildId, channelId);
        
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `✅ **Notification channel set!**\nManga updates will be sent to <#${channelId}>`,
          },
        });
      }

      if (name === "getchannel") {
        const guildId = payload.guild_id;
        
        if (!guildId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ This command only works in servers!" },
          });
        }

        const channelId = await getNotificationChannel(guildId);
        
        if (!channelId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "⚠️ No notification channel set. Use `/setchannel #channel`" },
          });
        }
        
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `📢 **Current notification channel:** <#${channelId}>`,
          },
        });
      }
    }

    return res.status(400).json({ error: "Unknown interaction type" });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
