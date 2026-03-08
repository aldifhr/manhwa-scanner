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
import { logApiError, logApiHit, logApiOk } from "../lib/requestLog.js";
import {
  createWhitelistMatcher,
  getChapterNumber,
  normalizeTitleKey,
} from "../lib/domain/manga.js";
import { normalizeSource, normalizeSourceUrl } from "../lib/domain/source.js";
import { dispatchChapters } from "../lib/services/dispatch.js";
import {
  SOURCE_KEYS,
  buildNextSourceHealthMap,
  getDisabledSources,
  loadSourceHealthMap,
  saveSourceHealthMap,
} from "../lib/services/sourceHealth.js";
import { getLogger } from "../lib/logger.js";

export const config = { maxDuration: 60 };

const MANGA_HISTORY_LIMIT = 20;
const MANGA_HISTORY_TTL = 60 * 60 * 24 * 45;
const CHANNEL_VALIDATION_CACHE_SEC = 60 * 10;
const SOURCE_FAILURE_THRESHOLD = Number(process.env.SOURCE_FAIL_THRESHOLD || 3);
const SOURCE_COOLDOWN_SECONDS = Number(process.env.SOURCE_COOLDOWN_SECONDS || 1800);
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DEBUG = process.env.CRON_DEBUG === "true";
const logger = getLogger({ scope: "cron" });
const log = (...args) => DEBUG && logger.debug({ args }, "debug");
const warn = (...args) => logger.warn({ args }, "warn");

function buildMangaHistoryKey(item) {
  const source = normalizeSource(item?.source);
  const mangaUrl = normalizeSourceUrl(item?.mangaUrl || "");
  if (mangaUrl) return `history:manga:${source}:${mangaUrl}`;

  const title = normalizeTitleKey(item?.title || "");
  if (!title) return null;
  return `history:manga:${source}:title:${title}`;
}

function buildChapterHistoryRef(item) {
  const chapterUrl = normalizeSourceUrl(item?.url || "");
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
  const reqLogger = logApiHit("cron", req);

  if (!["GET", "POST"].includes(req.method)) {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const start = Date.now();
    logger.info("starting");

    const [whitelist, guildChannels, sourceHealthMap] = await Promise.all([
      loadWhitelist(),
      getAllGuildChannels(),
      loadSourceHealthMap(redis, SOURCE_KEYS),
    ]);

    const disabledSources = getDisabledSources(sourceHealthMap, SOURCE_KEYS);

    const { items: allResults, sourceStates } = await scrapeMangaUpdatesWithMeta(redis, {
      disabledSources,
    });

    const nowIso = new Date().toISOString();
    const nextSourceHealth = buildNextSourceHealthMap({
      sourceKeys: SOURCE_KEYS,
      currentMap: sourceHealthMap,
      sourceStates,
      nowIso,
      failureThreshold: SOURCE_FAILURE_THRESHOLD,
      cooldownSeconds: SOURCE_COOLDOWN_SECONDS,
    });
    await saveSourceHealthMap(redis, nextSourceHealth, SOURCE_KEYS);

    const guildEntries = Object.entries(guildChannels || {});
    logger.info({ whitelist: whitelist.length, guildsFound: guildEntries.length }, "loaded");

    const validEntries = await Promise.all(
      guildEntries.map(async ([guildId, channelId]) => {
        const valid = await validateChannel(channelId, guildId);
        return valid ? [guildId, channelId] : null;
      }),
    );

    const validGuilds = Object.fromEntries(validEntries.filter(Boolean));
    const activeGuildCount = Object.keys(validGuilds).length;
    const activeChannelIds = Object.values(validGuilds);

    logger.info({ guildsFound: guildEntries.length, guildsActive: activeGuildCount }, "guild validation");

    if (DEBUG && activeGuildCount) {
      log(
        "Valid:",
        Object.entries(validGuilds)
          .map(([g, c]) => `${g.slice(-4)}->${c.slice(-4)}`)
          .join(", "),
      );
    }

    if (!activeGuildCount) {
      logApiOk(reqLogger, { status: 200, reason: "no_active_guilds" });
      return res.status(200).json({
        ok: true,
        guilds: 0,
        whitelist: whitelist.length,
        sourceHealth: nextSourceHealth,
        message: "No active guilds",
      });
    }

    if (!whitelist.length) {
      logApiOk(reqLogger, { status: 200, reason: "no_whitelist" });
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
      logApiOk(reqLogger, { status: 200, reason: "no_new_chapters" });
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

    const { sent, skipped, failed } = await dispatchChapters({
      redis,
      matched,
      channelIds: activeChannelIds,
      sendEmbed: sendDiscordEmbed,
      nowIso,
      log,
      warn,
      onDispatchSuccess: (item) => saveMangaHistory(item),
    });

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

    logger.info(
      { duration, sent, skipped, failed, guilds: activeGuildCount },
      "done",
    );

    logApiOk(reqLogger, { status: 200, sent, skipped, failed, guilds: activeGuildCount });
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
    logger.error({ err: err.message }, "fatal");
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: "Internal error" });
  }
}
