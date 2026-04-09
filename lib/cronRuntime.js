import pLimit from "p-limit";
import { getLogger } from "./logger.js";
import { sendDiscordEmbed } from "./discord.js";
import {
  cleanupStaleLastChecks,
  deleteGuildChannel,
  getAllGuildChannels,
  loadSourceHealthSnapshot,
  loadWhitelist,
  readChannelValidationState,
  readCronStatus,
  redis,
  writeChannelValidationState,
  writeCronStatus,
} from "./redis.js";
import { scrapeMangaUpdatesWithMeta } from "./scrapers/orchestrator.js";
import { createWhitelistMatcher, getChapterNumber } from "./domain.js";
import { appendCronLogThrottled } from "./cronLogs.js";
import { dispatchChapters } from "./services/dispatch.js";
import {
  CHANNELS_VALIDATION_KEY,
  CHANNEL_VALIDATION_CACHE_SEC,
  validateDiscordChannel,
} from "./services/channelValidation.js";
import {
  SOURCE_KEYS,
  buildNextSourceHealthMap,
  getDisabledSources,
  loadSourceHealthMap,
  saveSourceHealthMap,
} from "./services/health.js";
import {
  buildPreferredIkiruTitles,
  buildPreferredSecondaryEntries,
  buildPreferredSecondaryTitles,
  buildPreferredSecondaryUrls,
} from "./services/scrapePreferences.js";

export const CHANNEL_VALIDATION_REFRESH_SECONDS = Number(
  process.env.CHANNEL_VALIDATION_REFRESH_SECONDS || 60 * 60 * 6,
);
const CHANNEL_VALIDATION_CONCURRENCY_DEFAULT = 8;
const CHANNEL_VALIDATION_CONCURRENCY_MIN = 1;
const CHANNEL_VALIDATION_CONCURRENCY_MAX = 20;
const SOURCE_FAILURE_THRESHOLD = Number(process.env.SOURCE_FAIL_THRESHOLD || 3);
const SOURCE_COOLDOWN_SECONDS = Number(
  process.env.SOURCE_COOLDOWN_SECONDS || 1800,
);
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DEBUG = process.env.CRON_DEBUG === "true";
const CRON_INFO_LOG_THROTTLE_SEC = Number(
  process.env.CRON_INFO_LOG_THROTTLE_SEC || 1800,
);

export function resolveChannelValidationConcurrency(rawValue) {
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
  return Object.fromEntries(
    entries.filter(([, channelId]) => Boolean(channelId)),
  );
}

export {
  buildPreferredIkiruTitles,
  buildPreferredSecondaryEntries,
  buildPreferredSecondaryTitles,
  buildPreferredSecondaryUrls,
};

export function buildShortCircuitStatus({
  reason,
  start,
  guilds = 0,
  whitelist = 0,
  scraped = 0,
  sourceHealth = {},
  timingMetrics = {},
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
    timingMetrics,
    outcome: "short_circuit",
    shortCircuitReason: reason,
  };
}

function roundTimingMs(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function finalizeTimingMetrics(start, partial = {}) {
  return {
    ...partial,
    totalMs: roundTimingMs(Date.now() - start),
  };
}

async function validateChannel(
  channelId,
  guildId,
  {
    redisClient,
    botToken,
    log,
    warn,
    _deleteGuildChannelFn,
    validateDiscordChannelFn,
  } = {},
) {
  return validateDiscordChannelFn({
    redis: redisClient,
    channelId,
    botToken,
    cacheSec: CHANNEL_VALIDATION_CACHE_SEC,
    writeCache: true,
    onValid: (channel) => {
      log(
        `CONNECTED: #${channel.name} (${channelId.slice(-4)}) in guild ${guildId.slice(-4)}`,
      );
    },
    onInvalid: async (err) => {
      const status = err?.response?.status;
      if (status === 404 || status === 403) {
        // Increment failure counter instead of immediate deletion
        const failKey = `guild:fail_count:${guildId}`;
        const fails = await redisClient.incr(failKey);
        await redisClient.expire(failKey, 86400); // 24h reset

        if (fails >= 3) {
          warn(
            `DISCONNECTED (Persistent): guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status}) - Fail count: ${fails}. NO_AUTO_DELETE enabled.`,
          );
          // System will keep the entry but continue to log warnings until fixed.
        } else {
          warn(
            `DISCONNECTED (Transient?): guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status}) - Fail count: ${fails}/3`,
          );
        }
      } else if (status === 401) {
        warn("Bot token invalid");
      } else {
        warn(`Validate ${guildId.slice(-4)}: ${err.message}`);
      }
    },
  });
}

async function loadValidatedGuilds({
  redisClient,
  guildEntries,
  channelValidationConcurrency,
  botToken,
  log,
  warn,
  deleteGuildChannelFn,
  validateDiscordChannelFn,
}) {
  const lastValidationState = await readChannelValidationState(redisClient);
  const lastValidationAt =
    typeof lastValidationState === "string"
      ? lastValidationState
      : lastValidationState?.at || null;
  const runFullValidation = shouldRunChannelValidation(lastValidationAt);

  if (!runFullValidation) {
    return {
      guilds: buildGuildChannelMap(guildEntries),
      lastValidationAt,
      runFullValidation,
    };
  }

  const validateLimit = pLimit(channelValidationConcurrency);
  const validEntries = await Promise.all(
    guildEntries.map(([guildId, channelId]) =>
      validateLimit(async () => {
        const valid = await validateChannel(channelId, guildId, {
          redisClient,
          botToken,
          log,
          warn,
          deleteGuildChannelFn,
          validateDiscordChannelFn,
        });
        return valid ? [guildId, channelId] : null;
      }),
    ),
  );
  const guilds = Object.fromEntries(validEntries.filter(Boolean));
  await writeChannelValidationState(redisClient, {
    at: new Date().toISOString(),
    total: guildEntries.length,
    valid: Object.keys(guilds).length,
  });

  return {
    guilds,
    lastValidationAt,
    runFullValidation,
  };
}

export async function runCronJob({
  redisClient = redis,
  logger = getLogger({ scope: "cron" }),
  loadWhitelistFn = loadWhitelist,
  getAllGuildChannelsFn = getAllGuildChannels,
  scrapeMangaUpdatesWithMetaFn = scrapeMangaUpdatesWithMeta,
  sendEmbed = sendDiscordEmbed,
  deleteGuildChannelFn = deleteGuildChannel,
  validateDiscordChannelFn = validateDiscordChannel,
} = {}) {
  const channelValidationConcurrencyResolved =
    resolveChannelValidationConcurrency(
      process.env.CHANNEL_VALIDATION_CONCURRENCY,
    );
  const channelValidationConcurrency =
    channelValidationConcurrencyResolved.value;
  const log = (msg, obj = {}) => DEBUG && logger.debug(obj, msg);
  const warn = (msg, obj = {}) => logger.warn(obj, msg);
  const start = Date.now();

  // Panic recovery wrapper
  try {

    const timingMetrics = {
      loadInputsMs: 0,
      channelValidationMs: 0,
      scrapeMs: 0,
      sourceHealthWriteMs: 0,
      matchFilterMs: 0,
      dispatchMs: 0,
    };

    if (channelValidationConcurrencyResolved.reason) {
      warn(
        `CHANNEL_VALIDATION_CONCURRENCY="${channelValidationConcurrencyResolved.raw}" invalid (${channelValidationConcurrencyResolved.reason}), using ${channelValidationConcurrency}`,
      );
    }
    logger.info(
      {
        channelValidationConcurrency,
      },
      "runtime config",
    );
    logger.info("starting");

    const loadInputsStart = Date.now();
    const [whitelist, guildChannels, sourceHealthMap] = await Promise.all([
      loadWhitelistFn(),
      getAllGuildChannelsFn(),
      loadSourceHealthMap(redisClient, SOURCE_KEYS),
    ]);
    timingMetrics.loadInputsMs = roundTimingMs(Date.now() - loadInputsStart);

    const guildEntries = Object.entries(guildChannels || {});
    logger.info(
      { whitelist: whitelist.length, guildsFound: guildEntries.length },
      "loaded",
    );

    if (!whitelist.length) {
      const statusPayload = buildShortCircuitStatus({
        reason: "no_whitelist",
        start,
        guilds: guildEntries.length,
        whitelist: 0,
        sourceHealth: sourceHealthMap,
        timingMetrics: finalizeTimingMetrics(start, timingMetrics),
      });
      await writeCronStatus(redisClient, statusPayload);
      await appendCronLogThrottled(
        redisClient,
        {
          tag: "info",
          code: "no_whitelist",
          type: "short_circuit",
          source: "cron",
          message: "Cron skipped because whitelist is empty.",
        },
        CRON_INFO_LOG_THROTTLE_SEC,
      );
      return {
        statusCode: 200,
        body: {
          ok: true,
          ...statusPayload,
          message: "No whitelist",
        },
        logMeta: { reason: "no_whitelist" },
      };
    }

    const validationStart = Date.now();
    const validation = await loadValidatedGuilds({
      redisClient,
      guildEntries,
      channelValidationConcurrency,
      botToken: DISCORD_TOKEN,
      log,
      warn,
      deleteGuildChannelFn,
      validateDiscordChannelFn,
    });
    timingMetrics.channelValidationMs = roundTimingMs(
      Date.now() - validationStart,
    );
    const validGuilds = validation.guilds;

    if (!validation.runFullValidation) {
      logger.info(
        {
          lastValidationAt: validation.lastValidationAt,
          refreshSeconds: CHANNEL_VALIDATION_REFRESH_SECONDS,
        },
        "guild validation skipped (cached mode)",
      );
    }

    const disabledSources = getDisabledSources(sourceHealthMap, SOURCE_KEYS);
    const activeGuildCount = Object.keys(validGuilds).length;
    const activeChannelIds = Object.values(validGuilds);
    const channelToGuild = new Map(
      Object.entries(validGuilds).map(([guildId, channelId]) => [
        channelId,
        guildId,
      ]),
    );

    logger.info(
      { guildsFound: guildEntries.length, guildsActive: activeGuildCount },
      "guild validation",
    );

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
        timingMetrics: finalizeTimingMetrics(start, timingMetrics),
      });
      await writeCronStatus(redisClient, statusPayload);
      await appendCronLogThrottled(
        redisClient,
        {
          tag: "info",
          code: "no_active_guilds",
          type: "short_circuit",
          source: "cron",
          message: "Cron skipped because no active guilds were available.",
        },
        CRON_INFO_LOG_THROTTLE_SEC,
      );
      return {
        statusCode: 200,
        body: {
          ok: true,
          ...statusPayload,
          message: "No active guilds",
        },
        logMeta: { reason: "no_active_guilds" },
      };
    }

    const scrapeStart = Date.now();
    const { items: allResults, sourceStates } =
    await scrapeMangaUpdatesWithMetaFn(redisClient, {
      disabledSources,
      preferredIkiruTitles: buildPreferredIkiruTitles(whitelist),
      preferredSecondaryEntries: buildPreferredSecondaryEntries(whitelist),
      preferredSecondaryTitles: buildPreferredSecondaryTitles(whitelist),
      preferredSecondaryUrls: buildPreferredSecondaryUrls(whitelist),
      skipExpansion: true,
      incremental: true,
      deduplicate: true,
    });
    timingMetrics.scrapeMs = roundTimingMs(Date.now() - scrapeStart);

    const nowIso = new Date().toISOString();
    const nextSourceHealth = buildNextSourceHealthMap({
      sourceKeys: SOURCE_KEYS,
      currentMap: sourceHealthMap,
      sourceStates,
      nowIso,
      failureThreshold: SOURCE_FAILURE_THRESHOLD,
      cooldownSeconds: SOURCE_COOLDOWN_SECONDS,
    });
    const sourceHealthWriteStart = Date.now();
    await saveSourceHealthMap(
      redisClient,
      nextSourceHealth,
      SOURCE_KEYS,
      sourceHealthMap,
    );
    timingMetrics.sourceHealthWriteMs = roundTimingMs(
      Date.now() - sourceHealthWriteStart,
    );

    const matchFilterStart = Date.now();
    const isMatched = createWhitelistMatcher(whitelist);
    let matched = allResults.filter(isMatched);
    timingMetrics.matchFilterMs = roundTimingMs(Date.now() - matchFilterStart);

    if (!matched.length) {
      const statusPayload = buildShortCircuitStatus({
        reason: "no_new_chapters",
        start,
        guilds: activeGuildCount,
        whitelist: whitelist.length,
        scraped: allResults.length,
        sourceHealth: nextSourceHealth,
        timingMetrics: finalizeTimingMetrics(start, timingMetrics),
      });
      await writeCronStatus(redisClient, statusPayload);
      await appendCronLogThrottled(
        redisClient,
        {
          tag: "info",
          code: "no_new_chapters",
          type: "short_circuit",
          source: "cron",
          message: `Cron found no new chapters across ${allResults.length} scraped item(s).`,
        },
        CRON_INFO_LOG_THROTTLE_SEC,
      );
      return {
        statusCode: 200,
        body: {
          ok: true,
          ...statusPayload,
          message: "No new chapters",
        },
        logMeta: { reason: "no_new_chapters" },
      };
    }

    // Optimized sorting: pre-compute chapter numbers to avoid O(n log n) function calls
    const matchedWithChapterNum = matched.map((item) => ({
      ...item,
      _chapterNum: getChapterNumber(item.chapter),
    }));

    matchedWithChapterNum.sort((a, b) => a._chapterNum - b._chapterNum);

    // Remove temporary field after sorting
    matched = matchedWithChapterNum.map(({ _chapterNum, ...item }) => item);

    log(`Matched ${matched.length} chapters`);

    const dispatchStart = Date.now();
    const { sent, skipped, failed, skipBreakdown } = await dispatchChapters({
      redis: redisClient,
      matched,
      channelIds: activeChannelIds,
      sendEmbed,
      nowIso,
      log,
      warn,
      onChannelError: async (err, channelId) => {
        const status = err?.response?.status;
        if (status !== 403 && status !== 404) return;
        const guildId = channelToGuild.get(channelId);
        if (!guildId) return;
        warn(
          `DISCONNECTED (Dispatch): guild ${guildId.slice(-4)} ch ${channelId.slice(-4)} (${status}) - skipping delete.`,
        );
        // Mark channel as invalid in cache (retry delete on next run)
        await redisClient
          .hset(CHANNELS_VALIDATION_KEY, {
            [channelId]: JSON.stringify({
              valid: false,
              expiresAt: Date.now() + CHANNEL_VALIDATION_CACHE_SEC * 1000,
            }),
          })
          .catch((err) => {
            warn(`Failed to cache invalid channel: ${err.message}`);
          });
      },
    });
    timingMetrics.dispatchMs = roundTimingMs(Date.now() - dispatchStart);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const scrapeMetrics = Object.fromEntries(
      SOURCE_KEYS.map((source) => [
        source,
        sourceStates?.[source]?.metrics ?? null,
      ]),
    );
    const finalTimingMetrics = finalizeTimingMetrics(start, timingMetrics);
    const statusPayload = {
      sent,
      skipped,
      failed,
      skipBreakdown: skipBreakdown || null,
      duration,
      guilds: activeGuildCount,
      timestamp: new Date().toISOString(),
      sourceHealth: nextSourceHealth,
      scrapeMetrics,
      timingMetrics: finalTimingMetrics,
      outcome: failed > 0 ? "partial" : "ok",
      shortCircuitReason: null,
    };
    // Parallel write operations where possible
    await Promise.all([
      writeCronStatus(redisClient, statusPayload),
      // Cleanup stale lastCheck entries (fire-and-forget, don't block)
      cleanupStaleLastChecks().catch((err) =>
        logger.warn({ err: err.message }, "Failed to cleanup stale lastChecks"),
      ),
    ]);

    logger.info(
      {
        duration,
        sent,
        skipped,
        failed,
        guilds: activeGuildCount,
        timingMetrics: finalTimingMetrics,
      },
      "done",
    );

    return {
      statusCode: 200,
      body: {
        ok: true,
        sent,
        skipped,
        failed,
        skipBreakdown: skipBreakdown || null,
        guilds: activeGuildCount,
        duration,
        sourceHealth: nextSourceHealth,
        scrapeMetrics,
        timingMetrics: finalTimingMetrics,
      },
      logMeta: { sent, skipped, failed, guilds: activeGuildCount },
    };
  } catch (panicErr) {
    // Panic recovery: catch any unhandled error and log it
    logger.fatal({
      err: panicErr.message,
      stack: panicErr.stack,
      duration: ((Date.now() - start) / 1000).toFixed(1),
    }, "Cron job panic - unhandled exception");

    // Write error status to Redis
    const errorStatus = {
      sent: 0,
      skipped: 0,
      failed: 0,
      duration: ((Date.now() - start) / 1000).toFixed(1),
      guilds: 0,
      timestamp: new Date().toISOString(),
      outcome: "panic_error",
      error: panicErr.message,
      shortCircuitReason: "unhandled_exception",
    };

    try {
      await writeCronStatus(redisClient, errorStatus);
    } catch (writeErr) {
      logger.error({ err: writeErr.message }, "Failed to write panic status");
    }

    // Return error response
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: panicErr.message,
        ...errorStatus,
      },
      logMeta: { panic: true, error: panicErr.message },
    };
  }
}

export async function readCronStatusWithHealth(redisClient = redis) {
  const data = await readCronStatus(redisClient);
  if (!data) return null;
  const fallbackHealth = await loadSourceHealthSnapshot(
    redisClient,
    SOURCE_KEYS,
  );
  const recommendations =
    (await redisClient.get("health:recommendations")) || [];
  const lastHealthCheck = await redisClient.get("health:last-check");

  const base = {
    ...data,
    recommendations,
    lastHealthCheck,
  };

  if (data.sourceHealth && typeof data.sourceHealth === "object") {
    const mergedHealth = { ...fallbackHealth };
    for (const [source, value] of Object.entries(data.sourceHealth)) {
      mergedHealth[source] = value;
    }
    return {
      ...base,
      sourceHealth: mergedHealth,
    };
  }

  return {
    ...base,
    sourceHealth: fallbackHealth,
  };
}
