import { createWhitelistMatcher, getChapterNumber, normalizeTitleKey as _normalizeTitleKey } from "../domain.js";
import { appendCronLogThrottled } from "../cronLogs.js";
import { writeCronStatus } from "../services/storage.js";
import { buildShortCircuitStatus, finalizeTimingMetrics, limitObjectArrays, roundTimingMs } from "./helpers.js";
import {
  buildPreferredIkiruPreferences,
  buildPreferredSecondaryEntries,
  buildPreferredSecondaryTitles,
  buildPreferredSecondaryUrls,
} from "../services/scrapePreferences.js";
import { SOURCE_KEYS } from "../constants/redis.js";
import type { ChapterItem, RedisClient, TimingMetrics, LifecycleState } from "../types.js";
import type { Logger } from "pino";

export interface ScrapePhaseOptions {
  redisClient: RedisClient;
  whitelist: any[];
  activeGuildCount: number;
  disabledSources: Set<string> | string[];
  scrapeOptions: Record<string, any>;
  currentHealthMap: Record<string, any>;
  timingMetrics: TimingMetrics;
  lifecycle: LifecycleState;
  start: number;
  deadlineMs: number;
  cronLogger: Logger;
  warn: (msg: string, obj?: Record<string, unknown>) => void;
  scrapeMangaUpdatesWithMetaFn: (redis: RedisClient, opts: any) => Promise<any>;
  CRON_INCREMENTAL_DEFAULT: boolean;
  CRON_DEDUPLICATE_DEFAULT: boolean;
  CRON_FAST_SECONDARY_LIMIT: number;
  SOURCE_FAILURE_THRESHOLD: number;
  SOURCE_COOLDOWN_SECONDS: number;
  CRON_INFO_LOG_THROTTLE_SEC: number;
}

export interface ScrapePhaseResult {
  shortCircuit: { statusCode: number; body: any; logMeta: any } | null;
  matched: ChapterItem[];
  allResults: any[];
  nowIso: string;
  nextSourceHealth: any;
  scrapeMetrics: Record<string, any>;
  orchestratorMetrics: any;
}

export async function runScrapePhase(opts: ScrapePhaseOptions): Promise<ScrapePhaseResult> {
  const {
    redisClient, whitelist, activeGuildCount, disabledSources,
    scrapeOptions, currentHealthMap, timingMetrics, lifecycle, start, deadlineMs,
    cronLogger, warn, scrapeMangaUpdatesWithMetaFn,
    CRON_INCREMENTAL_DEFAULT, CRON_DEDUPLICATE_DEFAULT, CRON_FAST_SECONDARY_LIMIT,
    SOURCE_FAILURE_THRESHOLD, SOURCE_COOLDOWN_SECONDS, CRON_INFO_LOG_THROTTLE_SEC,
  } = opts;

  const scrapeStart = Date.now();
  lifecycle.currentStep = "scraping_updates";

  const preferredIkiruTitles = buildPreferredIkiruPreferences(whitelist).titles;
  const preferredSecondaryEntries = buildPreferredSecondaryEntries(whitelist) as unknown as Record<string, any[]>;
  const preferredSecondaryTitles = buildPreferredSecondaryTitles(whitelist) as unknown as Record<string, any[]>;
  const preferredSecondaryUrls = buildPreferredSecondaryUrls(whitelist) as unknown as Record<string, any[]>;

  const { items: allResults, sourceStates, nextSourceHealth: scrapeNextHealth, metrics: orchestratorMetrics } =
    await scrapeMangaUpdatesWithMetaFn(redisClient, {
      disabledSources: Array.from(disabledSources),
      preferredIkiruTitles,
      preferredSecondaryEntries,
      preferredSecondaryTitles,
      preferredSecondaryUrls,
      skipExpansion: scrapeOptions.skipExpansion ?? false,
      incremental: scrapeOptions.incremental ?? CRON_INCREMENTAL_DEFAULT,
      deduplicate: scrapeOptions.deduplicate ?? CRON_DEDUPLICATE_DEFAULT,
      force: scrapeOptions.force ?? false,
      fullRefresh: scrapeOptions.fullRefresh ?? false,
      lifecycle,
      startTime: start,
      deadlineMs,
      currentHealthMap,
      healthFailureThreshold: SOURCE_FAILURE_THRESHOLD,
      healthCooldownSeconds: SOURCE_COOLDOWN_SECONDS,
    });

  timingMetrics.scrapeMs = roundTimingMs(Date.now() - scrapeStart);

  const nowIso = new Date().toISOString();
  const nextSourceHealth = scrapeNextHealth ?? currentHealthMap;

  const matchFilterStart = Date.now();
    const matchEntry = createWhitelistMatcher(whitelist);
    let matched: ChapterItem[] = (allResults as ChapterItem[]).map((item: ChapterItem) => {
      const entry = matchEntry(item);
      
      if (entry) {
        const itemKey = _normalizeTitleKey(item.title);
        cronLogger.info({ source: item.source, title: item.title, key: itemKey, matched: entry.title, chapter: item.chapter, url: item.url }, "Match Found");
      }

    if (!entry) return null;
    return { ...item, canonicalTitle: entry.title };
  }).filter((item): item is ChapterItem & { canonicalTitle: string } => item !== null && typeof item.canonicalTitle === "string");
  timingMetrics.matchFilterMs = roundTimingMs(Date.now() - matchFilterStart);

  const scrapeMetrics = Object.fromEntries(
    SOURCE_KEYS.map((source: string) => [
      source,
      sourceStates?.[source]?.metrics ?? null,
    ]),
  );

  // Record activity for each source that successfully scraped
  const { recordSourceActivity } = await import("../services/health-monitor.js");
  for (const source of SOURCE_KEYS) {
    const state = sourceStates?.[source];
    if (state && (state.status !== "error" || !state.error)) {
      await recordSourceActivity(redisClient, source);
    }
  }

  if (!matched.length) {
    const statusPayload = buildShortCircuitStatus({
      reason: "no_new_chapters",
      start,
      guilds: activeGuildCount,
      whitelist: whitelist.length,
      scraped: allResults.length,
      hibernated: orchestratorMetrics?.hibernatedCount || 0,
      incrementalSaved: orchestratorMetrics?.incrementalSaved || 0,
      scrapeMetrics,
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
      shortCircuit: {
        statusCode: 200,
        body: { ok: true, ...statusPayload, message: "No new chapters" },
        logMeta: { reason: "no_new_chapters" },
      },
      matched: [],
      allResults,
      nowIso,
      nextSourceHealth,
      scrapeMetrics,
      orchestratorMetrics,
    };
  }

  const matchedWithChapterNum = matched.map((item) => ({
    ...item,
    _chapterNum: getChapterNumber(item.chapter) || 0,
  }));

  matchedWithChapterNum.sort((a, b) => {
    // 1. Primary sort: Group by manga title to keep series together
    if (a.canonicalTitle !== b.canonicalTitle) {
      return (a.canonicalTitle || "").localeCompare(b.canonicalTitle || "");
    }
    // 2. Secondary sort: Chapter number ascending
    return a._chapterNum - b._chapterNum;
  });

  matched = matchedWithChapterNum.map(({ _chapterNum: _, ...item }) => item);

  if (deadlineMs > 0 && (deadlineMs - (Date.now() - start)) < 2500) {
    warn(`Critically low time remaining, skipping dispatch to avoid timeout.`);
    const statusPayload = buildShortCircuitStatus({
      reason: "timeout_approaching_pre_dispatch",
      start,
      guilds: activeGuildCount,
      whitelist: whitelist.length,
      scraped: allResults.length,
      hibernated: orchestratorMetrics?.hibernatedCount || 0,
      incrementalSaved: orchestratorMetrics?.incrementalSaved || 0,
      scrapeMetrics,
      sourceHealth: nextSourceHealth,
      timingMetrics: finalizeTimingMetrics(start, timingMetrics),
    });
    await writeCronStatus(redisClient, statusPayload);
    return {
      shortCircuit: {
        statusCode: 200,
        body: { ok: true, ...statusPayload, message: "Timeout approaching, dispatch skipped" },
        logMeta: { reason: "timeout_pre_dispatch" },
      },
      matched,
      allResults,
      nowIso,
      nextSourceHealth,
      scrapeMetrics,
      orchestratorMetrics,
    };
  }

  return { shortCircuit: null, matched, allResults, nowIso, nextSourceHealth, scrapeMetrics, orchestratorMetrics };
}
