import { redis } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";

function normalizeTitle(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function sourceFamily(source = "") {
  return normalizeSource(source) === "ikiru" ? "ikiru" : "shinigami";
}

function sourceLabel(source = "") {
  const s = normalizeSource(source);
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  if (s === "shinigami_project") return "Shinigami (Project)";
  return "Ikiru";
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

  res.setHeader("Cache-Control", "no-store");

  try {
    const raw = await redis.lrange("recent:chapters", 0, 199);
    const entries = Array.isArray(raw) ? raw.filter(Boolean) : [];

    const sourceCounts = { ikiru: 0, shinigami_project: 0, shinigami_mirror: 0 };
    const grouped = new Map();

    for (const entry of entries) {
      const normalizedSource = normalizeSource(entry.source);
      sourceCounts[normalizedSource] = (sourceCounts[normalizedSource] || 0) + 1;

      const title = String(entry.title || "").trim();
      const chapter = String(entry.chapter || "").trim();
      const titleNorm = normalizeTitle(title);
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

    return res.status(200).json({
      summary: {
        totalCompared: comparisons.length,
        ikiruWins,
        shinigamiWins,
        ties,
      },
      sourceCounts,
      comparisons: comparisons.slice(0, 20),
    });
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
