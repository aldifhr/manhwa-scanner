import { createHash } from "crypto";
import pLimit from "p-limit";
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
import {
  STATUS_API_CACHE_KEY,
  invalidateDashboardCaches,
} from "../lib/cacheKeys.js";
import { appendCronLog, buildCronErrorLog } from "../lib/cronLogs.js";
import { dispatchChapters } from "../lib/services/dispatch.js";
import {
  SOURCE_KEYS,
  buildNextSourceHealthMap,
  getDisabledSources,
  loadSourceHealthMap,
  saveSourceHealthMap,
} from "../lib/services/sourceHealth.js";
import { getLogger } from "../lib/logger.js";
import { httpGet } from "../lib/httpClient.js";

export const config = { maxDuration: 60 };

const MANGA_HISTORY_LIMIT = 20;
const MANGA_HISTORY_TTL = 60 * 60 * 24 * 45;
const CHANNEL_VALIDATION_CACHE_SEC = 60 * 10;
const CHANNEL_VALIDATION_REFRESH_SECONDS = Number(
  process.env.CHANNEL_VALIDATION_REFRESH_SECONDS || 3600,
);
const CHANNEL_VALIDATION_REFRESH_KEY = "cron:last_channel_validation_at";
const CHANNEL_VALIDATION_CONCURRENCY_DEFAULT = 8;
const CHANNEL_VALIDATION_CONCURRENCY_MIN = 1;
const CHANNEL_VALIDATION_CONCURRENCY_MAX = 20;

function resolveChannelValidationConcurrency(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return {
      value: CHANNEL_VALIDATION_CONCURRENCY_DEFAULT,
      raw: rawValue,
      reason: null,
    };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return {
      value: CHANNEL_VALIDATION_CONCURRENCY_DEFAULT,
      raw: rawValue,
      reason: "invalid_number",
    };
  }

  const integer = Math.trunc(parsed);
  if (integer < CHANNEL_VALIDATION_CONCURRENCY_MIN) {
    return {
      value: CHANNEL_VALIDATION_CONCURRENCY_MIN,
      raw: rawValue,
      reason: "below_min",
    };
  }

  if (integer > CHANNEL_VALIDATION_CONCURRENCY_MAX) {
    return {
      value: CHANNEL_VALIDATION_CONCURRENCY_MAX,
      raw: rawValue,
      reason: "above_max",
    };
  }

  return {
    value: integer,
    raw: rawValue,
    reason: null,
  };
}

const CHANNEL_VALIDATION_CONCURRENCY_RESOLVED = resolveChannelValidationConcurrency(
  process.env.CHANNEL_VALIDATION_CONCURRENCY,
);
const CHANNEL_VALIDATION_CONCURRENCY =
  CHANNEL_VALIDATION_CONCURRENCY_RESOLVED.value;
const SOURCE_FAILURE_THRESHOLD = Number(process.env.SOURCE_FAIL_THRESHOLD || 3);
const SOURCE_COOLDOWN_SECONDS = Number(process.env.SOURCE_COOLDOWN_SECONDS || 1800);
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DEBUG = process.env.CRON_DEBUG === "true";
const logger = getLogger({ scope: "cron" });
const log = (...args) => DEBUG && logger.debug({ args }, "debug");
const warn = (...args) => logger.warn({ args }, "warn");

async function persistCronStatus(statusPayload) {
  await redis.set("cron:last_run", statusPayload);
  await invalidateDashboardCaches(redis, [STATUS_API_CACHE_KEY]);
}

function buildShortCircuitStatus({
  reason,
  start,
  guilds = 0,
  whitelist = 0,
  scraped = 0,
  sourceHealth = {},
}) {
  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    duration: ((Date.now() - start) / 1000).toFixed(1),
    guilds,
    whitelist,
    scraped,
    timestamp: new Date().toISOString(),
    sourceHealth,
    outcome: "short_circuit",
    shortCircuitReason: reason,
  };
}

export function shouldRunChannelValidation(
  lastValidatedAt,
  refreshSeconds = CHANNEL_VALIDATION_REFRESH_SECONDS,
  nowMs = Date.now(),
) {
  const refreshMs = Math.max(60, Number(refreshSeconds) || 3600) * 1000;
  const lastMs = new Date(lastValidatedAt || "").getTime();
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= refreshMs;
}

function buildGuildChannelMap(entries = []) {
  return Object.fromEntries(entries.filter(([, channelId]) => Boolean(channelId)));
}

function buildPreferredSecondaryTitles(whitelist = []) {
  const out = {
    shinigami_project: [],
    shinigami_mirror: [],
  };

  for (const entry of whitelist) {
    const source = normalizeSource(entry?.source);
    if ((source === "shinigami_project" || source === "shinigami_mirror") && entry?.title) {
      out[source].push(entry.title);
    }
  }

  return out;
}

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

function buildMangaHistorySeenKey(item) {
  const key = buildMangaHistoryKey(item);
  const chapterRef = buildChapterHistoryRef(item);
  if (!key || !chapterRef) return null;

  const digest = createHash("sha1")
    .update(`${key}|${chapterRef}`)
    .digest("hex");
  return `history:seen:${digest}`;
}

async function saveMangaHistory(item) {
  const key = buildMangaHistoryKey(item);
  const chapterRef = buildChapterHistoryRef(item);
  const seenKey = buildMangaHistorySeenKey(item);
  if (!key || !chapterRef || !seenKey) return;

  const claimed = await redis.set(seenKey, "1", {
    nx: true,
    ex: MANGA_HISTORY_TTL,
  });
  if (!claimed) {
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
    const resp = await httpGet(
      `https://discord.com/api/v10/channels/${channelId}`,
      {
        headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
        timeout: 10000,
      },
      {
        retries: 2,
      },
    );
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
    if (CHANNEL_VALIDATION_CONCURRENCY_RESOLVED.reason) {
      warn(
        `CHANNEL_VALIDATION_CONCURRENCY="${CHANNEL_VALIDATION_CONCURRENCY_RESOLVED.raw}" invalid (${CHANNEL_VALIDATION_CONCURRENCY_RESOLVED.reason}), using ${CHANNEL_VALIDATION_CONCURRENCY}`,
      );
    }
    logger.info(
      {
        channelValidationConcurrency: CHANNEL_VALIDATION_CONCURRENCY,
      },
      "runtime config",
    );
    logger.info("starting");

    const [whitelist, guildChannels, sourceHealthMap] = await Promise.all([
      loadWhitelist(),
      getAllGuildChannels(),
      loadSourceHealthMap(redis, SOURCE_KEYS),
    ]);

    const guildEntries = Object.entries(guildChannels || {});
    logger.info({ whitelist: whitelist.length, guildsFound: guildEntries.length }, "loaded");

    if (!whitelist.length) {
      const statusPayload = buildShortCircuitStatus({
        reason: "no_whitelist",
        start,
        guilds: guildEntries.length,
        whitelist: 0,
        sourceHealth: sourceHealthMap,
      });
      await persistCronStatus(statusPayload);
      await appendCronLog(redis, {
        tag: "info",
        code: "no_whitelist",
        type: "short_circuit",
        source: "cron",
        message: "Cron skipped because whitelist is empty.",
      });
      logApiOk(reqLogger, { status: 200, reason: "no_whitelist" });
      return res.status(200).json({
        ok: true,
        ...statusPayload,
        message: "No whitelist",
      });
    }

    const lastValidation = await redis.get(CHANNEL_VALIDATION_REFRESH_KEY).catch(() => null);
    const lastValidationAt = typeof lastValidation === "string"
      ? lastValidation
      : lastValidation?.at || null;
    const runFullValidation = shouldRunChannelValidation(lastValidationAt);

    let validGuilds;
    if (runFullValidation) {
      const validateLimit = pLimit(CHANNEL_VALIDATION_CONCURRENCY);
      const validEntries = await Promise.all(
        guildEntries.map(([guildId, channelId]) =>
          validateLimit(async () => {
            const valid = await validateChannel(channelId, guildId);
            return valid ? [guildId, channelId] : null;
          }),
        ),
      );
      validGuilds = Object.fromEntries(validEntries.filter(Boolean));
      await redis
        .set(CHANNEL_VALIDATION_REFRESH_KEY, {
          at: new Date().toISOString(),
          total: guildEntries.length,
          valid: Object.keys(validGuilds).length,
        })
        .catch(() => {});
    } else {
      validGuilds = buildGuildChannelMap(guildEntries);
      logger.info(
        {
          lastValidationAt,
          refreshSeconds: CHANNEL_VALIDATION_REFRESH_SECONDS,
        },
        "guild validation skipped (cached mode)",
      );
    }

    const disabledSources = getDisabledSources(sourceHealthMap, SOURCE_KEYS);

    const activeGuildCount = Object.keys(validGuilds).length;
    const activeChannelIds = Object.values(validGuilds);
    const channelToGuild = new Map(
      Object.entries(validGuilds).map(([guildId, channelId]) => [channelId, guildId]),
    );

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
      const statusPayload = buildShortCircuitStatus({
        reason: "no_active_guilds",
        start,
        guilds: 0,
        whitelist: whitelist.length,
        sourceHealth: sourceHealthMap,
      });
      await persistCronStatus(statusPayload);
      await appendCronLog(redis, {
        tag: "info",
        code: "no_active_guilds",
        type: "short_circuit",
        source: "cron",
        message: "Cron skipped because no active guilds were available.",
      });
      logApiOk(reqLogger, { status: 200, reason: "no_active_guilds" });
      return res.status(200).json({
        ok: true,
        ...statusPayload,
        message: "No active guilds",
      });
    }

    const { items: allResults, sourceStates } = await scrapeMangaUpdatesWithMeta(redis, {
      disabledSources,
      preferredSecondaryTitles: buildPreferredSecondaryTitles(whitelist),
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

    const isMatched = createWhitelistMatcher(whitelist);
    const matched = allResults.filter(isMatched);

    if (!matched.length) {
      const statusPayload = buildShortCircuitStatus({
        reason: "no_new_chapters",
        start,
        guilds: activeGuildCount,
        whitelist: whitelist.length,
        scraped: allResults.length,
        sourceHealth: nextSourceHealth,
      });
      await persistCronStatus(statusPayload);
      await appendCronLog(redis, {
        tag: "info",
        code: "no_new_chapters",
        type: "short_circuit",
        source: "cron",
        message: `Cron found no new chapters across ${allResults.length} scraped item(s).`,
      });
      logApiOk(reqLogger, { status: 200, reason: "no_new_chapters" });
      return res.status(200).json({
        ok: true,
        ...statusPayload,
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
      onChannelError: async (err, channelId) => {
        const status = err?.response?.status;
        if (status !== 403 && status !== 404) return;
        const guildId = channelToGuild.get(channelId);
        if (!guildId) return;
        await deleteGuildChannel(guildId).catch(() => {});
        await redis
          .set(`cache:channel-valid:${channelId}`, false, {
            ex: CHANNEL_VALIDATION_CACHE_SEC,
          })
          .catch(() => {});
      },
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
      outcome: failed > 0 ? "partial" : "ok",
      shortCircuitReason: null,
    };
    await persistCronStatus(statusPayload);

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
    const statusPayload = {
      sent: 0,
      skipped: 0,
      failed: 1,
      duration: null,
      guilds: 0,
      timestamp: new Date().toISOString(),
      sourceHealth: {},
      scrapeMetrics: null,
      outcome: "fatal_error",
      shortCircuitReason: "fatal_error",
      error: err?.message || "Internal error",
    };
    await persistCronStatus(statusPayload).catch(() => {});
    await appendCronLog(redis, buildCronErrorLog(err, {
      code: "cron_fatal",
      type: "runtime_error",
      source: "cron",
    })).catch(() => {});
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: "Internal error" });
  }
}
