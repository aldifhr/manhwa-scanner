import { redis, loadWhitelist }          from "../lib/redis.js";
import { isCronAuthorized }              from "../lib/auth.js";
import { sendDiscordEmbed }              from "../lib/discord.js";
import { deleteGuildChannel,
         getAllGuildChannels }            from "../lib/redis.js";
import { scrapeMangaUpdates }            from "../lib/scraper.js";
import axios                             from "axios";

export const config = { maxDuration: 60 };

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CHAPTER_TTL    = 60 * 60 * 24 * 3; // 3 hari
const DISCORD_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DEBUG          = process.env.CRON_DEBUG === "true";

const log  = (...args) => DEBUG && console.log("[cron]", ...args);
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

/**
 * Cek apakah bot masih punya akses ke channel.
 * Auto-remove guild dari Redis kalau 403/404.
 */
async function validateChannel(channelId, guildId) {
  try {
    await axios.get(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    return true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 403) {
      warn(`Removing invalid guild ${guildId} (${status})`);
      await deleteGuildChannel(guildId);
    } else if (status === 401) {
      warn("Bot token invalid");
    } else {
      warn(`Validate error guild ${guildId}: ${err.message}`);
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

    if (!whitelist.length) {
      return res.status(200).json({ ok: true, message: "Whitelist empty" });
    }

    // ── Validasi semua guild secara paralel ──────────────────────────────────
    const validEntries = await Promise.all(
      Object.entries(guildChannels).map(async ([guildId, channelId]) => {
        const valid = await validateChannel(channelId, guildId);
        return valid ? [guildId, channelId] : null;
      }),
    );
    const validGuilds = Object.fromEntries(validEntries.filter(Boolean));

    if (!Object.keys(validGuilds).length) {
      return res.status(200).json({ ok: true, message: "No active guilds" });
    }

    // ── Match chapter baru dengan whitelist ──────────────────────────────────
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

    // Sort chapter kecil → besar agar urutan notifikasi benar
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

      // nx: true — atomic claim, skip kalau sudah ada
      const claimed = await redis.set(key, Date.now().toString(), {
        ex: CHAPTER_TTL,
        nx: true,
      });

      if (!claimed) {
        log(`Skip (already sent): ${item.title} ${item.chapter}`);
        skipped++;
        continue;
      }

      let success = false;

      for (const channelId of Object.values(validGuilds)) {
        try {
          await sendDiscordEmbed(item, channelId, redis);
          success = true;
        } catch (err) {
          failed++;
          warn(`Failed channel ${channelId}: ${err.message}`);
        }
      }

      // Kalau semua guild gagal, lepas claim agar bisa dicoba lagi
      if (!success) {
        await redis.del(key);
        warn(`All guilds failed for "${item.title}" — key released`);
        continue;
      }

      const nowIso = new Date().toISOString();

      // Upstash auto-serialize — tidak perlu JSON.stringify
      await redis.lpush("recent:chapters", {
        title:   item.title,
        chapter: item.chapter,
        url:     item.url,
        cover:   item.cover ?? null,
        sentAt:  nowIso,
      });

      await redis.lpush("cron:logs", {
        time:    nowIso,
        message: `${item.title} — ${item.chapter}`,
        title:   item.title,
        chapter: item.chapter,
        tag:     "sent",
      });

      sent++;
    }

    // ── Trim lists sekali di akhir ───────────────────────────────────────────
    await Promise.all([
      redis.ltrim("recent:chapters", 0, 99),
      redis.expire("recent:chapters", 60 * 60 * 24 * 14),
      redis.ltrim("cron:logs", 0, 499),
      redis.expire("cron:logs", 60 * 60 * 24 * 30),
    ]);

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    // Simpan last_run dan trend — Upstash auto-serialize
    const minuteSlot = Math.floor(Date.now() / (5 * 60 * 1000));

    await Promise.all([
      redis.set("cron:last_run", {
        sent,
        skipped,
        failed,
        duration,
        timestamp: new Date().toISOString(),
      }),
      redis.set(
        `cron:trend:${minuteSlot}`,
        { sent, skipped, failed, duration: parseFloat(duration) },
        { ex: 7200 },
      ),
    ]);

    console.log(`[cron] Done in ${duration}s — sent:${sent} skipped:${skipped} failed:${failed}`);

    return res.status(200).json({ ok: true, sent, skipped, failed, duration });
  } catch (err) {
    console.error("[cron] FATAL:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}