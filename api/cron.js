import { Redis } from "@upstash/redis";
import axios from "axios";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "../lib/scraper.js";
import { deleteGuildChannel, getAllGuildChannels } from "../lib/redis.js";

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

function normalizeTitle(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(u) {
  return u?.replace(/\/+$/, "").toLowerCase().trim();
}

// ===== VALIDATE CHANNEL =====

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
      cl(`🗑️ Removing invalid guild ${guildId}`);
      await deleteGuildChannel(guildId);
    } else if (status === 401) {
      cl(`⚠️ Bot token invalid`);
    } else {
      cl(`⚠️ Validate error ${guildId}: ${err.message}`);
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
      image: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
      fields: [
        { name: "⭐ Rating", value: ratingStars(data.rating), inline: true },
        { name: "📊 Status", value: `\`${statusBar[data.status] || "⚪ Unknown"}\``, inline: true },
        { name: "🕐 Updated", value: data.updatedTime ? `\`${formatTimeAgo(data.updatedTime)}\`` : "`Unknown`", inline: true },
      ],
      footer: { text: "ikiru.wtf • Manga Tracker" },
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

    const [rawWhitelist, allResults, guildChannels] = await Promise.all([
      redis.get("whitelist:manga"),
      scrapeMangaUpdates(),
      getAllGuildChannels(),
    ]);

    const rawParsed = rawWhitelist
      ? Array.isArray(rawWhitelist)
        ? rawWhitelist
        : JSON.parse(rawWhitelist)
      : [];

    const whitelist = rawParsed.map((w) =>
      typeof w === "string" ? { title: w, url: null } : w,
    );

    if (!whitelist.length) {
      return res.status(200).json({ ok: true, message: "Whitelist empty" });
    }

    const validGuilds = {};

    for (const [guildId, channelId] of Object.entries(guildChannels)) {
      if (await validateChannel(channelId, guildId)) {
        validGuilds[guildId] = channelId;
      }
    }

    if (!Object.keys(validGuilds).length) {
      return res.status(200).json({ ok: true, message: "No active guilds" });
    }

    const matched = allResults.filter((item) =>
      whitelist.some((w) => {
        if (w.url && item.mangaUrl) {
          return normalizeUrl(item.mangaUrl) === normalizeUrl(w.url);
        }
        if (w.title) {
          const a = normalizeTitle(item.title);
          const b = normalizeTitle(w.title);
          return a === b || a.includes(b) || b.includes(a);
        }
        return false;
      }),
    );
    if (!matched.length) {
      return res.status(200).json({ ok: true, message: "No new chapters" });
    }

    // 🔥 SORT DI SINI
    matched.sort((a, b) => {
      const getNum = (c) => {
        const match = c.chapter.match(/\d+(\.\d+)?/);
        return match ? parseFloat(match[0]) : 0;
      };

      return getNum(a) - getNum(b); // kecil → besar
    });
    cl(`🔍 DEBUG MATCHED (${matched.length}):`);
    matched.forEach((item, i) => {
      const key = `chapter:${normalizeUrl(item.url)}`;
      cl(`${i + 1}. ${item.title}`);
      cl(`   📖 ${item.chapter}`);
      cl(`   🔗 ${item.url}`);
      cl(`   🗝️  ${key}`);
    });
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of matched) {
      const key = `chapter:${normalizeUrl(item.url)}`;
      const exists = await redis.exists(key); // ⭐ TAMBAH
      cl(`⏰ CHECK ${key}: ${exists ? "SKIP (exists)" : "SEND (new)"} `);
      const claimed = await redis.set(key, Date.now().toString(), {
        ex: CHAPTER_TTL,
        nx: true,
      });

      if (!claimed) {
        skipped++;
        continue;
      }

      let success = false;

      for (const channelId of Object.values(validGuilds)) {
        try {
          console.log("🖼️ Cover URL:", item.cover);
          await sendDiscordEmbed(item, channelId);
          success = true;
        } catch (err) {
          failed++;
        }
      }

      if (!success) {
        await redis.del(key);
        continue;
      }

      const nowIso = new Date().toISOString();

      await redis.lpush(
        "recent:chapters",
        JSON.stringify({
          title: item.title,
          chapter: item.chapter,
          url: item.url,
          cover: item.cover ?? null,
          sentAt: nowIso,
        }),
      );

      await redis.lpush(
        "cron:logs",
        JSON.stringify({
          time: nowIso,
          message: `${item.title} — ${item.chapter}`,
          tag: "sent",
        }),
      );

      sent++;
    }

    // CAP LISTS ONCE (NO DOUBLE TRIM)
    await redis.ltrim("recent:chapters", 0, 99);
    await redis.expire("recent:chapters", 60*60*24*14);
    await redis.ltrim("cron:logs", 0, 499);
    await redis.expire("cron:logs", 60*60*24*30); 

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    await redis.set(
      "cron:last_run",
      JSON.stringify({
        sent,
        skipped,
        failed,
        duration,
        timestamp: new Date().toISOString(),
      }),
    );

    const minuteSlot = Math.floor(Date.now() / (5 * 60 * 1000));

    await redis.set(
      `cron:trend:${minuteSlot}`,
      JSON.stringify({
        sent,
        skipped,
        failed,
        duration: parseFloat(duration),
      }),
      { ex: 7200 },
    );

    return res.status(200).json({
      ok: true,
      sent,
      skipped,
      failed,
      duration,
    });
  } catch (err) {
    console.error("FATAL:", err);
    return res.status(500).json({ error: err.message });
  }
}
