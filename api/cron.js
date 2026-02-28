import { Redis } from "@upstash/redis";
import axios from "axios";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "../lib/scraper.js";
import { deleteGuildChannel, getAllGuildChannels } from "../lib/redis.js";

// ===== ENV =====
const cl = console.log;
const {
  DISCORD_BOT_TOKEN,
  CRON_SECRET,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

const CHAPTER_TTL = 60 * 60 * 24 * 3; // 3 hari

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

export const config = { maxDuration: 60 };

// ===== EMBED CONFIG =====
const STATUS_COLORS = {
  Ongoing: 0x22c55e,
  Completed: 0x3b82f6,
  Hiatus: 0xf59e0b,
  Unknown: 0x6b7280,
};

const statusBar = {
  Ongoing: "🟢 Ongoing",
  Completed: "🔵 Completed",
  Hiatus: "🟡 Hiatus",
  Unknown: "⚪ Unknown",
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

// ===== VALIDATE CHANNEL =====
// FIX #2: Bedakan jenis error — jangan hapus guild kalau error 401 (bot token salah)
async function validateChannel(channelId, guildId) {
  try {
    await axios.get(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
    });
    return true;
  } catch (err) {
    const status = err.response?.status;

    if (status === 404 || status === 403) {
      // Channel tidak ada atau bot tidak punya akses → hapus guild
      cl(`🗑️ Removing invalid guild ${guildId} (HTTP ${status})`);
      await deleteGuildChannel(guildId);
    } else if (status === 401) {
      // Bot token salah → jangan hapus guild, ini masalah konfigurasi
      cl(`⚠️ Bot token invalid, skipping guild ${guildId} (HTTP 401)`);
    } else {
      // Network error atau error lain → jangan hapus guild
      cl(`⚠️ Could not validate guild ${guildId}: ${err.message}`);
    }

    return false;
  }
}

// ===== SEND EMBED =====
async function sendDiscordEmbed(data, channelId) {
  const description =
    data.description || (await fetchDescription(data.mangaUrl));

  const synopsis = shortSynopsis(description);
  const color = STATUS_COLORS[data.status] || STATUS_COLORS.Unknown;

  const embeds = [
    {
      color,
      author: {
        name: "⚡ Chapter Baru Tersedia — ikiru.wtf",
        icon_url:
          "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
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
      ]
        .filter(Boolean)
        .join("\n"),
      fields: [
        {
          name: "⭐ Rating",
          value: ratingStars(data.rating),
          inline: true,
        },
        {
          name: "📊 Status",
          value: `\`${statusBar[data.status] || "⚪ Unknown"}\``,
          inline: true,
        },
        {
          name: "🕐 Updated",
          value: data.updatedTime
            ? `\`${formatTimeAgo(data.updatedTime)}\``
            : "`Unknown`",
          inline: true,
        },
      ],
      footer: {
        text: "ikiru.wtf • Manga Tracker",
        icon_url:
          "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { embeds },
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
}

// ===== MAIN HANDLER =====
export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const start = Date.now();
    cl("🤖 [CRON] Starting...");

    // ===== PARALLEL FETCH =====
    const [rawWhitelist, allResults, guildChannels] = await Promise.all([
      redis.get("whitelist:manga"),
      scrapeMangaUpdates(redis),
      getAllGuildChannels(),
    ]);

    const rawParsed = Array.isArray(rawWhitelist)
      ? rawWhitelist
      : rawWhitelist
        ? JSON.parse(rawWhitelist)
        : [];
    const whitelist = rawParsed.map((w) =>
      typeof w === "string" ? { title: w, url: null } : w,
    );

    if (whitelist.length === 0) {
      return res.status(200).json({ ok: true, message: "Whitelist empty" });
    }

    // ===== VALIDATE GUILDS =====
    // FIX #1: Hanya tambah ke validGuilds kalau benar-benar valid
    const validGuilds = {};

    for (const [guildId, channelId] of Object.entries(guildChannels)) {
      const valid = await validateChannel(channelId, guildId);
      if (valid) validGuilds[guildId] = channelId; // FIX #1: hapus `|| channelId`
    }

    if (Object.keys(validGuilds).length === 0) {
      return res.status(200).json({ ok: true, message: "No active guilds" });
    }

    // ===== FILTER MATCHED =====
    const whitelistTitles = whitelist.map((w) => w.title);

    const matched = allResults.filter((item) =>
      whitelistTitles.some(
        (title) =>
          item.title.toLowerCase().includes(title.toLowerCase()) ||
          title.toLowerCase().includes(item.title.toLowerCase()),
      ),
    );

    if (matched.length === 0) {
      return res.status(200).json({ ok: true, message: "No new chapters" });
    }

    // ===== STATS =====
    let sentCount = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of matched.slice(0, 5)) {
      const key = `chapter:${item.url}`;

      // FIX #4: Pakai SET NX untuk hindari race condition kalau 2 cron jalan paralel
      const claimed = await redis.set(key, Date.now().toString(), {
        ex: CHAPTER_TTL,
        nx: true, // only set if not exists
      });

      if (!claimed) {
        cl(`⏭️ Skipped (already claimed): ${item.title}`);
        skipped++;
        continue;
      }

      let guildSuccess = false;
      let guildFailCount = 0;

      for (const [guildId, channelId] of Object.entries(validGuilds)) {
        try {
          await sendDiscordEmbed(item, channelId);
          cl(`✅ ${item.title} → ${guildId}`);
          guildSuccess = true;
        } catch (err) {
          cl(`❌ ${guildId}: ${err.message}`);

          // FIX #5: Log failed per guild tetap di sini (per guild memang wajar)
          await redis.lpush(
            "cron:logs",
            JSON.stringify({
              time: new Date().toISOString(),
              message: `Gagal kirim ke guild ${guildId}: ${err.message}`,
              tag: "failed",
            }),
          );

          guildFailCount++;
        }
      }

      failed += guildFailCount;

      if (guildSuccess) {
        // FIX #5: Log "sent" cukup sekali per item, bukan per guild
        await redis.lpush(
          "cron:logs",
          JSON.stringify({
            time: new Date().toISOString(),
            message: `${item.title} — ${item.chapter}`,
            tag: "sent",
          }),
        );

        await redis.lpush(
          "recent:chapters",
          JSON.stringify({
            title: item.title,
            chapter: item.chapter,
            url: item.url,
            cover: item.cover ?? null,
            sentAt: new Date().toISOString(),
          }),
        );

        sentCount++;
      } else {
        // Semua guild gagal → lepas klaim supaya bisa dicoba lagi di cron berikutnya
        await redis.del(key);
        cl(`⚠️ All guilds failed for ${item.title}, releasing claim`);
      }
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    cl(
      `📊 Done — sent:${sentCount} skipped:${skipped} failed:${failed} (${duration}s)`,
    );

    await redis.set(
      "cron:last_run",
      JSON.stringify({
        sent: sentCount,
        skipped,
        failed,
        duration,
        timestamp: new Date().toISOString(),
      }),
    );

    // Trim log max 200 entries
    await redis.ltrim("cron:logs", 0, 199);
    await redis.ltrim("recent:chapters", 0, 19);

    const minuteSlot = Math.floor(Date.now() / (5 * 60 * 1000));
    await redis.set(
      `cron:trend:${minuteSlot}`,
      JSON.stringify({
        sent: sentCount,
        skipped,
        failed,
        duration: parseFloat(duration),
      }),
      { ex: 7200 },
    );

    return res.status(200).json({
      ok: true,
      sent: sentCount,
      skipped,
      failed,
      duration,
    });
  } catch (err) {
    cl(`❌ FATAL: ${err.message}`);
    console.error(err.stack);
    return res.status(500).json({
      error: err.message,
    });
  }
}