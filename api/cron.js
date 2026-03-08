import axios from "axios";
import { isCronAuthorized } from "../lib/auth.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import {
  deleteGuildChannel,
  getAllGuildChannels,
  loadWhitelist,
  redis,
} from "../lib/redis.js";
import { scrapeMangaUpdatesWithMeta } from "../lib/scraper.js";
import { logApiHit } from "../lib/requestLog.js";

export const config = { maxDuration: 60 };

const CHAPTER_TTL = 60 * 60 * 24 * 3;
const MANGA_HISTORY_LIMIT = 20;
const MANGA_HISTORY_TTL = 60 * 60 * 24 * 45;
const CHANNEL_VALIDATION_CACHE_SEC = 60 * 10;
const SOURCE_FAILURE_THRESHOLD = Number(process.env.SOURCE_FAIL_THRESHOLD || 3);
const SOURCE_COOLDOWN_SECONDS = Number(process.env.SOURCE_COOLDOWN_SECONDS || 1800);
const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DEBUG = process.env.CRON_DEBUG === "true";
const log = (...args) => DEBUG && console.log("[cron]", ...args);
const warn = (...args) => console.warn("[cron]", ...args);

function normalizeTitle(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
      if (entry.hasUrl) return Boolean(itemUrl) && itemUrl === entry.url;
      if (!entry.title || !itemTitle) return false;
      return (
        itemTitle === entry.title ||
        itemTitle.includes(entry.title) ||
        entry.title.includes(itemTitle)
      );
    });
  };
}

function defaultSourceHealth(source) {
  return {
    source,
    status: "healthy",
    consecutiveFailures: 0,
    disabledUntil: null,
    lastError: null,
    lastSuccessAt: null,
    lastCheckedAt: null,
  };
}

function sanitizeSourceHealth(source, raw = null) {
  const base = defaultSourceHealth(source);
  if (!raw || typeof raw !== "object") return base;

  const failures = Number(raw.consecutiveFailures || 0);
  const disabledUntil = raw.disabledUntil || null;
  const status = raw.status === "degraded" ? "degraded" : "healthy";

  return {
    ...base,
    ...raw,
    source,
    status,
    consecutiveFailures: Number.isFinite(failures) ? failures : 0,
    disabledUntil,
  };
}

function sourceHealthKey(source) {
  return `source:health:${source}`;
}

async function loadSourceHealthMap() {
  const pairs = await Promise.all(
    SOURCE_KEYS.map(async (source) => {
      const raw = await redis.get(sourceHealthKey(source));
      return [source, sanitizeSourceHealth(source, raw)];
    }),
  );
  return Object.fromEntries(pairs);
}

function isSourceInCooldown(health, nowMs = Date.now()) {
  if (!health?.disabledUntil) return false;
  const disabledMs = new Date(health.disabledUntil).getTime();
  return Number.isFinite(disabledMs) && disabledMs > nowMs;
}

function applySourceOutcome(current, outcome, nowIso) {
  const next = { ...current, lastCheckedAt: nowIso };
  const outcomeStatus = outcome?.status || "ok";

  if (outcomeStatus === "error") {
    const failures = Number(next.consecutiveFailures || 0) + 1;
    const isDegraded = failures >= SOURCE_FAILURE_THRESHOLD;
    next.consecutiveFailures = failures;
    next.status = isDegraded ? "degraded" : "healthy";
    next.lastError = outcome.error || "unknown error";
    next.disabledUntil = isDegraded
      ? new Date(Date.now() + SOURCE_COOLDOWN_SECONDS * 1000).toISOString()
      : null;
    return next;
  }

  if (outcomeStatus === "ok") {
    next.status = "healthy";
    next.consecutiveFailures = 0;
    next.disabledUntil = null;
    next.lastError = null;
    next.lastSuccessAt = nowIso;
    return next;
  }

  // skipped: keep current status; if cooldown sudah lewat, otomatis healthy lagi.
  if (next.status === "degraded" && !isSourceInCooldown(next)) {
    next.status = "healthy";
    next.consecutiveFailures = 0;
    next.disabledUntil = null;
    next.lastError = null;
  }
  return next;
}

function buildMangaHistoryKey(item) {
  const source = normalizeSource(item?.source);
  const mangaUrl = normalizeUrl(item?.mangaUrl || "");
  if (mangaUrl) return `history:manga:${source}:${mangaUrl}`;

  const title = normalizeTitle(item?.title || "");
  if (!title) return null;
  return `history:manga:${source}:title:${title}`;
}

function buildChapterHistoryRef(item) {
  const chapterUrl = normalizeUrl(item?.url || "");
  if (chapterUrl) return chapterUrl;

  const chapter = String(item?.chapter || "").trim();
  const updated = String(item?.updatedTime || "").trim();
  if (!chapter && !updated) return null;
  return `${chapter}|${updated}`;
}

async function saveMangaHistory(item) {
  const key = buildMangaHistoryKey(item);
  const chapterRef = buildChapterHistoryRef(item);
  if (!key || !chapterRef) return;

  const current = await redis.lrange(key, 0, MANGA_HISTORY_LIMIT - 1);
  if (Array.isArray(current) && current.includes(chapterRef)) {
    await redis.expire(key, MANGA_HISTORY_TTL);
    return;
  }

  await Promise.all([
    redis.lpush(key, chapterRef),
    redis.ltrim(key, 0, MANGA_HISTORY_LIMIT - 1),
    redis.expire(key, MANGA_HISTORY_TTL),
  ]);
}

async function validateChannel(channelId, guildId) {
  const cacheKey = `cache:channel-valid:${channelId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached === true) return true;
    if (cached === false) return false;
  } catch {
    // ignore cache read errors
  }

  try {
    const resp = await axios.get(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    const channel = resp.data;
    log(
      `CONNECTED: #${channel.name} (${channelId.slice(-4)}) in guild ${guildId.slice(-4)}`,
    );
    await redis.set(cacheKey, true, { ex: CHANNEL_VALIDATION_CACHE_SEC }).catch(() => {});
    return true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 403) {
      warn(`DISCONNECTED: guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status})`);
      await deleteGuildChannel(guildId);
      await redis.set(cacheKey, false, { ex: CHANNEL_VALIDATION_CACHE_SEC }).catch(() => {});
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

    const [whitelist, guildChannels, sourceHealthMap] = await Promise.all([
      loadWhitelist(),
      getAllGuildChannels(),
      loadSourceHealthMap(),
    ]);

    const disabledSources = SOURCE_KEYS.filter((source) =>
      isSourceInCooldown(sourceHealthMap[source]),
    );

    const { items: allResults, sourceStates } = await scrapeMangaUpdatesWithMeta(redis, {
      disabledSources,
    });

    const nowIso = new Date().toISOString();
    const nextSourceHealth = {};
    for (const source of SOURCE_KEYS) {
      const current = sourceHealthMap[source] || defaultSourceHealth(source);
      const outcome = sourceStates?.[source] || { status: "ok" };
      nextSourceHealth[source] = applySourceOutcome(current, outcome, nowIso);
    }
    await Promise.all(
      SOURCE_KEYS.map((source) =>
        redis.set(sourceHealthKey(source), nextSourceHealth[source]),
      ),
    );

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
        sourceHealth: nextSourceHealth,
        message: "No active guilds",
      });
    }

    if (!whitelist.length) {
      return res.status(200).json({
        ok: true,
        guilds: activeGuildCount,
        sourceHealth: nextSourceHealth,
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
        sourceHealth: nextSourceHealth,
        message: "No new chapters",
      });
    }

    matched.sort((a, b) => getChapterNumber(a.chapter) - getChapterNumber(b.chapter));
    log(`Matched ${matched.length} chapters`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const chapterMeta = matched.map((item) => {
      const normalizedChapterUrl = normalizeUrl(item.url);
      return {
        item,
        normalizedChapterUrl,
        key: normalizedChapterUrl ? `chapter:${normalizedChapterUrl}` : null,
      };
    });
    const validChapterMeta = chapterMeta.filter((entry) => entry.key);

    const existingFlags = validChapterMeta.length
      ? await redis.mget(...validChapterMeta.map((entry) => entry.key))
      : [];
    const prefiltered = validChapterMeta.filter((_, i) => !existingFlags[i]);
    skipped += chapterMeta.length - validChapterMeta.length;
    skipped += validChapterMeta.length - prefiltered.length;
    const writeTasks = [];
    const WRITE_TASK_BATCH = 24;
    const flushWriteTasks = async () => {
      if (!writeTasks.length) return;
      await Promise.all(writeTasks.splice(0, writeTasks.length));
    };

    for (const entry of prefiltered) {
      const { item, key } = entry;
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

      writeTasks.push(
        redis.lpush("recent:chapters", {
          title: item.title,
          chapter: item.chapter,
          url: item.url,
          cover: item.cover ?? null,
          source: item.source ?? "ikiru",
          updatedTime: item.updatedTime ?? null,
          sentAt: nowIso,
        }),
        redis.lpush("cron:logs", {
          time: nowIso,
          message: `${item.title} - ${item.chapter}`,
          title: item.title,
          chapter: item.chapter,
          tag: "sent",
        }),
        saveMangaHistory(item),
      );
      if (writeTasks.length >= WRITE_TASK_BATCH) {
        await flushWriteTasks();
      }

      sent++;
    }

    await flushWriteTasks();

    await Promise.all([
      redis.ltrim("recent:chapters", 0, 99),
      redis.expire("recent:chapters", 60 * 60 * 24 * 14),
      redis.ltrim("cron:logs", 0, 499),
      redis.expire("cron:logs", 60 * 60 * 24 * 30),
    ]);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const scrapeMetrics = Object.fromEntries(
      SOURCE_KEYS.map((source) => [source, sourceStates?.[source]?.metrics ?? null]),
    );
    const statusPayload = {
      sent,
      skipped,
      failed,
      duration,
      guilds: activeGuildCount,
      timestamp: new Date().toISOString(),
      sourceHealth: nextSourceHealth,
      scrapeMetrics,
    };
    await redis.set("cron:last_run", statusPayload);

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
      sourceHealth: nextSourceHealth,
      scrapeMetrics,
    });
  } catch (err) {
    console.error("[cron] FATAL:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
