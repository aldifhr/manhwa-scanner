import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { getNotificationChannel, loadWhitelist, redis } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { isGuildAdmin } from "../permissions.js";
import {
  CACHE_TTL_LABEL,
  CRON_INTERVAL_LABEL,
  ONE_DAY_MS,
  DISCORD_EPHEMERAL_FLAG,
} from "../config.js";
import { validateDiscordChannel } from "../services/channelValidation.js";
import { sourceLabel } from "../domain.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:status" });

async function checkChannelValid(channelId) {
  return validateDiscordChannel({
    redis,
    channelId,
    botToken: process.env.DISCORD_BOT_TOKEN,
    writeCache: false,
  });
}

async function buildStatusMessage(payload) {
  const start = Date.now();
  let redisStatus = "✅ Online";
  try {
    await redis.ping();
  } catch {
    redisStatus = "❌ Offline";
  }
  const latency = Date.now() - start;

  if (!payload?.token) throw new Error("Invalid payload: missing token");
  const whitelist = await loadWhitelist();
  const guildId = payload.guild_id ?? null;
  const channelId = guildId ? await getNotificationChannel(guildId) : null;

  let channelText;
  if (!channelId) {
    channelText = "`Belum diset`";
  } else {
    const valid = await checkChannelValid(channelId);
    channelText = valid
      ? `<#${channelId}> ✅`
      : `<#${channelId}> ⚠️ *(tidak valid/akses ditolak)*`;
  }

  // Health & Stats
  const sourceCounts = {};
  const markCounts = {};
  let totalSources = 0;
  let updated24h = 0;
  const now = Date.now();
  const dayMs = ONE_DAY_MS;

  // Baru: Ambil semua timestamp rilis manga dari Hash terpusat
  const { normalizeTitleKey } = await import("../domain.js");
  const lastUpdates = (await redis.hgetall("manga:last_updates")) || {};

  for (const item of whitelist) {
    const titleKey = normalizeTitleKey(item.title);
    const lastUpdateStr = lastUpdates[titleKey];

    if (Array.isArray(item.sources)) {
      for (const s of item.sources) {
        totalSources++;
        const src = s.source || "unknown";
        const mark = s.mark || "Active";
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
        markCounts[mark] = (markCounts[mark] || 0) + 1;
      }
    }

    if (lastUpdateStr) {
      const lastUpdate = new Date(lastUpdateStr).getTime();
      if (!Number.isNaN(lastUpdate) && now - lastUpdate < dayMs) {
        updated24h++;
      }
    }
  }

  const brokenLinks = (await redis.get("health:broken-links")) || [];
  const brokenCount = Array.isArray(brokenLinks) ? brokenLinks.length : 0;

  const sourceStats =
    Object.entries(sourceCounts)
      .map(([s, c]) => `• ${sourceLabel(s)}: \`${c}\``)
      .join("\n") || "-";

  const markStats =
    Object.entries(markCounts)
      .map(([m, c]) => `• ${m}: \`${c}\``)
      .join("\n") || "-";

  // Permissions (Reporting)
  const allowedUserIds =
    (await redis.smembers("whitelist:allowed_users")) || [];
  const permText =
    allowedUserIds.length > 0
      ? `${allowedUserIds.length} user tambahan`
      : "Hanya admin & owner";

  // Popularity Leaderboard
  const top5Raw =
    (await redis.zrange("manga:popularity_index", 0, 4, {
      rev: true,
      withScores: true,
    })) || [];
  const top5List = [];

  if (top5Raw.length > 0) {
    // Create a map for quick title lookup
    const titleMap = new Map();
    for (const item of whitelist) {
      titleMap.set(normalizeTitleKey(item.title), item.title);
    }

    for (let i = 0; i < top5Raw.length; i += 2) {
      const key = top5Raw[i];
      const score = top5Raw[i + 1];
      const realTitle = titleMap.get(key) || key;
      top5List.push(`${i / 2 + 1}. **${realTitle}** (\`${score}\` followers)`);
    }
  }

  const popularityStats =
    top5List.length > 0 ? top5List.join("\n") : "_Belum ada data follow_";

  const content = [
    "## 📊 Status Bot Komprehensif",
    "### Konektivitas",
    `⚡ Latency  : \`${latency}ms\``,
    `🗄️ Redis    : ${redisStatus}`,
    "🤖 Bot      : ✅ Online",
    "",
    "### Konfigurasi",
    `📋 Whitelist  : **${whitelist.length}** manga (**${totalSources}** sumber)`,
    `📢 Channel    : ${channelText}`,
    `⏱️ Interval   : ${CRON_INTERVAL_LABEL}`,
    `🗑️ Cache TTL  : **${CACHE_TTL_LABEL}**`,
    `🔐 Izin \`/add\`: ${permText}`,
    "",
    "### 🏆 Top 5 Terpopuler",
    popularityStats,
    "",
    "### Kesehatan Data",
    `Link Rusak  : **${brokenCount === 0 ? "0 ✅" : `**${brokenCount}** ⚠️`}**`,
    `Update (24j): **${updated24h}** ✨`,
    "",
    "### Statistik Sumber",
    sourceStats,
    "",
    "### Distribusi Status",
    markStats,
    "",
    `_Audit Terakhir: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB_`,
  ].join("\n");

  await editInteractionResponse(payload.token, content);
}

export default function handleStatus(payload, options, res) {
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Command ini hanya untuk admin server.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

  waitUntil(
    (async () => {
      try {
        await buildStatusMessage(payload);
      } catch (err) {
        logger.error({ err: err.message }, "[handleStatus] Error");
        await editInteractionResponse(
          payload,
          `❌ Kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}
