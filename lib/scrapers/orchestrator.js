import { getLogger } from "../logger.js";
import {
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
  parseIkiruDatetime,
} from "./shared.js";

function buildDefaultSecondaryMetrics() {
  return {
    detailAttempts: 0,
    detailSuccesses: 0,
    detailFallbacks: 0,
    detail429: 0,
    detailSkippedNonPriority: 0,
  };
}

function buildPreferredSecondaryMatcher(titles = [], urls = []) {
  return {
    titleKeys: new Set(
      (Array.isArray(titles) ? titles : [])
        .map((title) => normalizeTitleKey(title))
        .filter(Boolean),
    ),
    urlKeys: new Set(
      (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeSourceUrl(url))
        .filter(Boolean),
    ),
  };
}

function hasPreferredSecondaryMatcher(preferredMatcher) {
  return Boolean(
    preferredMatcher &&
      (preferredMatcher.titleKeys?.size > 0 || preferredMatcher.urlKeys?.size > 0),
  );
}

export async function orchestrateScrapeSources({
  redis = null,
  options = {},
  getCookie,
  scrapeIkiruUpdatesWithMeta,
  scrapeSecondarySourceUpdates,
  logger = getLogger({ scope: "scraper" }),
} = {}) {
  if (typeof getCookie !== "function") {
    throw new Error("orchestrateScrapeSources requires getCookie");
  }
  if (typeof scrapeIkiruUpdatesWithMeta !== "function") {
    throw new Error("orchestrateScrapeSources requires scrapeIkiruUpdatesWithMeta");
  }
  if (typeof scrapeSecondarySourceUpdates !== "function") {
    throw new Error("orchestrateScrapeSources requires scrapeSecondarySourceUpdates");
  }

  try {
    const disabledSources = new Set(
      Array.isArray(options?.disabledSources)
        ? options.disabledSources.map((source) => normalizeSource(source))
        : [],
    );
    const preferredIkiruTitleKeys = new Set(
      (Array.isArray(options?.preferredIkiruTitles) ? options.preferredIkiruTitles : [])
        .map((title) => normalizeTitleKey(title))
        .filter(Boolean),
    );
    const sourceStates = {
      ikiru: { status: "pending", count: 0, error: null, metrics: null },
      shinigami_project: { status: "pending", count: 0, error: null, metrics: null },
      shinigami_mirror: { status: "pending", count: 0, error: null, metrics: null },
    };
    const allResults = [];
    const hasIkiruWhitelist = preferredIkiruTitleKeys.size > 0;

    if (!hasIkiruWhitelist) {
      sourceStates.ikiru = {
        status: "skipped",
        count: 0,
        error: "no whitelist titles",
        metrics: null,
      };
    } else if (disabledSources.has("ikiru")) {
      sourceStates.ikiru = {
        status: "skipped",
        count: 0,
        error: "cooldown active",
        metrics: null,
      };
    } else {
      const cookie = await getCookie(redis);
      logger.info(
        {
          mode: cookie ? "realtime" : "cached",
          preferredIkiruTitles: preferredIkiruTitleKeys.size,
        },
        "ikiru scrape start",
      );
      const ikiru = await scrapeIkiruUpdatesWithMeta(redis, preferredIkiruTitleKeys, logger);
      allResults.push(...ikiru.results);
      sourceStates.ikiru = ikiru.state;
    }

    const secondarySources = ["shinigami_project", "shinigami_mirror"];
    const preferredSecondaryMatchersBySource = {
      shinigami_project: buildPreferredSecondaryMatcher(
        options?.preferredSecondaryTitles?.shinigami_project,
        options?.preferredSecondaryUrls?.shinigami_project,
      ),
      shinigami_mirror: buildPreferredSecondaryMatcher(
        options?.preferredSecondaryTitles?.shinigami_mirror,
        options?.preferredSecondaryUrls?.shinigami_mirror,
      ),
    };

    const secondaryStateEntries = await Promise.all(
      secondarySources.map(async (source) => {
        const preferredMatcher = preferredSecondaryMatchersBySource[source];
        if (!hasPreferredSecondaryMatcher(preferredMatcher)) {
          return [
            source,
            {
              results: [],
              state: {
                status: "skipped",
                count: 0,
                error: "no whitelist titles",
                metrics: buildDefaultSecondaryMetrics(),
              },
            },
          ];
        }

        if (disabledSources.has(source)) {
          return [
            source,
            {
              results: [],
              state: {
                status: "skipped",
                count: 0,
                error: "cooldown active",
                metrics: buildDefaultSecondaryMetrics(),
              },
            },
          ];
        }

        try {
          const out = await scrapeSecondarySourceUpdates(
            source,
            {
              throwOnError: true,
              preferredMatcher,
            },
            logger,
          );
          return [
            source,
            {
              results: out.results,
              state: {
                status: "ok",
                count: out.results.length,
                error: null,
                metrics: out.metrics,
              },
            },
          ];
        } catch (err) {
          logger.warn({ source, err: err.message }, "secondary scrape failed");
          return [
            source,
            {
              results: [],
              state: {
                status: "error",
                count: 0,
                error: err.message,
                metrics: null,
              },
            },
          ];
        }
      }),
    );

    const secondaryStates = Object.fromEntries(secondaryStateEntries);
    const shinigamiResults = secondaryStates.shinigami_project?.results || [];
    const mirrorResults = secondaryStates.shinigami_mirror?.results || [];
    sourceStates.shinigami_project = secondaryStates.shinigami_project?.state || {
      status: "error",
      count: 0,
      error: "unavailable",
      metrics: null,
    };
    sourceStates.shinigami_mirror = secondaryStates.shinigami_mirror?.state || {
      status: "error",
      count: 0,
      error: "unavailable",
      metrics: null,
    };

    if (shinigamiResults.length || mirrorResults.length) {
      allResults.push(...shinigamiResults, ...mirrorResults);
      logger.info(
        {
          shinigami: shinigamiResults.length,
          mirror: mirrorResults.length,
        },
        "secondary scrape complete",
      );
    }

    const deduped = [];
    const seenChapterUrls = new Set();
    for (const item of allResults) {
      const chapterKey = String(item.url || "").replace(/\/+$/g, "").toLowerCase().trim();
      if (!chapterKey || seenChapterUrls.has(chapterKey)) continue;
      seenChapterUrls.add(chapterKey);
      deduped.push(item);
    }

    deduped.sort((a, b) => {
      const ta = parseIkiruDatetime(a.updatedTime)?.getTime() ?? 0;
      const tb = parseIkiruDatetime(b.updatedTime)?.getTime() ?? 0;
      return tb - ta;
    });

    logger.info({ count: deduped.length }, "scrape complete");
    return { items: deduped, sourceStates };
  } catch (err) {
    logger.error({ err: err.message }, "scrape fatal");
    return {
      items: [],
      sourceStates: {
        ikiru: { status: "error", count: 0, error: err.message, metrics: null },
        shinigami_project: { status: "error", count: 0, error: err.message, metrics: null },
        shinigami_mirror: { status: "error", count: 0, error: err.message, metrics: null },
      },
    };
  }
}
