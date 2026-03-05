import { redis, loadWhitelist } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import { deleteGuildChannel, getAllGuildChannels } from "../lib/redis.js";
import { scrapeMangaUpdates } from "../lib/scraper.js";
import axios from "axios";

export const config = { maxDuration: 60 };

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const CHAPTER_TTL = 60 * 60 * 24 * 3; // 3 hari
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DEBUG = process.env.CRON_DEBUG === "true";
const log = (...args) => DEBUG && console.log("[cron]", ...args);
const warn = (...args) => console.warn("[cron]", ...args);

// ─── UTILS ────────────────────────────────────────────────────────────────────
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

// ─── VALIDATE CHANNEL ─────────────────────────────────────────────────────────
async function validateChannel(channelId, guildId) {
  try {
    const resp = await axios.get(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    const channel = resp.data;
    log(`✅ CONNECTED: #${channel.name} (${channelId.slice(-4)}) in guild ${guildId.slice(-4)}`);
    return true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 403) {
      warn(`❌ DISCONNECTED: guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status}) — removed`);
      await deleteGuildChannel(guildId);
    } else if (status === 401) {
      warn("❌ Bot token invalid — all fail");
    } else {
      warn(`⚠️ Validate ${guildId.slice(-4)}: ${err.message}`);
    }
    return false;
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method))
    return res.status(405).json({ error: "Method not allowed" });

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const start = Date.now();
    console.log("[cron] Starting...");

    // ── Fetch data paralel ───────────────────────────────────────────────────
    const [whitelist, allResults, guildChannels] = await Promise.all([
      loadWhitelist(),
      scrapeMangaUpdates(redis),
      getAllGuildChannels(),
    ]);

    // ── VALIDASI GUILD SELAMANYA (atas whitelist) ────────────────────────────
    console.log(`[cron] Whitelist:${whitelist.length} | Guilds found:${Object.keys(guildChannels || {}).length}`);
    
    const validEntries = await Promise.all(
      Object.entries(guildChannels || {}).map(async ([guildId, channelId]) => {
        const valid = await validateChannel(channelId, guildId);
        return valid ? [guildId, channelId] : null;
      })
    );

    const validGuilds = Object.fromEntries(validEntries.filter(Boolean));
    console.log(`[cron] Guilds: ${Object.keys(guildChannels || {}).length} → Active: ${Object.keys(validGuilds).length}`);
    
    if (DEBUG && Object.keys(validGuilds).length) {
      log("Valid:", Object.entries(validGuilds)
        .map(([g, c]) => `${g.slice(-4)}→${c.slice(-4)}`)
        .join(", "));
    }

    if (!Object.keys(validGuilds).length) {
      return res.status(200).json({ 
        ok: true, 
        guilds: 0, 
        whitelist: whitelist.length,
        message: "No active guilds" 
      });
    }

    // ── Check whitelist (setelah validasi) ───────────────────────────────────
    if (!whitelist.length) {
      return res.status(200).json({ 
        ok: true, 
        guilds: Object.keys(validGuilds).length,
        message: "No whitelist" 
      });
    }

    // ── Match chapter baru ───────────────────────────────────────────────────
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
      })
    );

    if (!matched.length) {
      return res.status(200).json({ 
        ok: true, 
        guilds: Object.keys(validGuilds).length,
        scraped: allResults.length,
        message: "No new chapters" 
      });
    }

    // Sort chapter kecil → besar
    matched.sort((a, b) => {
      const getNum = (c) => {
        const m = c.chapter?.match(/\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : 0;
      };
      return getNum(a) - getNum(b);
    });

    log(`Matched ${matched.length} chapters`);

    // ── Kirim notifikasi ─────────────────────────────────────────────────────
    let sent = 0, skipped = 0, failed = 0;

    for (const item of matched) {
      const key = `chapter:${normalizeUrl(item.url)}`;

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

      for (const channelId of Object.values(validGuilds)) {
        try {
          await sendDiscordEmbed(item, channelId, redis);
          success = true;
          log(`✅ Sent to ${channelId.slice(-4)}: ${item.title}`);
        } catch (err) {
          failed++;
          warn(`Failed ${channelId.slice(-4)}: ${err.message}`);
        }
      }

      if (!success) {
        await redis.del(key);
        warn(`All guilds failed "${item.title}" — released`);
        continue;
      }

      const nowIso = new Date().toISOString();
      await redis.lpush("recent:chapters", {
        title: item.title,
        chapter: item.chapter,
        url: item.url,
        cover: item.cover ?? null,
        sentAt: nowIso,
      });

      await redis.lpush("cron:logs", {
        time: nowIso,
        message: `${item.title} — ${item.chapter}`,
        title: item.title,
        chapter: item.chapter,
        tag: "sent",
      });

      sent++;
    }

    // ── Cleanup lists ────────────────────────────────────────────────────────
    await Promise.all([
      redis.ltrim("recent:chapters", 0, 99),
      redis.expire("recent:chapters", 60 * 60 * 24 * 14),
      redis.ltrim("cron:logs", 0, 499),
      redis.expire("cron:logs", 60 * 60 * 24 * 30),
    ]);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const minuteSlot = Math.floor(Date.now() / (5 * 60 * 1000));

    await Promise.all([
      redis.set("cron:last_run", {
        sent, skipped, failed, duration,
        guilds: Object.keys(validGuilds).length,
        timestamp: new Date().toISOString(),
      }),
      redis.set(`cron:trend:${minuteSlot}`, {
        sent, skipped, failed, duration: parseFloat(duration)
      }, { ex: 7200 }),
    ]);

    console.log(`[cron] Done ${duration}s — sent:${sent} skipped:${skipped} failed:${failed} guilds:${Object.keys(validGuilds).length}`);

    return res.status(200).json({ 
      ok: true, sent, skipped, failed, 
      guilds: Object.keys(validGuilds).length,
      duration 
    });
  } catch (err) {
    console.error("[cron] FATAL:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
