import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import {
  fetchLatestMangaUpdateTime,
  searchIkiru,
  searchShngm,
} from "../scraper.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { normalizeSource, sourceLabel } from "../domain/source.js";
import {
  addWhitelistEntry,
  buildAddExistsMessage,
  buildAddSuccessMessage,
} from "../services/whitelist.js";
import { ensureAddAllowedResponse } from "../permissions.js";

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

const MAX_STALE_MS = 1000 * 60 * 60 * 24 * 30 * 8; // ~8 months
const IKIRU_ENRICH_LIMIT = 24;
const IKIRU_ENRICH_CONCURRENCY = 4;
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

function filterAndSortRecent(results = []) {
  const now = Date.now();
  const active = [];
  const unknown = [];
  const stale = [];

  for (const item of results) {
    const ts = parseUpdatedTime(item);
    if (ts === null) {
      unknown.push(item);
      continue;
    }

    if (now - ts > MAX_STALE_MS) {
      stale.push(item);
      continue;
    }

    active.push(item);
  }

  // Inti perubahan:
  // - aktif update diprioritaskan
  // - tidak dipaksa urut by paling baru
  // - urutan internal tetap ikut relevansi hasil search dari source
  return [...active, ...unknown, ...stale];
}

async function enrichIkiruUpdatedTimes(results = [], redis = null) {
  const out = results.map((item) => ({ ...item }));
  const limit = Math.min(out.length, IKIRU_ENRICH_LIMIT);
  let nextIndex = 0;

  const workers = Array.from({ length: IKIRU_ENRICH_CONCURRENCY }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= limit) break;

      const item = out[i];
      const mangaUrl = item.mangaUrl || item.url;
      if (!mangaUrl) continue;

      const updatedTime = await fetchLatestMangaUpdateTime(mangaUrl, redis);
      if (updatedTime) {
        item.updatedTime = updatedTime;
      }
    }
  });

  await Promise.all(workers);
  return out;
}

async function searchAddResults(query, source, redis = null) {
  if (!source || source === "all") {
    const [ikiruOut, shngmOut] = await Promise.all([
      searchAddResults(query, "ikiru", redis),
      searchAddResults(query, "shinigami_project", redis),
    ]);

    const merged = [];
    const seen = new Set();

    for (const item of [...ikiruOut.results, ...shngmOut.results]) {
      const key = `${normalizeSource(item.source)}::${String(item.title || "")
        .trim()
        .toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    return {
      results: merged,
      sourceUsed: "all",
      usedFallback: shngmOut.usedFallback,
    };
  }

  if (source === "ikiru") {
    const raw = (await searchIkiru(query, {}, redis)).map((item) => ({
      ...item,
      // Jangan pakai updatedTime dari card search karena sering tanggal publish manga.
      updatedTime: null,
    }));
    const enriched = await enrichIkiruUpdatedTimes(raw, redis);
    const results = filterAndSortRecent(enriched);
    return {
      results,
      sourceUsed: "ikiru",
      usedFallback: false,
    };
  }

  const primary = filterAndSortRecent(
    await searchShngm(query, "shinigami_project"),
  );
  if (primary.length) {
    return {
      results: primary,
      sourceUsed: "shinigami_project",
      usedFallback: false,
    };
  }

  const fallback = filterAndSortRecent(
    await searchShngm(query, "shinigami_mirror"),
  );
  return {
    results: fallback,
    sourceUsed: "shinigami_mirror",
    usedFallback: true,
  };
}

async function searchAddResultsFast(query, source, redis = null) {
  if (!source || source === "all") {
    const [ikiru, shngm] = await Promise.all([
      searchAddResultsFast(query, "ikiru", redis),
      searchAddResultsFast(query, "shinigami_project", redis),
    ]);

    const merged = [];
    const seen = new Set();

    for (const item of [...ikiru.results, ...shngm.results]) {
      const key = `${normalizeSource(item.source)}::${String(item.title || "")
        .trim()
        .toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    return { results: merged, sourceUsed: "all", usedFallback: shngm.usedFallback };
  }

  if (source === "ikiru") {
    const results = (await searchIkiru(query, {}, redis)).map((item) => ({
      ...item,
      updatedTime: null,
    }));
    return {
      results,
      sourceUsed: "ikiru",
      usedFallback: false,
    };
  }

  const primary = await searchShngm(query, "shinigami_project");
  if (primary.length) {
    return {
      results: primary,
      sourceUsed: "shinigami_project",
      usedFallback: false,
    };
  }

  const fallback = await searchShngm(query, "shinigami_mirror");
  return {
    results: fallback,
    sourceUsed: "shinigami_mirror",
    usedFallback: true,
  };
}

function formatAutocompleteName(item) {
  const prefix = `[${sourceLabel(item.source)}] `;
  const title = String(item.title || "").trim();
  const chapter = String(item.chapter || "").trim();
  const text = `${prefix}${title}${chapter ? ` - ${chapter}` : ""}`;
  return text.length > 100 ? `${text.substring(0, 97)}...` : text;
}

async function cacheAddResults(sessionId, results, redis = null) {
  if (!redis) return;
  await redis.set(`add:results:${sessionId}`, results, { ex: 300 }).catch(() => {});
}

export async function resolveAddResultValue(rawValue, redis = null) {
  const parsed = splitAddResultValue(rawValue);
  if (!parsed || !redis || !parsed.sessionId || !Number.isInteger(parsed.index)) {
    return { cached: null, item: null, selectedSource: "ikiru" };
  }

  const sessionSource = normalizeSource(parsed.sessionId.split(":")[0] || "ikiru");
  const cached = await redis.get(`add:results:${parsed.sessionId}`);
  const results = Array.isArray(cached) ? cached : [];
  const item =
    parsed.index >= 0 && parsed.index < results.length ? results[parsed.index] : null;
  const selectedSource = normalizeSource(item?.source || sessionSource);

  return { cached, item, selectedSource };
}

export async function buildAddAutocompleteChoices(options, redis = null) {
  const focused = options?.find((item) => item.focused);
  const query = String(focused?.value || "").trim();

  if (query.length < 2) return [];

  const { results } = await searchAddResultsFast(query, "all", redis);
  if (!results.length) return [];

  const top = results.slice(0, AUTOCOMPLETE_OPTION_LIMIT);
  const sessionId = createAddSessionId("all");
  await cacheAddResults(sessionId, top, redis);

  return top.map((item, index) => ({
    name: formatAutocompleteName(item),
    value: buildAddResultValue(sessionId, index),
  }));
}

export default function handleAdd(payload, options, res, redis = null) {
  const denied = ensureAddAllowedResponse(payload);
  if (denied) {
    return res.json(denied);
  }

  const query = String(getOption(options, "title") || "").trim();

  if (!query) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Please provide manga title.", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const picked = await resolveAddResultValue(query, redis);
        if (picked.item) {
          const selectedItem = picked.item;
          const result = await addWhitelistEntry({
            title: selectedItem.title,
            url: selectedItem.mangaUrl ?? selectedItem.url,
            source: picked.selectedSource,
          });

          if (result.status === "exists") {
            await editInteractionResponse(payload, buildAddExistsMessage(result));
            return;
          }

          await editInteractionResponse(
            payload,
            buildAddSuccessMessage({
              ...result,
              total: result.whitelist.length,
            }),
          );
          return;
        }

        const { results, sourceUsed, usedFallback } = await searchAddResults(
          query,
          "all",
          redis,
        );

        if (!results.length) {
          await editInteractionResponse(
            payload,
            `No result for **${query}** in **all sources**.`,
          );
          return;
        }

        const maxOptions = isSpecificQuery(query)
          ? MAX_OPTIONS_SPECIFIC_QUERY
          : MAX_OPTIONS_BROAD_QUERY;
        const top = results.slice(0, maxOptions);
        const sessionId = createAddSessionId(sourceUsed);
        await cacheAddResults(sessionId, top, redis);

        const optionsSelect = top.map((item, i) => {
          return {
            label:
              item.title.length > 100
                ? `${item.title.substring(0, 97)}...`
                : item.title,
            value: buildAddResultValue(sessionId, i),
            description: (item.chapter || "Select to add").substring(0, 100),
          };
        });

        const components = [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: "select_add_src",
                placeholder:
                  sourceUsed === "all"
                    ? "Select manga from all sources..."
                    : `Select manga from ${sourceLabel(sourceUsed)}...`,
                options: optionsSelect,
              },
            ],
          },
        ];

        await editInteractionResponseWithComponents(
          payload,
          sourceUsed === "all"
            ? `Choose one result from all sources for query **${query}**.`
            : usedFallback
            ? `No result in **Shinigami (Project)**. Showing results from **Shinigami (Mirror)** for **${query}**.`
            : `Choose one result from **${sourceLabel(sourceUsed)}** for query **${query}**.`,
          components,
          [],
        );
      } catch (err) {
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}
