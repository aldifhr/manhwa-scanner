/**
 * Cron job orchestration module
 * 
 * NOTE: This file is now a thin orchestration layer.
 * Individual phases are in ./cron/ submodules:
 *   - lock.ts - Locking mechanism
 *   - inputs.ts - Input loading
 *   - validation.ts - Channel validation
 *   - scrape.ts - Scraping phase
 *   - qstash-dispatch.ts - Dispatch phase
 *   - short-circuit.ts - Early exit handling
 *   - status-builder.ts - Status building
 *   - cleanup.ts - Cleanup tasks
 */

import { getLogger } from "./logger.js";
import { sendDiscordEmbed } from "./discord.js";
import {
  deleteGuildChannel,
  getAllGuildChannels,
  loadWhitelist,
  appendLiveEvent,
} from "./services/storage.js";
import { isSourceInCooldown } from "./services/health.js";
import { redis } from "./redis.js";
import { env } from "./config/env.js";
import { scrapeMangaUpdatesWithMeta } from "./scrapers/orchestrator.js";
import { syncDynamicOverrides } from "./domain.js";
import {
  resolvePositiveInt,
} from "./config.js";
import {
  CronStatus,
  TimingMetrics,
  LifecycleState,
  RedisClient,
} from "./types.js";
import {
  shouldRunChannelValidation,
  buildShortCircuitStatus,
  finalizeTimingMetrics,
} from "./cron/helpers.js";
import { loadValidatedGuilds } from "./cron/validation.js";
import { readCronStatusWithHealth } from "./cron/status.js";
import { runScrapePhase } from "./cron/scrape.js";
import { runDispatch } from "./cron/qstash-dispatch.js";
import { acquireCronLock, runCleanupTasks } from "./cron/index.js";
import { loadCronInputs, validateCronInputs } from "./cron/inputs.js";
import { handleShortCircuit } from "./cron/short-circuit.js";
import { writeSuccessStatus, writeErrorStatus } from "./cron/status-builder.js";

export {
  shouldRunChannelValidation,
  buildShortCircuitStatus,
  finalizeTimingMetrics,
  readCronStatusWithHealth,
};

export const CHANNEL_VALIDATION_REFRESH_SECONDS = env.CHANNEL_VALIDATION_REFRESH_SECONDS;
const CHANNEL_VALIDATION_CONCURRENCY_DEFAULT = env.CHANNEL_VALIDATION_CONCURRENCY;
const DISCORD_TOKEN = env.DISCORD_BOT_TOKEN;
const DEBUG = env.CRON_DEBUG;
const CRON_INFO_LOG_THROTTLE_SEC = env.CRON_INFO_LOG_THROTTLE_SEC;
const CRON_INCREMENTAL_DEFAULT = env.CRON_INCREMENTAL;
const CRON_DEDUPLICATE_DEFAULT = env.CRON_DEDUPLICATE;
const CRON_FAST_SECONDARY_LIMIT = Math.max(0, env.CRON_FAST_SECONDARY_LIMIT);
const SOURCE_FAILURE_THRESHOLD = env.SOURCE_FAIL_THRESHOLD;
const SOURCE_COOLDOWN_SECONDS = env.SOURCE_COOLDOWN_SECONDS;

export async function runCronJob({
  redisClient = redis,
  logger: cronLogger = getLogger({ scope: "cron" }),
  loadWhitelistFn = loadWhitelist,
  getAllGuildChannelsFn = getAllGuildChannels,
  scrapeMangaUpdatesWithMetaFn = scrapeMangaUpdatesWithMeta,
  sendEmbed,
  deleteGuildChannelFn = deleteGuildChannel,
  scrapeOptions = {},
  lifecycle = { currentStep: "initializing" },
  deadlineMs = 0,
}: import("./types.js").RunCronJobOptions = {}) {
  const sendEmbedFn = sendEmbed ?? sendDiscordEmbed;
  const channelValidationConcurrency = resolvePositiveInt(
    env.CHANNEL_VALIDATION_CONCURRENCY,
    CHANNEL_VALIDATION_CONCURRENCY_DEFAULT
  );
  const log = (msg: string, obj = {}) => DEBUG && cronLogger.debug(obj, msg);
  const warn = (msg: string, obj = {}) => cronLogger.warn(obj, msg);
  const start = Date.now();

  let lockRelease: (() => Promise<void>) | null = null;

  try {
    const timingMetrics: TimingMetrics = {
      loadInputsMs: 0,
      channelValidationMs: 0,
      scrapeMs: 0,
      sourceHealthWriteMs: 0,
      matchFilterMs: 0,
      dispatchMs: 0,
    };

    cronLogger.info({ channelValidationConcurrency }, "runtime config");

    // 0. Sync dynamic config (e.g. healed domains)
    await syncDynamicOverrides();

    // 1. Acquire lock
    const lockResult = await acquireCronLock(redisClient, { skipIfLocked: true });
    if (!lockResult.acquired) {
      return {
        statusCode: 200,
        body: { ok: true, skipped: true, reason: "already_running" },
        logMeta: { skipped: true, reason: "already_running" }
      };
    }
    lockRelease = lockResult.release;

    // 2. Load inputs
    lifecycle.currentStep = "loading_inputs";
    const loadInputsStart = Date.now();
    const inputs = await loadCronInputs({
      redis: redisClient,
      loadWhitelistFn,
      getAllGuildChannelsFn,
    });
    timingMetrics.loadInputsMs = Date.now() - loadInputsStart;

    // 3. Validate inputs (short-circuit if invalid)
    const validation = validateCronInputs(inputs);
    if (!validation.valid) {
      return await handleShortCircuit({
        redis: redisClient,
        start,
        reason: validation.reason!,
        whitelist: inputs.whitelist.length,
        guilds: Object.keys(inputs.guildChannels).length,
        sourceHealth: inputs.sourceHealthMap,
        timingMetrics,
        details: validation.details,
        logThrottleSec: CRON_INFO_LOG_THROTTLE_SEC,
      });
    }

    const { whitelist, guildChannels, sourceHealthMap } = inputs;
    const guildEntries = Object.entries(guildChannels) as [string, string][];

    lifecycle.currentStep = "validating_channels";
    cronLogger.info(
      { whitelist: whitelist.length, guildsFound: guildEntries.length },
      "loaded",
    );

    // 4. Validate guild channels
    const validationStart = Date.now();
    const guildValidation = await loadValidatedGuilds({
      redisClient,
      guildEntries,
      channelValidationConcurrency,
      botToken: DISCORD_TOKEN!,
      log,
      warn,
    });
    timingMetrics.channelValidationMs = Date.now() - validationStart;

    const validGuilds = guildValidation.guilds;
    const activeGuildCount = Object.keys(validGuilds).length;
    const activeChannelIds = [...new Set(Object.values(validGuilds))];
    const channelToGuild = new Map<string, string>(
      Object.entries(validGuilds).map(([guildId, channelId]) => [
        channelId,
        guildId,
      ]),
    );

    cronLogger.info(
      { guildsFound: guildEntries.length, guildsActive: activeGuildCount },
      "guild validation",
    );

    // Short-circuit if no active guilds
    if (!activeGuildCount) {
      return await handleShortCircuit({
        redis: redisClient,
        start,
        reason: "no_active_guilds",
        whitelist: whitelist.length,
        guilds: 0,
        sourceHealth: sourceHealthMap,
        timingMetrics,
        logThrottleSec: CRON_INFO_LOG_THROTTLE_SEC,
      });
    }

    // 5. Scrape phase
    const scrapeResult = await runScrapePhase({
      redisClient,
      whitelist,
      activeGuildCount,
      disabledSources: Object.entries(sourceHealthMap)
        .filter(([_, h]) => h.status === "degraded" && isSourceInCooldown(h))
        .map(([k]) => k),
      currentHealthMap: sourceHealthMap,
      scrapeOptions,
      timingMetrics,
      lifecycle,
      start,
      deadlineMs,
      cronLogger,
      warn,
      scrapeMangaUpdatesWithMetaFn,
      CRON_INCREMENTAL_DEFAULT,
      CRON_DEDUPLICATE_DEFAULT,
      CRON_FAST_SECONDARY_LIMIT,
      SOURCE_FAILURE_THRESHOLD,
      SOURCE_COOLDOWN_SECONDS,
      CRON_INFO_LOG_THROTTLE_SEC,
    });

    if (scrapeResult.shortCircuit) return scrapeResult.shortCircuit;

    const { matched, nowIso, nextSourceHealth, scrapeMetrics, orchestratorMetrics } = scrapeResult;

    // 6. Dispatch phase
    const dispatchStart = Date.now();
    lifecycle.currentStep = "dispatching_notifications";

    const { sent, skipped, failed, enqueued, skipBreakdown } = await runDispatch({
      redisClient,
      matched,
      activeChannelIds,
      channelToGuild,
      nowIso,
      start,
      deadlineMs,
      sendEmbedFn,
      deleteGuildChannelFn,
      appendLiveEvent,
      log,
      warn,
      cronLogger,
    });

    timingMetrics.dispatchMs = Date.now() - dispatchStart;

    // 7. Write success status
    await writeSuccessStatus({
      redis: redisClient,
      start,
      sent,
      skipped,
      failed,
      enqueued,
      guilds: activeGuildCount,
      whitelist: whitelist.length,
      hibernated: orchestratorMetrics?.hibernatedCount || 0,
      incrementalSaved: orchestratorMetrics?.incrementalSaved || 0,
      sourceHealth: nextSourceHealth,
      scrapeMetrics,
      timingMetrics,
      skipBreakdown,
    });

    // 8. Cleanup (fire-and-forget)
    runCleanupTasks(redisClient);

    // 9. Source Health Check (Alert if stale)
    const { checkSourceHealth } = await import("./services/health-monitor.js");
    const { SOURCE_KEYS } = await import("./constants/redis.js");
    await checkSourceHealth(redisClient, SOURCE_KEYS);

    return {
      statusCode: 200,
      body: {
        ok: true,
        sent,
        skipped,
        failed,
        skipBreakdown: skipBreakdown || null,
        guilds: activeGuildCount,
        duration: ((Date.now() - start) / 1000).toFixed(1),
        hibernated: orchestratorMetrics?.hibernatedCount || 0,
        incrementalSaved: orchestratorMetrics?.incrementalSaved || 0,
        sourceHealth: nextSourceHealth,
        scrapeMetrics,
        timingMetrics: finalizeTimingMetrics(start, timingMetrics),
      },
      logMeta: { sent, skipped, failed, guilds: activeGuildCount },
    };

  } catch (panicErr: unknown) {
    const err = panicErr instanceof Error ? panicErr : new Error(String(panicErr));
    const lifecycleAny = lifecycle as LifecycleState;
    const step = lifecycleAny?.currentStep;

    cronLogger.fatal({
      err: err.message,
      stack: err.stack,
      step,
      duration: ((Date.now() - start) / 1000).toFixed(1),
    }, "Cron job panic - unhandled exception");


    await writeErrorStatus({
      redis: redisClient,
      start,
      error: err.message,
      step,
    });

    return {
      statusCode: 500,
      body: {
        ok: false,
        error: step ? `${err.message} during ${step}` : err.message,
      },
      logMeta: { panic: true, error: err.message, step },
    };

  } finally {
    // Release lock
    if (lockRelease) {
      await lockRelease();
    }
  }
}
