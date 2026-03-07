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

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function sourceLabel(source) {
  if (source === "shinigami_project") return "Shinigami (Project)";
  if (source === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function createAddSessionId(source) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${source}:${stamp}:${rand}`;
}

const MAX_STALE_MS = 1000 * 60 * 60 * 24 * 30 * 8; // ~8 months
const IKIRU_ENRICH_LIMIT = 24;
const IKIRU_ENRICH_CONCURRENCY = 4;
const MAX_OPTIONS_BROAD_QUERY = 10;
const MAX_OPTIONS_SPECIFIC_QUERY = 25;

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

export default function handleAdd(payload, options, res, redis = null) {
  const source = normalizeSource(getOption(options, "source") || "ikiru");
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
        const { results, sourceUsed, usedFallback } = await searchAddResults(
          query,
          source,
          redis,
        );

        if (!results.length) {
          await editInteractionResponse(
            payload,
            source === "ikiru"
              ? `No result for **${query}** in **${sourceLabel(source)}**.`
              : `No result for **${query}** in **Shinigami (Project/Mirror)**.`,
          );
          return;
        }

        const maxOptions = isSpecificQuery(query)
          ? MAX_OPTIONS_SPECIFIC_QUERY
          : MAX_OPTIONS_BROAD_QUERY;
        const top = results.slice(0, maxOptions);
        const sessionId = createAddSessionId(sourceUsed);
        const cacheKey = `add:results:${sessionId}`;
        if (redis) {
          await redis.set(cacheKey, top, { ex: 300 }).catch(() => {});
        }

        const optionsSelect = top.map((item, i) => {
          return {
            label:
              item.title.length > 100
                ? `${item.title.substring(0, 97)}...`
                : item.title,
            value: `${sessionId}|||${i}`,
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
                placeholder: `Select manga from ${sourceLabel(sourceUsed)}...`,
                options: optionsSelect,
              },
            ],
          },
        ];

        await editInteractionResponseWithComponents(
          payload,
          usedFallback
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
