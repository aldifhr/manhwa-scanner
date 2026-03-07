import axios from "axios";
import { isCronAuthorized } from "../lib/auth.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import {
  deleteGuildChannel,
  getAllGuildChannels,
  loadWhitelist,
  redis,
} from "../lib/redis.js";
import { scrapeMangaUpdates } from "../lib/scraper.js";
import { logApiHit } from "../lib/requestLog.js";

export const config = { maxDuration: 60 };

const CHAPTER_TTL = 60 * 60 * 24 * 3;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DEBUG = process.env.CRON_DEBUG === "true";
const log = (...args) => DEBUG && console.log("[cron]", ...args);
const warn = (...args) => console.warn("[cron]", ...args);

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(u) {
  const normalized = u?.replace(/\/+$/, "").toLowerCase().trim();
  return normalized
    ?.replace(/^https?:\/\/(?:www\.)?shngm\.id\b/, "https://a.shinigami.asia")
    ?.replace(/^https?:\/\/(?:www\.)?shinigami\.asia\b/, "https://a.shinigami.asia");
}

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function getChapterNumber(chapterText) {
  const m = chapterText?.match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

function createWhitelistMatcher(whitelist) {
  const prepared = whitelist.map((entry) => ({
    hasUrl: Boolean(entry.url),
    url: entry.url ? normalizeUrl(entry.url) : null,
    title: entry.title ? normalizeTitle(entry.title) : null,
    source: normalizeSource(entry.source),
  }));

  return (item) => {
    const itemUrl = item.mangaUrl ? normalizeUrl(item.mangaUrl) : null;
    const itemTitle = item.title ? normalizeTitle(item.title) : null;
    const itemSource = normalizeSource(item.source);

    return prepared.some((entry) => {
      if (entry.source && itemSource !== entry.source) return false;
      // Jika whitelist punya URL, wajib match URL exact (hindari konflik title lintas source)
      if (entry.hasUrl) return Boolean(itemUrl) && itemUrl === entry.url;

      // Fallback title hanya untuk entry legacy tanpa URL
      if (!entry.title || !itemTitle) return false;
      return (
        itemTitle === entry.title ||
        itemTitle.includes(entry.title) ||
        entry.title.includes(itemTitle)
      );
    });
  };
}

async function validateChannel(channelId, guildId) {
  try {
    const resp = await axios.get(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    const channel = resp.data;
    log(
      `CONNECTED: #${channel.name} (${channelId.slice(-4)}) in guild ${guildId.slice(-4)}`,
    );
    return true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 403) {
      warn(`DISCONNECTED: guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status})`);
      await deleteGuildChannel(guildId);
    } else if (status === 401) {
      warn("Bot token invalid");
    } else {
      warn(`Validate ${guildId.slice(-4)}: ${err.message}`);
    }
    return false;
  }
}

export default async function handler(req, res) {
  logApiHit("cron", req);

  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const start = Date.now();
    console.log("[cron] Starting...");

    const [whitelist, allResults, guildChannels] = await Promise.all([
      loadWhitelist(),
      scrapeMangaUpdates(redis),
      getAllGuildChannels(),
    ]);

    const guildEntries = Object.entries(guildChannels || {});
    console.log(`[cron] Whitelist:${whitelist.length} | Guilds found:${guildEntries.length}`);

    const validEntries = await Promise.all(
      guildEntries.map(async ([guildId, channelId]) => {
        const valid = await validateChannel(channelId, guildId);
        return valid ? [guildId, channelId] : null;
      }),
    );

    const validGuilds = Object.fromEntries(validEntries.filter(Boolean));
    const activeGuildCount = Object.keys(validGuilds).length;
    const activeChannelIds = Object.values(validGuilds);

    console.log(`[cron] Guilds: ${guildEntries.length} -> Active: ${activeGuildCount}`);

    if (DEBUG && activeGuildCount) {
      log(
        "Valid:",
        Object.entries(validGuilds)
          .map(([g, c]) => `${g.slice(-4)}->${c.slice(-4)}`)
          .join(", "),
      );
    }

    if (!activeGuildCount) {
      return res.status(200).json({
        ok: true,
        guilds: 0,
        whitelist: whitelist.length,
        message: "No active guilds",
      });
    }

    if (!whitelist.length) {
      return res.status(200).json({
        ok: true,
        guilds: activeGuildCount,
        message: "No whitelist",
      });
    }

    const isMatched = createWhitelistMatcher(whitelist);
    const matched = allResults.filter(isMatched);

    if (!matched.length) {
      return res.status(200).json({
        ok: true,
        guilds: activeGuildCount,
        scraped: allResults.length,
        message: "No new chapters",
      });
    }

    matched.sort((a, b) => getChapterNumber(a.chapter) - getChapterNumber(b.chapter));
    log(`Matched ${matched.length} chapters`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of matched) {
      const normalizedChapterUrl = normalizeUrl(item.url);
      if (!normalizedChapterUrl) {
        skipped++;
        continue;
      }

      const key = `chapter:${normalizedChapterUrl}`;
      const claimed = await redis.set(key, Date.now().toString(), {
        ex: CHAPTER_TTL,
        nx: true,
      });

      if (!claimed) {
        log(`Skip (TTL): ${item.title} ${item.chapter}`);
        skipped++;
        continue;
      }

      let success = false;

      for (const channelId of activeChannelIds) {
        try {
          await sendDiscordEmbed(item, channelId, redis);
          success = true;
          log(`Sent to ${channelId.slice(-4)}: ${item.title}`);
        } catch (err) {
          failed++;
          warn(`Failed ${channelId.slice(-4)}: ${err.message}`);
        }
      }

      if (!success) {
        await redis.del(key);
        warn(`All guilds failed "${item.title}" - released`);
        continue;
      }

      const nowIso = new Date().toISOString();
      await redis.lpush("recent:chapters", {
        title: item.title,
        chapter: item.chapter,
        url: item.url,
        cover: item.cover ?? null,
        source: item.source ?? "ikiru",
        updatedTime: item.updatedTime ?? null,
        sentAt: nowIso,
      });

      await redis.lpush("cron:logs", {
        time: nowIso,
        message: `${item.title} - ${item.chapter}`,
        title: item.title,
        chapter: item.chapter,
        tag: "sent",
      });

      sent++;
    }

    await Promise.all([
      redis.ltrim("recent:chapters", 0, 99),
      redis.expire("recent:chapters", 60 * 60 * 24 * 14),
      redis.ltrim("cron:logs", 0, 499),
      redis.expire("cron:logs", 60 * 60 * 24 * 30),
    ]);

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    await redis.set("cron:last_run", {
      sent,
      skipped,
      failed,
      duration,
      guilds: activeGuildCount,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[cron] Done ${duration}s - sent:${sent} skipped:${skipped} failed:${failed} guilds:${activeGuildCount}`,
    );

    return res.status(200).json({
      ok: true,
      sent,
      skipped,
      failed,
      guilds: activeGuildCount,
      duration,
    });
  } catch (err) {
    console.error("[cron] FATAL:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
