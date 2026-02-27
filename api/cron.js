import { Redis } from "@upstash/redis";
import axios from "axios";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "../lib/scraper.js";

// ✅ Shorthand + destructure
const cl = console.log;
const { BOT_TOKEN, CRON_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
const CHAPTER_TTL = 60 * 60 * 24 * 3; // 3 hari

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

export const config = { maxDuration: 60 };

const STATUS_COLORS = {
  "Ongoing":   0x22c55e,
  "Completed": 0x3b82f6, 
  "Hiatus":    0xf59e0b,
  "Unknown":   0x6b7280,
};

const statusBar = {
  "Ongoing":   "🟢 Ongoing",
  "Completed": "🔵 Completed", 
  "Hiatus":    "🟡 Hiatus",
  "Unknown":   "⚪ Unknown",
};

const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num = parseFloat(rating);
  const filled = Math.round(num / 2);
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "★".repeat(filled) + "☆".repeat(5 - filled) + ` \`${display}/10\``;
};

const shortSynopsis = (desc) => {
  if (!desc) return null;
  const sentences = desc.split(". ");
  const short = sentences.slice(0, 2).join(". ");
  return short.endsWith(".") ? short : short + ".";
};

// ✅ Optimized: SCAN non-blocking + parallel get
async function getAllGuildChannels() {
  try {
    let cursor = 0;
    const keys = [];
    do {
      const result = await redis.scan(cursor, { 
        MATCH: "channel:*", 
        COUNT: 100 
      });
      keys.push(...result.keys);
      cursor = result.cursor;
    } while (cursor !== 0);
    
    // Parallel get all channels
    const channels = await redis.mget(...keys);
    return Object.fromEntries(
      keys.map((key, i) => [key.replace("channel:", ""), channels[i]])
    );
  } catch (err) {
    cl(`❌ Channels error: ${err.message}`);
    return {};
  }
}

// ✅ Unchanged: Perfect embed logic
async function sendDiscordEmbed(data, channelId) {
  const description = data.description || (await fetchDescription(data.mangaUrl));
  const synopsis = shortSynopsis(description);
  const color = STATUS_COLORS[data.status] || STATUS_COLORS.Unknown;

  const embeds = [
    {
      color,
      author: {
        name: "⚡ Chapter Baru Tersedia — ikiru.wtf",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url: "https://02.ikiru.wtf",
      },
      image: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
    },
    {
      color,
      title: data.title,
      url: data.mangaUrl,
      description: [
        `**📖 ${data.chapter}**`,
        "",
        synopsis ? `> ${synopsis}` : null,
        "",
        `[→ Baca Sekarang](${data.url})`,
      ].filter(Boolean).join("\n"),
      fields: [
        { name: "⭐ Rating", value: ratingStars(data.rating), inline: true },
        { name: "📊 Status", value: `\`${statusBar[data.status] || "⚪ Unknown"}\``, inline: true },
        { name: "🕐 Updated", value: data.updatedTime ? `\`${formatTimeAgo(data.updatedTime)}\`` : "`Unknown`", inline: true },
      ],
      footer: {
        text: "ikiru.wtf • Manga Tracker",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { embeds },
    {
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

export default async function handler(req, res) {
  // ✅ Dual GET/POST support
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ✅ Secret validation
  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const start = Date.now();
    cl(`🤖 [CRON] Starting... (${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB)`);

    // Parallel: whitelist + scrape + channels
    const [whitelist, allResults, guildChannels] = await Promise.all([
      redis.get("whitelist:manga") || [],
      scrapeMangaUpdates(redis),
      getAllGuildChannels(),
    ]);

    if (whitelist.length === 0) {
      return res.status(200).json({ ok: true, message: "Whitelist empty" });
    }

    cl(`📋 Whitelist: ${whitelist.length} | 📦 Scraped: ${allResults.length} | 📢 Channels: ${Object.keys(guildChannels).length}`);

    // Filter matched (optimized regex)
    const matched = allResults.filter(item =>
      whitelist.some(title =>
        item.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(item.title.toLowerCase())
      )
    );

    if (matched.length === 0) {
      return res.status(200).json({ ok: true, message: "No new chapters" });
    }

    // Stats
    let sent = 0, skipped = 0, failed = 0;

    // Parallel chapter processing (max 5 concurrent)
    const chapterPromises = matched.slice(0, 5).map(async (item) => {
      const key = `chapter:${item.url}`;
      const sent = await redis.get(key);

      if (sent) {
        skipped++;
        return;
      }

      let guildSuccess = false;
      for (const [guildId, channelId] of Object.entries(guildChannels)) {
        try {
          await sendDiscordEmbed(item, channelId);
          cl(`✅ ${item.title.slice(0, 30)}... → ${guildId}`);
          guildSuccess = true;
        } catch (err) {
          cl(`❌ Guild ${guildId}: ${err.message}`);
          failed++;
        }
      }

      if (guildSuccess) {
        await redis.set(key, Date.now().toString(), { ex: CHAPTER_TTL });
        sent++;
      }
    });

    await Promise.all(chapterPromises);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    cl(`📊 Done — sent:${sent} skipped:${skipped} failed:${failed} (${duration}s)`);

    return res.status(200).json({ ok: true, sent, skipped, failed, duration });
  } catch (err) {
    cl(`❌ FATAL: ${err.message}`);
    console.error(err.stack);
    return res.status(500).json({ error: err.message });
  }
}
