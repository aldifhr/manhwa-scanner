import { ChapterItem, RedisClient } from "../../types.js";
import { normalizeChapterIdentity } from "../../domain.js";
import { fetchIkiruChapters, fetchIkiruMetadata } from "../../scrapers/ikiru/index.js";
import { MANGA_METADATA_CACHE_PREFIX } from "../../constants/redis.js";

export interface IkiruMetaCacheEntry {
  byChapter: Map<string, ChapterItem>;
  fallback: ChapterItem | null;
}

export function isIkiruSource(source = ""): boolean {
  return String(source || "").toLowerCase() === "ikiru";
}

function isMissingStatus(status = ""): boolean {
  const s = String(status || "").trim().toLowerCase();
  return !s || s === "unknown" || s === "n/a" || s === "ongoing"; // "Ongoing" is the default, if it's the only thing we have, might be worth re-checking
}

function isMissingRating(rating = ""): boolean {
  const r = String(rating || "").trim().toLowerCase();
  return !r || r === "n/a" || r === "unknown" || r === "0" || r === "0/10" || r === "0.0";
}

function isMissingDescription(description = ""): boolean {
  const d = String(description || "").trim().toLowerCase();
  return !d || d === "unknown" || d === "n/a" || d.length < 10;
}

function isChapterItem(obj: unknown): obj is ChapterItem {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "title" in obj &&
    typeof (obj as { title: unknown }).title === "string" &&
    "source" in obj &&
    typeof (obj as { source: unknown }).source === "string"
  );
}

function parseMetaCacheEntry(parsed: unknown): IkiruMetaCacheEntry {
  if (!parsed || typeof parsed !== "object") {
    return { byChapter: new Map(), fallback: null };
  }
  const p = parsed as { byChapter?: Record<string, unknown>; fallback?: unknown };
  const byChapter = new Map<string, ChapterItem>();
  if (p.byChapter && typeof p.byChapter === "object") {
    Object.entries(p.byChapter).forEach(([key, value]) => {
      if (isChapterItem(value)) {
        byChapter.set(key, value);
      }
    });
  }
  const fallback = isChapterItem(p.fallback) ? p.fallback : null;
  return { byChapter, fallback };
}

export async function hydrateIkiruMetadataIfMissing(
  item: ChapterItem,
  redisClient: RedisClient,
  ikiruMetaCache: Map<string, IkiruMetaCacheEntry>,
  deadline?: number,
): Promise<ChapterItem> {
  if (!item || !isIkiruSource(item.source)) return item;
  if (
    !isMissingStatus(item.status || "") && 
    !isMissingRating(item.rating || "") && 
    !isMissingDescription(item.description || "")
  ) {
    return item;
  }

  const mangaUrl = String(item.mangaUrl || "").trim();
  if (!mangaUrl) return item;

  let cached = ikiruMetaCache.get(mangaUrl);

  if (!cached) {
    try {
      const redisKey = `${MANGA_METADATA_CACHE_PREFIX}${mangaUrl}`;
      const saved = await redisClient.get(redisKey);
      if (saved) {
        const parsed = JSON.parse(saved as string);
        cached = parseMetaCacheEntry(parsed);
        ikiruMetaCache.set(mangaUrl, cached);
      }
    } catch {
      // Redis fail safe
    }
  }

  if (!cached && deadline && Date.now() > deadline - 2000) {
    return item;
  }

  if (!cached) {
    const rows = await fetchIkiruChapters(mangaUrl);
    const byChapter = new Map<string, ChapterItem>();
    const forRedis: Record<string, ChapterItem> = {};

    for (const row of rows) {
      const chapterKey = normalizeChapterIdentity(row?.chapter);
      if (chapterKey && !byChapter.has(chapterKey)) {
        byChapter.set(chapterKey, row);
        forRedis[chapterKey] = row;
      }
    }
    cached = { byChapter, fallback: rows[0] || null };
    ikiruMetaCache.set(mangaUrl, cached);

    try {
      const redisKey = `${MANGA_METADATA_CACHE_PREFIX}${mangaUrl}`;
      await redisClient.set(
        redisKey,
        JSON.stringify({ byChapter: forRedis, fallback: cached.fallback, cachedAt: Date.now() }),
        { ex: 86400 },
      );
    } catch {
      // Redis fail safe
    }
  }

  const chapterKey = normalizeChapterIdentity(item.chapter);
  const match = (chapterKey && cached.byChapter.get(chapterKey)) || cached.fallback;
  if (!match) {
    // If no match found in chapters but we need metadata, try fetching direct metadata
    try {
      const raw = await fetchIkiruMetadata(mangaUrl);
      if (raw) {
        return {
          ...item,
          status: isMissingStatus(item.status || "") ? (raw.status || item.status) : item.status,
          rating: isMissingRating(item.rating || "") ? (raw.rating || item.rating) : item.rating,
          cover: item.cover || raw.cover || null,
          description: item.description || raw.description || null,
        };
      }
    } catch {
      // Fallback to original item
    }
    return item;
  }

  return {
    ...item,
    status: isMissingStatus(item.status || "") ? (match.status || item.status) : item.status,
    rating: isMissingRating(item.rating || "") ? (match.rating || item.rating) : item.rating,
    cover: item.cover || match.cover || null,
    description: item.description || match.description || null,
  };
}

export async function batchPreHydrateMetadata(
  items: ChapterItem[],
  redisClient: RedisClient,
  ikiruMetaCache: Map<string, IkiruMetaCacheEntry>,
): Promise<void> {
  const ikiruItems = items.filter(
    (i) => isIkiruSource(i.source) && (
      isMissingStatus(i.status || "") || 
      isMissingRating(i.rating || "") || 
      isMissingDescription(i.description || "")
    ),
  );
  const uniqueUrls = [...new Set(ikiruItems.map((i) => i.mangaUrl).filter(Boolean))] as string[];
  if (uniqueUrls.length === 0) return;

  const pipeline = redisClient.pipeline();
  uniqueUrls.forEach((url) => pipeline.get(`${MANGA_METADATA_CACHE_PREFIX}${url}`));

  const results = await pipeline.exec();
  results?.forEach((saved: unknown, index: number) => {
    if (saved && index < uniqueUrls.length) {
      const url = uniqueUrls[index];
      const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
      ikiruMetaCache.set(url, parseMetaCacheEntry(parsed));
    }
  });
}
