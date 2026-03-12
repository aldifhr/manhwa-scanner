import { normalizeTitleKey } from "./domain/manga.js";
import { normalizeSource, sourceLabel } from "./domain/source.js";
import { SOURCE_COMPARE_CACHE_KEY, SOURCE_COMPARE_STATE_KEY } from "./cacheKeys.js";

const SOURCE_COMPARE_ENTRY_LIMIT = 200;
const SOURCE_COMPARE_VIEW_LIMIT = 20;
const SOURCE_COMPARE_HEAD_SAMPLE = 5;
export const SOURCE_COMPARE_STATE_TTL_SEC = Number(
  process.env.SOURCE_COMPARE_STATE_TTL_SEC || 60 * 60 * 24 * 7,
);

function sourceFamily(source = "") {
  return normalizeSource(source) === "ikiru" ? "ikiru" : "shinigami";
}

function chapterKey(chapter = "") {
  const text = String(chapter).toLowerCase().trim();
  const match = text.match(/\d+(\.\d+)?/);
  return match ? match[0] : text;
}

function toTimestamp(entry) {
  const primary = entry?.updatedTime ? new Date(entry.updatedTime).getTime() : NaN;
  if (!Number.isNaN(primary)) return primary;
  const fallback = entry?.sentAt ? new Date(entry.sentAt).getTime() : NaN;
  return Number.isNaN(fallback) ? null : fallback;
}

export function buildSourceComparePayload(entries = []) {
  const sourceCounts = { ikiru: 0, shinigami_project: 0, shinigami_mirror: 0 };
  const grouped = new Map();

  for (const entry of entries) {
    const normalizedSource = normalizeSource(entry?.source);
    sourceCounts[normalizedSource] = (sourceCounts[normalizedSource] || 0) + 1;

    const title = String(entry?.title || "").trim();
    const chapter = String(entry?.chapter || "").trim();
    const titleNorm = normalizeTitleKey(title);
    const chapterNorm = chapterKey(chapter);
    if (!titleNorm || !chapterNorm) continue;

    const key = `${titleNorm}::${chapterNorm}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        title,
        chapter,
        ikiru: null,
        shinigami: null,
      });
    }

    const bucket = grouped.get(key);
    const family = sourceFamily(normalizedSource);
    const ts = toTimestamp(entry);
    if (!ts) continue;

    const payload = {
      ts,
      source: normalizedSource,
      sourceLabel: sourceLabel(normalizedSource),
      updatedTime: entry?.updatedTime ?? null,
      sentAt: entry?.sentAt ?? null,
    };

    if (family === "ikiru") {
      if (!bucket.ikiru || ts < bucket.ikiru.ts) bucket.ikiru = payload;
    } else if (!bucket.shinigami || ts < bucket.shinigami.ts) {
      bucket.shinigami = payload;
    }
  }

  let ikiruWins = 0;
  let shinigamiWins = 0;
  let ties = 0;

  const comparisons = [];
  for (const bucket of grouped.values()) {
    if (!bucket.ikiru || !bucket.shinigami) continue;

    const deltaMinutes = Math.round(
      Math.abs(bucket.ikiru.ts - bucket.shinigami.ts) / 60000,
    );

    let winner = "tie";
    if (bucket.ikiru.ts < bucket.shinigami.ts) {
      winner = "ikiru";
      ikiruWins++;
    } else if (bucket.shinigami.ts < bucket.ikiru.ts) {
      winner = "shinigami";
      shinigamiWins++;
    } else {
      ties++;
    }

    comparisons.push({
      title: bucket.title,
      chapter: bucket.chapter,
      winner,
      deltaMinutes,
      ikiru: {
        source: bucket.ikiru.source,
        sourceLabel: bucket.ikiru.sourceLabel,
        updatedTime: bucket.ikiru.updatedTime,
        sentAt: bucket.ikiru.sentAt,
      },
      shinigami: {
        source: bucket.shinigami.source,
        sourceLabel: bucket.shinigami.sourceLabel,
        updatedTime: bucket.shinigami.updatedTime,
        sentAt: bucket.shinigami.sentAt,
      },
      compareAt: new Date(Math.max(bucket.ikiru.ts, bucket.shinigami.ts)).toISOString(),
    });
  }

  comparisons.sort(
    (a, b) => new Date(b.compareAt).getTime() - new Date(a.compareAt).getTime(),
  );

  return {
    summary: {
      totalCompared: comparisons.length,
      ikiruWins,
      shinigamiWins,
      ties,
    },
    sourceCounts,
    comparisons: comparisons.slice(0, SOURCE_COMPARE_VIEW_LIMIT),
  };
}

function entrySignature(entry) {
  return [
    normalizeTitleKey(entry?.title || ""),
    chapterKey(entry?.chapter || ""),
    normalizeSource(entry?.source || ""),
    String(entry?.url || "").trim().toLowerCase(),
    String(entry?.sentAt || entry?.updatedTime || "").trim(),
  ].join("|");
}

export function getSourceCompareHeadSignature(entries = []) {
  return entries
    .slice(0, SOURCE_COMPARE_HEAD_SAMPLE)
    .map((entry) => entrySignature(entry))
    .join("||");
}

export function buildSourceCompareState(entries = []) {
  return {
    generatedAt: new Date().toISOString(),
    recentCount: entries.length,
    headSignature: getSourceCompareHeadSignature(entries),
    payload: buildSourceComparePayload(entries),
  };
}

export async function refreshSourceCompareStateFromRecent(redis) {
  if (!redis) return null;
  const raw = await redis.lrange("recent:chapters", 0, SOURCE_COMPARE_ENTRY_LIMIT - 1);
  const entries = Array.isArray(raw) ? raw.filter(Boolean) : [];
  const state = buildSourceCompareState(entries);
  await redis
    .set(SOURCE_COMPARE_STATE_KEY, state, { ex: SOURCE_COMPARE_STATE_TTL_SEC })
    .catch(() => {});
  await redis.del(SOURCE_COMPARE_CACHE_KEY).catch(() => {});
  return state;
}
