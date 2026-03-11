import { redis } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";
import { normalizeTitleKey } from "../lib/domain/manga.js";
import { normalizeSource, sourceLabel } from "../lib/domain/source.js";
import { SOURCE_COMPARE_CACHE_KEY } from "../lib/cacheKeys.js";

const SOURCE_COMPARE_CACHE_SEC = Number(process.env.SOURCE_COMPARE_CACHE_SEC || 180);

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

export default async function handler(req, res) {
  logApiHit("source-compare", req);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const cacheTtl = Number.isFinite(SOURCE_COMPARE_CACHE_SEC) && SOURCE_COMPARE_CACHE_SEC > 0
      ? Math.floor(SOURCE_COMPARE_CACHE_SEC)
      : 180;
    res.setHeader(
      "Cache-Control",
      `private, max-age=${Math.min(cacheTtl, 30)}, stale-while-revalidate=${cacheTtl}`,
    );
    const cached = await redis.get(SOURCE_COMPARE_CACHE_KEY);
    if (cached && typeof cached === "object") {
      return res.status(200).json(cached);
    }

    const raw = await redis.lrange("recent:chapters", 0, 199);
    const entries = Array.isArray(raw) ? raw.filter(Boolean) : [];

    const sourceCounts = { ikiru: 0, shinigami_project: 0, shinigami_mirror: 0 };
    const grouped = new Map();

    for (const entry of entries) {
      const normalizedSource = normalizeSource(entry.source);
      sourceCounts[normalizedSource] = (sourceCounts[normalizedSource] || 0) + 1;

      const title = String(entry.title || "").trim();
      const chapter = String(entry.chapter || "").trim();
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

      if (family === "ikiru") {
        if (!bucket.ikiru || ts < bucket.ikiru.ts) {
          bucket.ikiru = {
            ts,
            source: normalizedSource,
            sourceLabel: sourceLabel(normalizedSource),
            updatedTime: entry.updatedTime ?? null,
            sentAt: entry.sentAt ?? null,
          };
        }
      } else if (!bucket.shinigami || ts < bucket.shinigami.ts) {
        bucket.shinigami = {
          ts,
          source: normalizedSource,
          sourceLabel: sourceLabel(normalizedSource),
          updatedTime: entry.updatedTime ?? null,
          sentAt: entry.sentAt ?? null,
        };
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

    const payload = {
      summary: {
        totalCompared: comparisons.length,
        ikiruWins,
        shinigamiWins,
        ties,
      },
      sourceCounts,
      comparisons: comparisons.slice(0, 20),
    };

    await redis.set(SOURCE_COMPARE_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[source-compare] Error:", err);
    return res.status(500).json({
      error: "Internal error",
      summary: { totalCompared: 0, ikiruWins: 0, shinigamiWins: 0, ties: 0 },
      sourceCounts: { ikiru: 0, shinigami_project: 0, shinigami_mirror: 0 },
      comparisons: [],
    });
  }
}
