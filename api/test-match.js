import { isCronAuthorized } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { scrapeMangaUpdates } from "../lib/scraper.js";
import { logApiHit } from "../lib/requestLog.js";

function normalizeTitle(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url = "") {
  return String(url).replace(/\/+$/, "").toLowerCase().trim();
}

function createWhitelistMatcher(entry) {
  const normalizedUrl = entry.url ? normalizeUrl(entry.url) : null;
  const normalizedTitle = entry.title ? normalizeTitle(entry.title) : null;

  return (item) => {
    const itemUrl = item.mangaUrl ? normalizeUrl(item.mangaUrl) : null;
    if (normalizedUrl && itemUrl === normalizedUrl) return true;

    if (!normalizedTitle) return false;
    const itemTitle = normalizeTitle(item.title);
    return (
      itemTitle === normalizedTitle ||
      itemTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(itemTitle)
    );
  };
}

export default async function handler(req, res) {
  logApiHit("test-match", req);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const title = req.body?.title?.trim() || "";
    const url = req.body?.url?.trim() || "";

    if (!title && !url) {
      return res.status(400).json({ error: "title atau url wajib diisi" });
    }

    const entry = { title: title || null, url: url || null };
    const isMatched = createWhitelistMatcher(entry);
    const allResults = await scrapeMangaUpdates(redis);
    const matches = allResults.filter(isMatched);

    const normalizedInputUrl = url ? normalizeUrl(url) : null;
    const normalizedInputTitle = title ? normalizeTitle(title) : null;

    const byUrlCount = normalizedInputUrl
      ? allResults.filter((x) => normalizeUrl(x.mangaUrl || "") === normalizedInputUrl).length
      : 0;

    const byTitleCount = normalizedInputTitle
      ? allResults.filter((x) => {
          const t = normalizeTitle(x.title);
          return t === normalizedInputTitle || t.includes(normalizedInputTitle);
        }).length
      : 0;

    return res.status(200).json({
      ok: true,
      input: entry,
      scraped: allResults.length,
      matched: matches.length,
      diagnostics: {
        byUrlCount,
        byTitleCount,
      },
      sample: matches.slice(0, 20).map((x) => ({
        title: x.title,
        chapter: x.chapter,
        mangaUrl: x.mangaUrl,
        chapterUrl: x.url,
        updatedTime: x.updatedTime ?? null,
      })),
    });
  } catch (err) {
    console.error("[test-match] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

