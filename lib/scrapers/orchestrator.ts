import {
  redis,
} from "../redis.js";
import {
  MANGA_LAST_UPDATES_KEY,
  SOURCE_KEYS,
  LIVE_EVENTS_KEY,
} from "../constants/redis.js";
import {
  batchGetLastScrapeChecks,
  batchSetLastScrapeChecks,
  batchGetMangaMetadata,
  setMangaMetadata,
  appendLiveEvent,
} from "../services/storage.js";
import pLimit from "p-limit";
import { fileURLToPath } from "url";
import {
  CronLogEntry,
  RedisClient,
  ClaimState,
  MangaMetadata,
  SourceState,
  ScraperMetrics,
  ChapterItem,
  LifecycleState,
  SourceHealth,
  OrchestrateOptions,
  Logger,
} from "../types.js";
import { isWithinLastHours, safeParseDate } from "../dateUtils.js";
import { normalizeSource, normalizeSourceUrl, normalizeTitleKey } from "./shared.js";
import { withTimeout } from "../utils.js";
import { mangaProviderRegistry } from "../providers/registry.js";
import { getChapterNumber } from "../domain.js";
import {
  buildNextSourceHealthMap,
  getDisabledSources,
  loadSourceHealthMap,
  saveSourceHealthMap,
} from "../services/health.js";
import { getLogger } from "../logger.js";
import {
  getHibernatingTitleKeys,
  applyIncrementalFilter,
  buildPreferredSecondaryMatcher,
  hasPreferredSecondaryMatcher,
  filterWhitelistedChapters,
  filterRecentChapters,
  sortChapters,
  PreferredSecondaryMatcher,
} from "./orchestrator-helpers.js";
import {
  enrichChaptersMetadata,
  applyMetadataToChapters,
} from "../services/metadata-enrichment.js";
import { autoHealIfNeeded } from "../services/domainHealing.js";

const defaultLogger = getLogger({ scope: "scraper" });

// Re-export for backward compatibility
export type { PreferredSecondaryMatcher } from "./orchestrator-helpers.js";



type OrchestrateLogger = Pick<Logger, 'info' | 'error' | 'warn' | 'debug'>;

function buildDefaultSecondaryMetrics(): ScraperMetrics {
  return {
    detailAttempts: 0,
    detailSuccesses: 0,
    detailFallbacks: 0,
    detail429: 0,
    detailSkippedNonPriority: 0,
  };
}

export interface OrchestrateScrapeSourcesParams {
  redis?: RedisClient | null;
  options?: OrchestrateOptions;
  logger?: OrchestrateLogger;
  providers?: import("../providers/base.js").MangaProvider[];
}

export async function orchestrateScrapeSources({
  redis = null,
  options = {},
  logger = defaultLogger,
  providers = mangaProviderRegistry.getAllProviders(),
}: OrchestrateScrapeSourcesParams = {}) {
  const { lifecycle, startTime = Date.now(), deadlineMs = 0 } = options;
  const deadline = deadlineMs > 0 ? startTime + deadlineMs : 0;
  const SCRAPE_SAFETY_MARGIN_MS = 5000; // Reduced from 8s to 5s to allow more scrape time for secondary sources

  const sourceStates: Record<string, SourceState> = {};
  providers.forEach(p => {
    sourceStates[p.id] = { status: "pending", count: 0, error: null, metrics: null, errCode: null };
  });
  const scrapedChapters: ChapterItem[] = [];

  let currentHealthMap: Record<string, SourceHealth> = options?.currentHealthMap ?? {};
  if (!options?.currentHealthMap && redis) {
    currentHealthMap = await loadSourceHealthMap(redis, SOURCE_KEYS);
  }

  try {
    const cooldownSources = getDisabledSources(currentHealthMap, SOURCE_KEYS);
    const optionsDisabled = Array.isArray(options?.disabledSources)
      ? options.disabledSources.map((source) => normalizeSource(source)!)
      : [];

    const disabledSources = new Set([...cooldownSources, ...optionsDisabled]);
    if (disabledSources.size > 0) {
      logger.info(
        { disabled: Array.from(disabledSources) },
        "skipping disabled or cooling down sources",
      );
      for (const src of disabledSources) {
        if (sourceStates[src]) {
          sourceStates[src].status = "circuit_break";
          sourceStates[src].error = "Source in cooldown or manually disabled";
        }
      }
    }

    const ikiruTitles = Array.isArray(options?.preferredIkiru?.titles)
      ? options.preferredIkiru.titles
      : (Array.isArray(options?.preferredIkiruTitles) ? options.preferredIkiruTitles : []);

    const ikiruUrls = Array.isArray(options?.preferredIkiru?.urls) ? options.preferredIkiru.urls : [];

    let preferredIkiruTitleKeys = new Set(
      ikiruTitles
        .map((title) => normalizeTitleKey(title))
        .filter((tk): tk is string => !!tk),
    );

    const preferredIkiruUrlKeys = new Set(
      ikiruUrls
        .map((url) => normalizeSourceUrl(url))
        .filter((uk): uk is string => !!uk),
    );

    // Keep full copies for final filtering
    const fullWhitelistIkiruTitleKeys = new Set(preferredIkiruTitleKeys);
    const fullWhitelistIkiruUrlKeys = new Set(preferredIkiruUrlKeys);

    const preferredSecondaryMatchersBySource: Record<string, PreferredSecondaryMatcher> = {
      shinigami: buildPreferredSecondaryMatcher(
        options?.preferredSecondaryTitles?.shinigami,
        options?.preferredSecondaryUrls?.shinigami,
        options?.preferredSecondaryEntries?.shinigami,
      ),
    };
    const secondarySources = Object.keys(preferredSecondaryMatchersBySource);

    // Keep full copies for final filtering
    const fullWhitelistSecondaryTitleKeys = new Set(
      secondarySources.flatMap(src => Array.from(preferredSecondaryMatchersBySource[src].titleKeys))
    );
    const fullWhitelistSecondaryUrlKeys = new Set(
      secondarySources.flatMap(src => Array.from(preferredSecondaryMatchersBySource[src].urlKeys))
    );

    const useIncremental = options?.incremental !== false && options?.force !== true;
    const allTitleKeys = Array.from(
      new Set([
        ...preferredIkiruTitleKeys,
        ...preferredSecondaryMatchersBySource.shinigami.titleKeys,
      ]),
    );

    const initialTitleCount = allTitleKeys.length;
    let hibernatedCount = 0;
    let incrementalSavedCount = 0;

    const allUrlKeys = Array.from(
      new Set([
        ...preferredIkiruUrlKeys,
        ...preferredSecondaryMatchersBySource.shinigami.urlKeys,
      ]),
    );

    const [skipTitleKeys, ikiruIncrementalFiltered, secondaryIncrementalFiltered] = await Promise.all([
      getHibernatingTitleKeys(redis, allTitleKeys, options),
      useIncremental && preferredIkiruTitleKeys.size > 0
        ? applyIncrementalFilter(preferredIkiruTitleKeys, redis, batchGetLastScrapeChecks)
        : null as unknown as Promise<Set<string>>,
      Promise.all(
        secondarySources.map(async (source) => {
          const matcher = preferredSecondaryMatchersBySource[source];
          const results: {
            source: string;
            titleKeys: Set<string> | null;
            urlKeys: Set<string> | null;
            originalCount: number;
          } = { source, titleKeys: null, urlKeys: null, originalCount: matcher.titleKeys.size };
          if (useIncremental) {
            [results.titleKeys, results.urlKeys] = await Promise.all([
              matcher.titleKeys.size > 0 ? applyIncrementalFilter(matcher.titleKeys, redis, batchGetLastScrapeChecks) : null,
              matcher.urlKeys.size > 0 ? applyIncrementalFilter(matcher.urlKeys, redis, batchGetLastScrapeChecks) : null,
            ]);
          }
          return results;
        }),
      ),
    ]);

    hibernatedCount = skipTitleKeys.size;

    if (ikiruIncrementalFiltered) {
      incrementalSavedCount += (preferredIkiruTitleKeys.size - ikiruIncrementalFiltered.size);
      preferredIkiruTitleKeys = ikiruIncrementalFiltered;
    }

    for (const filterRes of secondaryIncrementalFiltered) {
      const matcher = preferredSecondaryMatchersBySource[filterRes.source];
      if (!matcher) continue;

      if (filterRes.titleKeys && filterRes.titleKeys instanceof Set) {
        incrementalSavedCount += (filterRes.originalCount - filterRes.titleKeys.size);
        matcher.titleKeys = filterRes.titleKeys;
      }
      if (filterRes.urlKeys && filterRes.urlKeys instanceof Set) {
        matcher.urlKeys = filterRes.urlKeys;
      }
    }

    // Apply hibernation skip ONCE to all final sets
    if (skipTitleKeys.size > 0) {
      for (const tk of skipTitleKeys) {
        preferredIkiruTitleKeys.delete(tk);
        for (const source of secondarySources) {
          preferredSecondaryMatchersBySource[source].titleKeys.delete(tk);
        }
      }
    }

    const buildDedupeKey = (prefix: string, titleKeys: Set<string>, urlKeys = new Set<string>()) => {
      const sortedTitles = Array.from(titleKeys).sort().join(",");
      const sortedUrls = Array.from(urlKeys).sort().join(",");
      const sorted = `${sortedTitles}||${sortedUrls}`;
      const len = sorted.length;
      const first = sorted.slice(0, 50);
      const last = len > 50 ? sorted.slice(-50) : "";
      let hash = 0;
      for (let i = 0; i < sorted.length; i++) {
        hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0;
      }
      const fingerprint = Math.abs(hash).toString(36).slice(0, 8);
      return prefix + ":scrape:" + len + ":" + first + ":" + last + ":" + fingerprint;
    };

    const providerTasks = providers.map(async (provider) => {
      const sourceStart = Date.now();
      const id = provider.id;

      // Individual provider budget: Total Scrape Time - dispatch buffer
      const providerDeadline = deadline ? Math.min(deadline - 2000, Date.now() + 45000) : 0;

      try {
        if (deadline && Date.now() > deadline - SCRAPE_SAFETY_MARGIN_MS) {
          return { id, results: [], state: { status: "skipped", count: 0, error: "Nearing execution deadline", metrics: null, responseTime: Date.now() - sourceStart } };
        }

        if (disabledSources.has(id)) {
          return { id, results: [], state: { status: "circuit_break", count: 0, error: "Source in cooldown or manually disabled", metrics: null, responseTime: Date.now() - sourceStart } };
        }

        if (lifecycle) lifecycle.currentStep = `scraping_${id}`;

        let matcher: { titles: Set<string>; urls: Set<string> } | PreferredSecondaryMatcher | null = null;
        if (id === "ikiru") {
          matcher = { titles: preferredIkiruTitleKeys, urls: preferredIkiruUrlKeys };
          if (matcher.titles.size === 0 && matcher.urls.size === 0) {
            return { id, results: [], state: { status: "skipped", count: 0, error: "no whitelist titles", metrics: null, responseTime: Date.now() - sourceStart } };
          }
        } else if (preferredSecondaryMatchersBySource[id]) {
          matcher = preferredSecondaryMatchersBySource[id];
          if (!hasPreferredSecondaryMatcher(matcher)) {
            return { id, results: [], state: { status: "skipped", count: 0, error: "no whitelist titles", metrics: null, responseTime: Date.now() - sourceStart } };
          }
        }

        const scrapeWithRetry = async () => {
          let attempts = 0;
          const maxAttempts = 2; // Try up to 2 times (1 retry)

          while (attempts < maxAttempts) {
            attempts++;
            try {
              const out = await provider.scrapeUpdates({
                redis,
                preferredMatcher: matcher,
                logger,
                force: options.force,
                fullRefresh: options.fullRefresh,
                skipExpansion: options.skipExpansion,
                deadline: providerDeadline,
              });

              const status = out.state?.status;
              const errCode = out.state?.errCode;

              // Only retry on certain error codes and if we have time
              const isTransient = errCode === "TIMEOUT" || errCode === "RATE_LIMIT" || status === "error";
              const hasTime = !deadline || (Date.now() < deadline - (SCRAPE_SAFETY_MARGIN_MS + 2000));

              if (status === "error" && isTransient && hasTime && attempts < maxAttempts) {
                const backoff = 2000 * attempts;
                logger.warn({ source: id, attempt: attempts, backoff }, "adaptive retry: transient error detected, retrying...");
                await new Promise(r => setTimeout(r, backoff));
                continue;
              }

              if (status === "error" && attempts === maxAttempts) {
                // Final attempt failed, check if we need to auto-heal domain
                await autoHealIfNeeded(id, out.state?.error);
              }

              return out;
            } catch (err: unknown) {
              const hasTime = !deadline || (Date.now() < deadline - 15000);
              if (hasTime && attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
              }
              throw err;
            }
          }
          throw new Error(`Max scrape attempts reached for source: ${id}`);
        };

        const out = await scrapeWithRetry();

        // Record last check if successful
        const status = out.state?.status;
        const isSuccess = status === "ok" || status === "healthy" || status === "success";

        if (isSuccess && redis) {
          const keysToMark = [];
          if (id === "ikiru") keysToMark.push(...Array.from(preferredIkiruTitleKeys));
          else if (preferredSecondaryMatchersBySource[id]) keysToMark.push(...Array.from(preferredSecondaryMatchersBySource[id].titleKeys));

          if (keysToMark.length) await batchSetLastScrapeChecks(redis, keysToMark);
        }

        return { id, results: out.results, state: { ...out.state, responseTime: Date.now() - sourceStart } };
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMessage, source: id }, `${id} scrape failed`);
        return { id, results: [], state: { status: "error", count: 0, error: errMessage, metrics: null, responseTime: Date.now() - sourceStart } };
      }
    });

    const executionResults = await Promise.all(providerTasks);

    for (const res of executionResults) {
      if (res.results.length) {
        scrapedChapters.push(...res.results);
        if (redis) {
          await appendLiveEvent(redis, {
            message: `Scraped ${res.results.length} items from ${res.id}`,
            type: "info",
          });
        }
      }
      sourceStates[res.id] = res.state as SourceState;
    }

    if (scrapedChapters.length > 0) {
      // 1. Ensure all have title keys and detect potential title mismatches (Auto-Heal candidates)
      scrapedChapters.forEach((ch: ChapterItem & { titleKey?: string }) => {
        const rawTitle = String(ch?.title || "");
        const tk = normalizeTitleKey(rawTitle);
        ch.titleKey = normalizeTitleKey(rawTitle);
      });

      // 2. Aggregate all whitelist criteria (USE FULL WHITELIST, NOT FILTERED)
      const activeWhitelistTitles = new Set([
        ...fullWhitelistIkiruTitleKeys,
        ...fullWhitelistSecondaryTitleKeys
      ]);

      const activeWhitelistUrls = new Set([
        ...fullWhitelistIkiruUrlKeys,
        ...fullWhitelistSecondaryUrlKeys
      ]);

      // 3. Filter whitelist and recent chapters
      const unfilteredCount = scrapedChapters.length;
      const filtered = filterWhitelistedChapters(scrapedChapters, activeWhitelistTitles, activeWhitelistUrls);

      if (filtered.length < unfilteredCount) {
        logger.info(
          { original: unfilteredCount, kept: filtered.length },
          "filtered out non-whitelist updates before enrichment"
        );
        scrapedChapters.length = 0;
        scrapedChapters.push(...filtered);
      }

      // 4. Filter out stale chapters (>24h)
      const recentCutoffHours = 24;
      const recentChapters = filterRecentChapters(scrapedChapters, recentCutoffHours, safeParseDate, isWithinLastHours);

      if (recentChapters.length < scrapedChapters.length) {
        logger.info(
          {
            original: scrapedChapters.length,
            kept: recentChapters.length,
            removed: scrapedChapters.length - recentChapters.length
          },
          "filtered out stale chapters older than 24 hours"
        );
        scrapedChapters.length = 0;
        scrapedChapters.push(...recentChapters);
      }
    }

    if (scrapedChapters.length > 0) {
      if (lifecycle) lifecycle.currentStep = "enriching_metadata";

      const uniqueTitleKeys = [...new Set(scrapedChapters.map((ch: ChapterItem & { titleKey?: string }) => ch.titleKey))];
      const metadataMap = new Map();

      // Load cached metadata from Redis
      if (redis) {
        const cachedResults = await batchGetMangaMetadata(
          redis,
          uniqueTitleKeys.filter((tk): tk is string => !!tk),
        );
        cachedResults.forEach((meta, i) => {
          if (meta) metadataMap.set(uniqueTitleKeys[i], meta);
        });
      }

      // OPTIMIZATION: If QStash is enabled, we usually skip synchronous enrichment
      // to save time. However, for a small number of items (e.g. new manga), 
      // we allow a tiny batch of sync fetches so the first notification isn't "Unknown".
      const isQStash = process.env.QSTASH_ENABLED === "true";
      const skipSyncEnrichment = isQStash && !options.force;

      const maxSyncFetches = skipSyncEnrichment ? 15 : 40;

      const enrichmentStats = await enrichChaptersMetadata(
        scrapedChapters,
        metadataMap,
        redis,
        {
          maxFetches: maxSyncFetches,
          deadline: deadline,
          safetyMarginMs: SCRAPE_SAFETY_MARGIN_MS / 2,
        }
      );

      logger.info(
        {
          cached: enrichmentStats.cached,
          fetched: enrichmentStats.fetched,
          failed: enrichmentStats.failed,
          skipped: enrichmentStats.skipped,
          durationMs: enrichmentStats.durationMs,
        },
        "Metadata enrichment stats"
      );

      // Apply metadata to chapters
      applyMetadataToChapters(scrapedChapters, metadataMap);

      // 5. Sort chapters by time, title, and chapter number
      const sortedChapters = sortChapters(scrapedChapters, getChapterNumber, safeParseDate);
      scrapedChapters.length = 0;
      scrapedChapters.push(...sortedChapters);
    }

    let nextSourceHealth: Record<string, SourceHealth> = currentHealthMap;
    try {
      nextSourceHealth = buildNextSourceHealthMap({
        sourceKeys: SOURCE_KEYS,
        currentMap: currentHealthMap,
        sourceStates: sourceStates,
        nowIso: new Date().toISOString(),
        failureThreshold: options?.healthFailureThreshold,
        cooldownSeconds: options?.healthCooldownSeconds,
      });
      if (redis) {
        await saveSourceHealthMap(redis, nextSourceHealth, SOURCE_KEYS);
      }
    } catch (healthErr: unknown) {
      const err = healthErr instanceof Error ? healthErr : new Error(String(healthErr));
      logger.warn({ err: err.message }, "failed to update source health map");
    }

    let skippedHibernation = 0;
    if (skipTitleKeys instanceof Set) {
      skippedHibernation = skipTitleKeys.size;
    }

    return {
      items: scrapedChapters,
      sourceStates: sourceStates,
      nextSourceHealth,
      metrics: {
        hibernatedCount,
        incrementalSaved: incrementalSavedCount,
        initialWhitelistSize: initialTitleCount,
      }
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: error.message }, "scrape fatal - returning partial data");
    return {
      items: scrapedChapters,
      sourceStates: sourceStates || {
        ikiru: { status: "error", count: 0, error: error.message, metrics: null },
        shinigami: {
          status: "error",
          count: 0,
          error: error.message,
          metrics: null,
        },
      },
    };
  }
}

export async function scrapeMangaUpdatesWithMeta(redis: RedisClient | null = null, options: OrchestrateOptions = {}) {
  return orchestrateScrapeSources({
    redis,
    options,
    logger: defaultLogger,
  });
}


