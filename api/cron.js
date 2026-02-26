import { Redis } from "@upstash/redis";
import axios from "axios";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "../../lib/scraper.js";

const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const CHAPTER_TTL = 60 * 60 * 24 * 3; // 3 hari

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = {
  maxDuration: 60,
};

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
  const num     = parseFloat(rating);
  const filled  = Math.round(num / 2);
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "★".repeat(filled) + "☆".repeat(5 - filled) + ` \`${display}/10\``;
};

const shortSynopsis = (description) => {
  if (!description) return null;
  const sentences = description.split(". ");
  const short     = sentences.slice(0, 2).join(". ");
  return short.endsWith(".") ? short : short + ".";
};

async function getAllGuildChannels() {
  const keys   = await redis.keys("channel:*");
  const result = {};
  for (const key of keys) {
    result[key.replace("channel:", "")] = await redis.get(key);
  }
  return result;
}

async function sendDiscordEmbed(data, channelId) {
  const description = data.description || (await fetchDescription(data.mangaUrl));
  const synopsis    = shortSynopsis(description);
  const color       = STATUS_COLORS[data.status] || STATUS_COLORS["Unknown"];

  const embeds = [
    {
      color,
      author: {
        name:     "⚡  Chapter Baru Tersedia — ikiru.wtf",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url:      "https://02.ikiru.wtf",
      },
      image: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
    },
    {
      color,
      title:       data.title,
      url:         data.mangaUrl,
      description: [
        `**📖 ${data.chapter}**`,
        ``,
        synopsis ? `> ${synopsis}` : null,
        ``,
        `**[→ Baca Sekarang](${data.url})**`,
      ].filter(Boolean).join("\n"),
      fields: [
        { name: "⭐ Rating",  value: ratingStars(data.rating),                                                  inline: true },
        { name: "📊 Status",  value: `\`${statusBar[data.status] || "⚪ Unknown"}\``,                           inline: true },
        { name: "🕐 Updated", value: data.updatedTime ? `\`${formatTimeAgo(data.updatedTime)}\`` : "`Unknown`", inline: true },
      ],
      footer: {
        text:     "ikiru.wtf  •  Manga Tracker",
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
        "Authorization": `Bot ${BOT_TOKEN}`,
        "Content-Type":  "application/json",
      },
    }
  );
}

export default async function handler(req, res) {
  // ✅ Support GET (GitHub Actions curl) dan POST (Vercel Cron)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ✅ Validasi secret
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.log("🤖 [CRON] Starting manga check...");
    console.log(`   📅 ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`);

    // 1. Load whitelist
    const whitelist = await redis.get("whitelist:manga") || [];
    if (whitelist.length === 0) {
      console.log("⚠️ [CRON] Whitelist empty, skipping.");
      return res.status(200).json({ ok: true, message: "Whitelist empty" });
    }
    console.log(`📋 [CRON] Whitelist: ${whitelist.length} manga`);

    // 2. Scrape chapter terbaru
    const allResults = await scrapeMangaUpdates(redis);
    console.log(`📦 [CRON] Scraped ${allResults.length} chapters`);

    // 3. Filter sesuai whitelist
    const matched = allResults.filter((item) =>
      whitelist.some((title) =>
        item.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(item.title.toLowerCase())
      )
    );
    console.log(`🎯 [CRON] Matched ${matched.length} chapters`);

    if (matched.length === 0) {
      return res.status(200).json({ ok: true, message: "No matching chapters" });
    }

    // 4. Load semua guild channels
    const guildChannels = await getAllGuildChannels();
    if (Object.keys(guildChannels).length === 0) {
      console.log("⚠️ [CRON] No channels registered.");
      return res.status(200).json({ ok: true, message: "No channels registered" });
    }
    console.log(`📢 [CRON] Channels: ${Object.keys(guildChannels).length} guild(s)`);

    // 5. Kirim notif untuk tiap chapter yang belum dikirim
    let sentCount    = 0;
    let skippedCount = 0;
    let failedCount  = 0;

    for (const item of matched) {
      const key         = `chapter:${item.url}`;
      const alreadySent = await redis.get(key);

      if (alreadySent) {
        console.log(`⏭️ [CRON] Skipped: ${item.title} - ${item.chapter}`);
        skippedCount++;
        continue;
      }

      let success = false;
      for (const [guildId, channelId] of Object.entries(guildChannels)) {
        try {
          await sendDiscordEmbed(item, channelId);
          console.log(`✅ [CRON] Sent: ${item.title} → guild ${guildId}`);
          success = true;
        } catch (err) {
          console.error(`❌ [CRON] Failed guild ${guildId}: ${err.message}`);
          failedCount++;
        }
      }

      if (success) {
        // ✅ Simpan timestamp + TTL 3 hari
        await redis.set(key, Date.now().toString(), { ex: CHAPTER_TTL });
        sentCount++;
      }
    }

    console.log(`📊 [CRON] Done — sent: ${sentCount}, skipped: ${skippedCount}, failed: ${failedCount}`);

    return res.status(200).json({
      ok:      true,
      sent:    sentCount,
      skipped: skippedCount,
      failed:  failedCount,
    });

  } catch (err) {
    console.error(`❌ [CRON] Fatal: ${err.message}`);
    console.error(err.stack);
    return res.status(500).json({ error: err.message });
  }
}
