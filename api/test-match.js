import { isCronAuthorized } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { scrapeMangaUpdates } from "../lib/scraper.js";
import { logApiHit } from "../lib/requestLog.js";

const SCRAPE_CACHE_TTL_MS = 60 * 1000;
let scrapeCache = {
  data: null,
  expiresAt: 0,
  inFlight: null,
};

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

function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function createWhitelistMatcher(entry) {
  const normalizedUrl = entry.url ? normalizeUrl(entry.url) : null;
  const normalizedTitle = entry.title ? normalizeTitle(entry.title) : null;
  const normalizedSource = normalizeSource(entry.source);

  return (item) => {
    const itemUrl = item.mangaUrl ? normalizeUrl(item.mangaUrl) : null;
    const itemSource = normalizeSource(item.source);
    if (itemSource !== normalizedSource) return false;
    if (normalizedUrl) return itemUrl === normalizedUrl;

    if (!normalizedTitle) return false;
    const itemTitle = normalizeTitle(item.title);
    return (
      itemTitle === normalizedTitle ||
      itemTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(itemTitle)
    );
  };
}

async function getCachedScrapeResults() {
  const now = Date.now();
  if (Array.isArray(scrapeCache.data) && scrapeCache.expiresAt > now) {
    return { items: scrapeCache.data, cached: true };
  }

  if (scrapeCache.inFlight) {
    const items = await scrapeCache.inFlight;
    return { items, cached: true };
  }

  scrapeCache.inFlight = (async () => {
    const items = await scrapeMangaUpdates(redis);
    scrapeCache.data = items;
    scrapeCache.expiresAt = Date.now() + SCRAPE_CACHE_TTL_MS;
    return items;
  })();

  try {
    const items = await scrapeCache.inFlight;
    return { items, cached: false };
  } finally {
    scrapeCache.inFlight = null;
  }
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
    const source = req.body?.source?.trim() || "ikiru";

    if (!title && !url) {
      return res.status(400).json({ error: "title atau url wajib diisi" });
    }

    const entry = { title: title || null, url: url || null, source };
    const isMatched = createWhitelistMatcher(entry);
    const { items: allResults, cached } = await getCachedScrapeResults();
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
      cache: {
        hit: cached,
        ttlMs: SCRAPE_CACHE_TTL_MS,
      },
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
