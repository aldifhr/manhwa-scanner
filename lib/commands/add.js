import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import pLimit from "p-limit";
import { fetchLatestMangaUpdateTime, searchIkiru } from "../scrapers/ikiru.js";
import { searchShngm } from "../scrapers/secondary.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { normalizeSource, normalizeTitleKey, sourceLabel } from "../domain.js";
import { addWhitelistEntry } from "../services/whitelist.js";
import {
  buildAddExistsMessage,
  buildAddSuccessMessage,
} from "../services/whitelist.js";
import { ensureAddAllowedResponse } from "../permissions.js";
import { resolveAddFromUrl } from "../services/addFromUrl.js";
import {
  AUTOCOMPLETE_LABEL_LIMIT,
  MAX_STALE_MS,
  isValidDomain,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_COMPONENT_TYPE,
} from "../config.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:add" });
const ADD_SOURCE_PICK_TTL_SEC = 300;

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function createAddSessionId(source) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${source}:${stamp}:${rand}`;
}

function buildAddResultValue(sessionId, index) {
  return `${sessionId}|||${index}`;
}

function splitAddResultValue(rawValue) {
  const raw = String(rawValue || "");
  const parts = raw.split("|||");
  if (parts.length !== 2) return null;
  return { sessionId: parts[0], index: Number.parseInt(parts[1], 10) };
}

function buildSourcePickValue(sessionId, source) {
  return `${sessionId}|||${source}`;
}

function splitSourcePickValue(rawValue) {
  const raw = String(rawValue || "");
  const parts = raw.split("|||");
  if (parts.length !== 2) return null;
  return { sessionId: parts[0], source: normalizeSource(parts[1]) };
}

// MAX_STALE_MS imported from config.js
const IKIRU_ENRICH_LIMIT = 10;
const IKIRU_ENRICH_CONCURRENCY = 5;
const MAX_OPTIONS_BROAD_QUERY = 10;
const MAX_OPTIONS_SPECIFIC_QUERY = 25;
const AUTOCOMPLETE_OPTION_LIMIT = 25;

function parseUpdatedTime(item) {
  const ts = item?.updatedTime ? new Date(item.updatedTime).getTime() : NaN;
  return Number.isNaN(ts) ? null : ts;
}

function isSpecificQuery(query) {
  const q = String(query || "").trim();
  if (!q) return false;
  const words = q.split(/\s+/).filter(Boolean);
  return q.length >= 12 || words.length >= 3;
}

/**
 * Categorize results by recency using functional approach
 * @param {Array} results - Search results
 * @returns {Object} Categorized results {active, unknown, stale}
 */
function categorizeByRecency(results = []) {
  const now = Date.now();

  return results.reduce(
    (acc, item) => {
      const ts = parseUpdatedTime(item);
      if (ts === null) {
        acc.unknown.push(item);
      } else if (now - ts > MAX_STALE_MS) {
        acc.stale.push(item);
      } else {
        acc.active.push(item);
      }
      return acc;
    },
    { active: [], unknown: [], stale: [] },
  );
}

/**
 * Filter and sort results by recency
 * Priority: active > unknown > stale
 */
function filterAndSortRecent(results = []) {
  const { active, unknown, stale } = categorizeByRecency(results);
  // Keep original search relevance order within each category
  return [...active, ...unknown, ...stale];
}

async function enrichIkiruUpdatedTimes(results = [], redis = null) {
  const out = results.map((item) => ({ ...item }));
  const limit = Math.min(out.length, IKIRU_ENRICH_LIMIT);
  const itemsToEnrich = out.slice(0, limit);

  const concurrencyLimit = pLimit(IKIRU_ENRICH_CONCURRENCY);

  await Promise.all(
    itemsToEnrich.map((item) =>
      concurrencyLimit(async () => {
        const mangaUrl = item.mangaUrl || item.url;
        if (!mangaUrl) return;

        const updatedTime = await fetchLatestMangaUpdateTime(mangaUrl, redis);
        if (updatedTime) {
          item.updatedTime = updatedTime;
        }
      }),
    ),
  );

  return out;
}

/**
 * Create unique deduplication key for manga item
 */
const createItemKey = (item) =>
  `${normalizeSource(item?.source)}::${String(item?.title ?? "")
    .trim()
    .toLowerCase()}`;

/**
 * Merge results from multiple sources with deduplication
 * Uses Map for O(n) deduplication instead of O(n²) Set approach
 */
function mergeSourceResults(sourceResults) {
  const seen = new Map();

  return sourceResults
    .flatMap(({ results, usedFallback }) =>
      results.map((item) => ({ item, key: createItemKey(item), usedFallback })),
    )
    .filter(({ key, item }) => {
      if (seen.has(key)) return false;
      seen.set(key, item);
      return true;
    })
    .map(({ item, usedFallback }) => ({ ...item, usedFallback }));
}

/**
 * Search results with optional enrichment and filtering
 * @param {string} query - Search query
 * @param {string} source - Source name or "all"
 * @param {Object} options - Search options
 * @param {boolean} options.enrich - Whether to enrich with updated times
 * @param {boolean} options.filterRecent - Whether to filter by recency
 * @param {Object} redis - Redis client
 */
async function searchAddResults(query, source, options = {}, redis = null) {
  const { enrich = false, filterRecent = false } = options;

  // Handle "all" sources with parallel search
  // Use Promise.allSettled to handle partial failures (one source down, other works)
  if (!source || source === "all") {
    const [ikiruResult, shngmResult] = await Promise.allSettled([
      searchAddResults(query, "ikiru", options, redis),
      searchAddResults(query, "shinigami_project", options, redis),
    ]);

    const ikiruOut = ikiruResult.status === "fulfilled" ? ikiruResult.value : { results: [] };
    const shngmOut = shngmResult.status === "fulfilled" ? shngmResult.value : { results: [], usedFallback: false };

    // Log which source failed
    if (ikiruResult.status === "rejected") {
      logger.warn({ err: ikiruResult.reason?.message }, "Ikiru search failed, using Shinigami only");
    }
    if (shngmResult.status === "rejected") {
      logger.warn({ err: shngmResult.reason?.message }, "Shinigami search failed, using Ikiru only");
    }

    const merged = mergeSourceResults([
      { results: ikiruOut.results, usedFallback: false },
      { results: shngmOut.results, usedFallback: shngmOut.usedFallback },
    ]);

    return {
      results: merged,
      sourceUsed: "all",
      usedFallback: shngmOut.usedFallback,
    };
  }

  // Ikiru source handling
  if (source === "ikiru") {
    const raw = (await searchIkiru(query, {}, redis)).map((item) => ({
      ...item,
      updatedTime: null, // Don't use card search updatedTime (often publish date)
    }));

    const enriched = enrich ? await enrichIkiruUpdatedTimes(raw, redis) : raw;
    const results = filterRecent ? filterAndSortRecent(enriched) : enriched;

    return {
      results,
      sourceUsed: "ikiru",
      usedFallback: false,
    };
  }

  // Shinigami source handling with fallback
  const primaryResults = await searchShngm(query, "shinigami_project");
  const primaryFiltered = filterRecent
    ? filterAndSortRecent(primaryResults)
    : primaryResults;

  if (primaryFiltered.length > 0) {
    return {
      results: primaryFiltered,
      sourceUsed: "shinigami_project",
      usedFallback: false,
    };
  }

  // Fallback to mirror
  const fallbackResults = await searchShngm(query, "shinigami_mirror");
  const fallbackFiltered = filterRecent
    ? filterAndSortRecent(fallbackResults)
    : fallbackResults;

  return {
    results: fallbackFiltered,
    sourceUsed: "shinigami_mirror",
    usedFallback: true,
  };
}

/**
 * Fast search without enrichment (for autocomplete)
 * Alias for searchAddResults with enrich=false, filterRecent=false
 */
const searchAddResultsFast = (query, source, redis = null) =>
  searchAddResults(
    query,
    source,
    { enrich: false, filterRecent: false },
    redis,
  );

function formatAutocompleteName(item) {
  const prefix = `[${sourceLabel(item.source)}] `;
  const title = String(item.title || "").trim();
  const chapter = String(item.chapter || "").trim();
  const text = `${prefix}${title}${chapter ? ` - ${chapter}` : ""}`;
  return text.length > AUTOCOMPLETE_LABEL_LIMIT
    ? `${text.substring(0, AUTOCOMPLETE_LABEL_LIMIT - 3)}...`
    : text;
}

async function cacheAddResults(sessionId, results, redis = null) {
  if (!redis) return;
  try {
    await redis.set(`add:results:${sessionId}`, results, { ex: 300 });
  } catch (err) {
    logger.warn({ err: err.message, sessionId }, "Failed to cache add results");
  }
}

async function cacheAddSourcePickSession(sessionId, payload, redis = null) {
  if (!redis) return;
  try {
    await redis.set(`add:source-pick:${sessionId}`, payload, {
      ex: ADD_SOURCE_PICK_TTL_SEC,
    });
  } catch (err) {
    logger.warn(
      { err: err.message, sessionId },
      "Failed to cache add source pick session",
    );
  }
}

async function loadAddSourcePickSession(sessionId, redis = null) {
  if (!redis) return null;
  try {
    return await redis.get(`add:source-pick:${sessionId}`);
  } catch (err) {
    logger.warn(
      { err: err.message, sessionId },
      "Failed to load add source pick session",
    );
    return null;
  }
}

function getSourceResultMap(results = []) {
  const bySource = {
    ikiru: [],
    shinigami_project: [],
    shinigami_mirror: [],
    all: [],
  };

  for (const item of results) {
    const source = normalizeSource(item?.source);
    if (bySource[source]) bySource[source].push(item);
  }
  bySource.all = dedupeByTitle(results);
  return bySource;
}

function buildSourcePickComponents(sessionId, sourceMap) {
  const options = [];

  const allCount = (sourceMap.all || []).length;
  if (allCount > 0) {
    options.push({
      label: "Semua Sumber",
      value: buildSourcePickValue(sessionId, "all"),
      description: `${allCount} hasil`,
    });
  }

  const sources = ["ikiru", "shinigami_project", "shinigami_mirror"];
  for (const source of sources) {
    const count = (sourceMap[source] || []).length;
    if (!count) continue;
    options.push({
      label: sourceLabel(source),
      value: buildSourcePickValue(sessionId, source),
      description: `${count} hasil`,
    });
  }

  return [
    {
      type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: DISCORD_COMPONENT_TYPE.STRING_SELECT,
          custom_id: "select_add_source",
          placeholder: "Pilih sumber pencarian...",
          options: options.slice(0, AUTOCOMPLETE_OPTION_LIMIT),
        },
      ],
    },
  ];
}

export async function resolveAddSourceSelectionValue(rawValue, redis = null) {
  const parsed = splitSourcePickValue(rawValue);
  if (!parsed || !redis) {
    return { query: "", source: "all", results: [] };
  }

  const cached = await loadAddSourcePickSession(parsed.sessionId, redis);
  if (!cached) {
    return { query: "", source: parsed.source, results: [] };
  }

  const sourceMap = cached?.sourceMap || {};
  const results = Array.isArray(sourceMap[parsed.source])
    ? sourceMap[parsed.source]
    : [];
  return {
    query: String(cached?.query || ""),
    source: parsed.source,
    results,
  };
}

export async function resolveAddResultValue(rawValue, redis = null) {
  const parsed = splitAddResultValue(rawValue);
  if (
    !parsed ||
    !redis ||
    !parsed.sessionId ||
    !Number.isInteger(parsed.index)
  ) {
    return { cached: null, item: null, selectedSource: "ikiru" };
  }

  const sessionSource = normalizeSource(
    parsed.sessionId.split(":")[0] || "ikiru",
  );
  const cached = await redis.get(`add:results:${parsed.sessionId}`);
  const results = Array.isArray(cached) ? cached : [];
  const item =
    parsed.index >= 0 && parsed.index < results.length
      ? results[parsed.index]
      : null;
  const selectedSource = normalizeSource(item?.source || sessionSource);

  return { cached, item, selectedSource };
}

/**
 * Deduplicate results by title using functional approach
 */
const dedupeByTitle = (results) => {
  const seen = new Set();
  return results.filter((res) => {
    const normalizedTitle = res.title?.toLowerCase().trim();
    if (!normalizedTitle || seen.has(normalizedTitle)) return false;
    seen.add(normalizedTitle);
    return true;
  });
};

export async function buildAddAutocompleteChoices(options, redis = null) {
  const focused = options?.find((item) => item.focused);
  const query = String(focused?.value ?? "").trim();

  if (query.length < 2) return [];

  const { results } = await searchAddResultsFast(query, "all", redis);
  if (!results.length) return [];

  const deduped = dedupeByTitle(results);
  const top = deduped.slice(0, AUTOCOMPLETE_OPTION_LIMIT);
  const sessionId = createAddSessionId("all");

  await cacheAddResults(sessionId, top, redis);

  return top.map((item, index) => ({
    name: formatAutocompleteName(item),
    value: buildAddResultValue(sessionId, index),
  }));
}

/**
 * Handle direct URL addition
 */
async function handleDirectUrlAdd(payload, url, redis) {
  try {
    const { title, source, error } = await resolveAddFromUrl(url);
    if (error) {
      return editInteractionResponse(payload, `❌ ${error}`);
    }

    const result = await addWhitelistEntry({ title, url, source });
    if (result.status === "exists") {
      return editInteractionResponse(payload, buildAddExistsMessage(result));
    }

    return editInteractionResponse(
      payload,
      buildAddSuccessMessage({
        ...result,
        total: result.whitelist.length,
      }),
    );
  } catch (err) {
    return editInteractionResponse(
      payload,
      `Terjadi kesalahan: ${err.message}`,
    );
  }
}

/**
 * Handle adding from pre-selected item
 */
async function handlePreselectedAdd(payload, item, source, redis) {
  try {
    const result = await addWhitelistEntry({
      title: item.title,
      url: item.mangaUrl ?? item.url,
      source,
    });

    if (result.status === "exists") {
      return editInteractionResponse(payload, buildAddExistsMessage(result));
    }

    return editInteractionResponse(
      payload,
      buildAddSuccessMessage({
        ...result,
        total: result.whitelist.length,
      }),
    );
  } catch (err) {
    return editInteractionResponse(
      payload,
      `Terjadi kesalahan: ${err.message}`,
    );
  }
}

/**
 * Build search result options for Discord components
 */
function buildSearchOptions(
  results,
  sessionId,
  query,
  sourceUsed,
  usedFallback,
) {
  const maxOptions = isSpecificQuery(query)
    ? MAX_OPTIONS_SPECIFIC_QUERY
    : MAX_OPTIONS_BROAD_QUERY;
  const top = results.slice(0, maxOptions);

  const optionsSelect = top.map((item, i) => {
    const srcLabel = item.source ? `[${item.source === "ikiru" ? "Ikiru" : "Shinigami"}] ` : "";
    const maxTitleLen = Math.max(10, AUTOCOMPLETE_LABEL_LIMIT - srcLabel.length);
    const title = item.title.length > maxTitleLen
      ? `${item.title.substring(0, maxTitleLen - 3)}...`
      : item.title;
    return {
      label: `${srcLabel}${title}`,
      value: buildAddResultValue(sessionId, i),
      description: (item.chapter || "Pilih untuk menambahkan").substring(0, 100),
    };
  });

  const components = [
    {
      type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: DISCORD_COMPONENT_TYPE.STRING_SELECT,
          custom_id: "select_add_src",
          placeholder:
            sourceUsed === "all"
              ? "Pilih manga dari semua sumber..."
              : `Pilih manga dari ${sourceLabel(sourceUsed)}...`,
          options: optionsSelect,
        },
      ],
    },
  ];

  const content =
    sourceUsed === "all"
      ? `Pilih hasil pencarian dari semua sumber untuk: **${query}**.`
      : usedFallback
        ? `Tidak ada hasil di **Shinigami (Project)**. Menampilkan hasil dari **Shinigami (Mirror)** untuk **${query}**.`
        : `Pilih hasil pencarian dari **${sourceLabel(sourceUsed)}** untuk: **${query}**.`;

  return { content, components };
}

/**
 * Handle search and display results
 */
async function handleSearchAndDisplay(payload, query, redis) {
  try {
    const { results, sourceUsed, usedFallback } = await searchAddResults(
      query,
      "all",
      { enrich: true, filterRecent: false },
      redis,
    );

    if (!results.length) {
      return await editInteractionResponse(
        payload,
        `Tidak ada hasil untuk **${query}** di semua sumber.`,
      );
    }

    // Direct-add path: if query exactly matches one result title, skip dropdown UX.
    const queryKey = normalizeTitleKey(query);
    const exactMatches = results.filter(
      (item) => normalizeTitleKey(item?.title || "") === queryKey,
    );
    if (exactMatches.length === 1) {
      const picked = exactMatches[0];
      const result = await addWhitelistEntry({
        title: picked.title,
        url: picked.mangaUrl ?? picked.url,
        source: picked.source,
      });

      if (result.status === "exists") {
        return await editInteractionResponse(payload, buildAddExistsMessage(result));
      }
      return await editInteractionResponse(
        payload,
        buildAddSuccessMessage({
          ...result,
          total: result.whitelist.length,
        }),
      );
    }

    const sourceMap = getSourceResultMap(results);
    const sourceSessionId = createAddSessionId("all");
    await cacheAddSourcePickSession(
      sourceSessionId,
      {
        query,
        sourceUsed,
        usedFallback,
        sourceMap,
      },
      redis,
    );

    const content = `Pilih sumber untuk pencarian **${query}** terlebih dahulu, lalu pilih judul manhwa.`;
    const components = buildSourcePickComponents(sourceSessionId, sourceMap);

    return await editInteractionResponseWithComponents(
      payload,
      content,
      components,
      [],
    );
  } catch (err) {
    logger.error({ err: err.message }, "[handleSearchAndDisplay] Error");
    return editInteractionResponse(
      payload,
      "❌ Gagal mencari manga. Coba lagi nanti atau gunakan URL langsung.",
    );
  }
}

export async function handleAddSourcePickInteraction(payload, rawValue, redis) {
  const { query, source, results } = await resolveAddSourceSelectionValue(
    rawValue,
    redis,
  );

  if (!results.length) {
    return editInteractionResponse(
      payload,
      "Session expired atau hasil sumber kosong. Jalankan /add lagi.",
    );
  }

  const sessionId = createAddSessionId(source);
  await cacheAddResults(sessionId, results, redis);

  const { content, components } = buildSearchOptions(
    results,
    sessionId,
    query || "query",
    source,
    false,
  );

  return editInteractionResponseWithComponents(payload, content, components, []);
}

/**
 * Main handler for /add command
 */
export default async function handleAdd(payload, options, res, redis = null) {
  // Permission check
  const denied = await ensureAddAllowedResponse(payload, redis);
  if (denied) return res.json(denied);

  // Parse input (support both "query" and legacy "title"/"url" option names)
  const queryRaw = String(
    getOption(options, "query") ?? getOption(options, "title") ?? getOption(options, "url") ?? "",
  ).trim();

  // Validate URL format and domain if URL provided
  let urlOpt = null;
  if (/^https?:\/\//i.test(queryRaw)) {
    if (!isValidDomain(queryRaw)) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Domain URL tidak diizinkan. Hanya domain yang whitelisted yang dapat ditambahkan.",
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }
    urlOpt = queryRaw;
  }
  const query = urlOpt ? "" : queryRaw;

  // Direct URL addition path
  if (urlOpt) {
    res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    });
    waitUntil(handleDirectUrlAdd(payload, urlOpt, redis));
    return;
  }

  // Empty query check
  if (!query) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Silakan masukkan judul manga atau URL langsung.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  // Search path
  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });
  waitUntil(
    (async () => {
      try {
        // Try pre-selected value first
        const picked = await resolveAddResultValue(query, redis);
        if (picked.item) {
          return handlePreselectedAdd(
            payload,
            picked.item,
            picked.selectedSource,
            redis,
          );
        }

        // Perform search
        return handleSearchAndDisplay(payload, query, redis);
      } catch (err) {
        return editInteractionResponse(
          payload,
          `Terjadi kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}
