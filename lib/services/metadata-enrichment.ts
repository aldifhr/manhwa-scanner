/**
 * Metadata Enrichment Service
 * Optimized batch metadata fetching to reduce API calls and improve performance
 */

import { RedisClient, ChapterItem, MangaMetadata } from "../types.js";
import { normalizeSource, normalizeText } from "../scrapers/shared.js";
import { mangaProviderRegistry } from "../providers/registry.js";
import { setMangaMetadata, loadWhitelist, batchGetMangaMetadata } from "./storage.js";
import { normalizeTitleKey } from "../domain.js";
import { getLogger } from "../logger.js";
import pLimit from "p-limit";

const logger = getLogger({ scope: "metadata-enrichment" });

interface EnrichmentTask {
  titleKey: string;
  chapter: ChapterItem;
  source: string;
  mangaUrl: string;
}

interface EnrichmentResult {
  titleKey: string;
  metadata: MangaMetadata | null;
  error?: string;
}

interface EnrichmentStats {
  total: number;
  cached: number;
  fetched: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Check if metadata is effectively empty or incomplete
 * Returns true if any essential field is missing/unknown → triggers re-fetch
 */
export function isMetadataEmpty(meta: MangaMetadata | null): boolean {
  if (!meta) return true;

  const hasDescription = !!(meta.description || (meta as any).synopsis);
  const hasRating = !!(
    meta.rating &&
    meta.rating !== "N/A" &&
    meta.rating !== "0" &&
    meta.rating !== "0.0" &&
    /\d/.test(meta.rating) // Harus ada angka
  );
  const hasStatus = !!(
    meta.status &&
    meta.status !== "Unknown" &&
    meta.status !== "unknown"
  );

  // RE-FETCH LOGIC:
  // 1. Jika status Unknown atau TIDAK ADA (data lama) -> WAJIB fetch
  if (!hasStatus || meta.status?.toLowerCase() === "unknown") return true;

  // 2. Jika deskripsi ada dan valid -> SUDAH CUKUP (Jangan anggap empty)
  if (hasDescription && meta.description !== "Unknown") return false;

  // 3. Jika deskripsi kosong -> fetch (mungkin data belum lengkap)
  if (!hasDescription || meta.description === "Unknown") return true;

  // 4. Jika rating kosong (benar-benar tidak ada string angka) -> fetch
  // Tapi jika rating "0" atau "N/A" tapi ada deskripsi (sudah dicek di atas), kita anggap cukup
  if (!hasRating && meta.rating !== "0" && meta.rating !== "N/A") return true;

  return false;
}

/**
 * Group chapters by source for batch processing
 */
function groupChaptersBySource(chapters: ChapterItem[]): Map<string, EnrichmentTask[]> {
  const grouped = new Map<string, EnrichmentTask[]>();
  const seenKeys = new Set<string>();

  for (const ch of chapters) {
    const source = normalizeSource(ch.source) || "unknown";
    const titleKey = (ch as ChapterItem & { titleKey?: string }).titleKey;
    const mangaUrl = ch.mangaUrl || "";

    if (!titleKey || !mangaUrl) continue;

    // Deduplicate by titleKey to save fetch budget
    if (seenKeys.has(titleKey)) continue;
    seenKeys.add(titleKey);

    if (!grouped.has(source)) {
      grouped.set(source, []);
    }

    grouped.get(source)!.push({
      titleKey,
      chapter: ch,
      source,
      mangaUrl,
    });
  }

  return grouped;
}

/**
 * Attempt to find metadata from a fallback source (Ikiru) if the primary source (Shinigami) fails
 */
async function fetchFallbackMetadata(title: string, redis: RedisClient | null): Promise<MangaMetadata | null> {
  try {
    const ikiru = mangaProviderRegistry.getProvider("ikiru");
    if (!ikiru || !ikiru.search || !ikiru.fetchMetadata) return null;

    logger.info({ title }, "Attempting fallback metadata search on Ikiru...");
    const searchResults = await ikiru.search(title, redis);
    
    if (searchResults.success && searchResults.data && searchResults.data.length > 0) {
      // Find the best match
      const bestMatch = searchResults.data[0]; // Assuming first result is best for now
      if (bestMatch.mangaUrl) {
        logger.info({ title, ikiruUrl: bestMatch.mangaUrl }, "Found fallback match on Ikiru, fetching details...");
        return await ikiru.fetchMetadata(bestMatch.mangaUrl, redis);
      }
    }
  } catch (err) {
    logger.warn({ title, err: err instanceof Error ? err.message : String(err) }, "Fallback metadata search failed");
  }
  return null;
}

/**
 * Batch fetch metadata for multiple chapters from same source
 * Providers can override this for more efficient batch fetching
 */
async function batchFetchMetadataForSource(
  tasks: EnrichmentTask[],
  redis: RedisClient | null,
  deadline?: number
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = [];
  const source = tasks[0]?.source;

  if (!source) return results;

  const provider = mangaProviderRegistry.getProvider(source);
  if (!provider || !provider.fetchMetadata) {
    logger.warn({ source, count: tasks.length }, "Provider does not support metadata fetching");
    return tasks.map(t => ({ titleKey: t.titleKey, metadata: null, error: "Provider not found" }));
  }

  // Use individual fetching with concurrency control
  const limit = pLimit(tasks.length > 10 ? 8 : 4); 
  const fetchPromises = tasks.map(task => 
    limit(async (): Promise<EnrichmentResult> => {
      if (deadline && Date.now() > deadline) {
        return { titleKey: task.titleKey, metadata: null, error: "Deadline exceeded" };
      }

      try {
        let meta = await provider.fetchMetadata!(task.mangaUrl, redis);
        
        // CROSS-SOURCE FALLBACK: If Shinigami metadata is empty/zero rating, try Ikiru
        if (source === "shinigami" && isMetadataEmpty(meta)) {
          const fallbackMeta = await fetchFallbackMetadata(task.chapter.title || "", redis);
          if (fallbackMeta && !isMetadataEmpty(fallbackMeta)) {
            logger.info({ title: task.chapter.title }, "Successfully used Ikiru fallback for Shinigami title");
            meta = {
                ...meta!,
                ...fallbackMeta,
                // Keep original source URL but use new metadata
                source: "shinigami" 
            };
          }
        }

        return { titleKey: task.titleKey, metadata: meta };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { titleKey: task.titleKey, metadata: null, error: errMsg };
      }
    })
  );

  return Promise.all(fetchPromises);
}

/**
 * Enrich chapters with metadata in optimized batches
 */
export async function enrichChaptersMetadata(
  chapters: ChapterItem[],
  metadataMap: Map<string, MangaMetadata>,
  redis: RedisClient | null,
  options: {
    maxFetches?: number;
    deadline?: number;
    safetyMarginMs?: number;
  } = {}
): Promise<EnrichmentStats> {
  const startTime = Date.now();
  const {
    maxFetches = 30,  // Increased from 10 to 30 for better coverage
    deadline,
    safetyMarginMs = 4000,
  } = options;

  const stats: EnrichmentStats = {
    total: 0,
    cached: 0,
    fetched: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  };

  // Filter chapters that need metadata
  const chaptersNeedingMetadata = chapters.filter(ch => {
    const titleKey = (ch as ChapterItem & { titleKey?: string }).titleKey;
    if (!titleKey) return false;
    
    const cached = metadataMap.get(titleKey);
    if (cached && !isMetadataEmpty(cached)) {
      stats.cached++;
      return false;
    }
    
    return true;
  });

  stats.total = chaptersNeedingMetadata.length;

  if (stats.total === 0) {
    stats.durationMs = Date.now() - startTime;
    return stats;
  }

  // Check deadline
  if (deadline && Date.now() > deadline - safetyMarginMs) {
    logger.warn({ total: stats.total }, "Skipping metadata enrichment due to deadline");
    stats.skipped = stats.total;
    stats.durationMs = Date.now() - startTime;
    return stats;
  }

  // Group by source for efficient batch processing
  const groupedBySource = groupChaptersBySource(chaptersNeedingMetadata);
  
  logger.info(
    { 
      total: stats.total, 
      sources: groupedBySource.size,
      maxFetches 
    },
    "Starting batch metadata enrichment"
  );

  // Limit total fetches across all sources
  let remainingFetches = maxFetches;
  const allResults: EnrichmentResult[] = [];

  for (const [source, tasks] of groupedBySource.entries()) {
    if (remainingFetches <= 0) {
      logger.info({ skipped: tasks.length, source }, "Reached max fetch limit, skipping remaining");
      stats.skipped += tasks.length;
      continue;
    }

    // Check deadline before each source
    if (deadline && Date.now() > deadline - safetyMarginMs) {
      logger.warn({ skipped: tasks.length, source }, "Deadline approaching, skipping source");
      stats.skipped += tasks.length;
      continue;
    }

    const tasksToFetch = tasks.slice(0, remainingFetches);
    const skippedTasks = tasks.length - tasksToFetch.length;

    if (skippedTasks > 0) {
      logger.info({ skipped: skippedTasks, source }, "Limiting fetches for source");
      stats.skipped += skippedTasks;
    }

    try {
      const results = await batchFetchMetadataForSource(tasksToFetch, redis, deadline);
      allResults.push(...results);
      remainingFetches -= tasksToFetch.length;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg, source, count: tasksToFetch.length }, "Source batch fetch failed");
      stats.failed += tasksToFetch.length;
    }
  }

  // Save results to Supabase and update map
  let hasUpdates = false;
  const saveTasks = allResults.map(async (result) => {
    if (result.metadata && !isMetadataEmpty(result.metadata)) {
      const existing = metadataMap.get(result.titleKey);
      const newMeta = { ...result.metadata };

      // PROTECTION: Jangan timpa status/rating yang sudah benar dengan "Unknown" atau "N/A"
      if (existing) {
        if ((!newMeta.status || newMeta.status === "Unknown") && existing.status && existing.status !== "Unknown") {
          newMeta.status = existing.status;
        }
        if ((!newMeta.rating || newMeta.rating === "N/A") && existing.rating && existing.rating !== "N/A") {
          newMeta.rating = existing.rating;
        }
      }

      metadataMap.set(result.titleKey, newMeta as MangaMetadata);
      
      // Save to Supabase (and Redis cache via setMangaMetadata)
      await setMangaMetadata(redis || ({} as any), result.titleKey, newMeta);
      hasUpdates = true;
      stats.fetched++;
    } else if (result.error) {
      stats.failed++;
    } else if (result.metadata && isMetadataEmpty(result.metadata)) {
      // We got metadata but it's empty, don't cache but count as processed to avoid retry loop in same run
      metadataMap.set(result.titleKey, result.metadata);
      stats.fetched++;
      logger.debug({ titleKey: result.titleKey }, "Fetched empty metadata, skipping cache");
    }
  });

  await Promise.all(saveTasks);

  stats.durationMs = Date.now() - startTime;

  logger.info(
    {
      ...stats,
      efficiency: stats.total > 0 ? Math.round((stats.fetched / stats.total) * 100) : 0,
    },
    "Metadata enrichment completed"
  );

  return stats;
}

/**
 * Apply enriched metadata to chapters
 */
export function applyMetadataToChapters(
  chapters: ChapterItem[],
  metadataMap: Map<string, MangaMetadata>
): void {
  for (const ch of chapters) {
    const titleKey = (ch as ChapterItem & { titleKey?: string }).titleKey;
    if (titleKey) {
      const meta = metadataMap.get(titleKey);
      if (meta) {
        ch.metadata = meta;
        
        // Populate top-level fields for easier access in dispatcher/embeds
        if (!ch.status || ch.status === "Unknown") ch.status = meta.status;
        if (!ch.rating || ch.rating === "N/A" || ch.rating === "0") ch.rating = meta.rating;
        if (!ch.description || ch.description === "Unknown") ch.description = meta.description;
        if (!ch.cover) ch.cover = meta.cover;
        if (!ch.genres || ch.genres.length === 0) ch.genres = meta.genres;
      }
    }
  }
}

/**
 * Enrich a single manga title with metadata
 * Useful for on-demand enrichment when adding to whitelist
 */
export async function enrichSingleMangaMetadata(
  titleKey: string,
  title: string,
  source: string,
  mangaUrl: string,
  redis: RedisClient | null
): Promise<MangaMetadata | null> {
  try {
    const provider = mangaProviderRegistry.getProvider(source);
    if (!provider || !provider.fetchMetadata) {
      logger.warn({ source, title }, "Provider does not support metadata fetching");
      return null;
    }

    logger.info({ title, source }, "Enriching single manga metadata");
    logger.info({ title, source, url: mangaUrl }, "Starting single manga metadata enrichment...");
    let meta = await provider.fetchMetadata(mangaUrl, redis);

    // CROSS-SOURCE FALLBACK
    if (source === "shinigami" && isMetadataEmpty(meta)) {
      const fallbackMeta = await fetchFallbackMetadata(title, redis);
      if (fallbackMeta && !isMetadataEmpty(fallbackMeta)) {
        logger.info({ title }, "Successfully used Ikiru fallback for Shinigami title (on-demand)");
        meta = {
          ...meta!,
          ...fallbackMeta,
          source: "shinigami"
        };
      }
    }

    if (meta) {
      // Ensure title is present (some providers might omit it)
      if (!meta.title) {
        meta.title = title;
      }
      
      // Clean title and description again just in case
      meta.title = normalizeText(meta.title);
      if (meta.description) meta.description = normalizeText(meta.description);

      // Don't save if it's still effectively empty (unless we have nothing else)
      if (!isMetadataEmpty(meta)) {
        await setMangaMetadata(redis || ({} as any), titleKey, meta);
        logger.info({ title: meta.title, titleKey }, "Metadata successfully enriched and saved to Supabase");
      } else {
        logger.warn({ title, titleKey }, "Enrichment returned empty or invalid metadata, skipping save");
      }
      return meta;
    }
    
    logger.warn({ title, titleKey }, "Enrichment failed: Provider returned null");
    return null;
  } catch (err) {
    logger.warn({ title, err: err instanceof Error ? err.message : String(err) }, "Failed single manga metadata enrichment");
  }
  return null;
}

/**
 * Pre-warm metadata cache for all whitelist entries that have missing or incomplete metadata.
 * Fetches up to a specified maximum number of entries to prevent rate-limiting or long execution.
 */
export async function prewarmMetadataCache(
  redis: RedisClient | null,
  maxFetches = 10
): Promise<{ checked: number; enriched: number; failed: number }> {
  const startTime = Date.now();
  logger.info("Starting metadata cache pre-warming process...");

  let whitelist;
  try {
    whitelist = await loadWhitelist(redis || ({} as any));
  } catch (err) {
    logger.error({ err }, "Failed to load whitelist for metadata pre-warming");
    return { checked: 0, enriched: 0, failed: 0 };
  }

  if (!whitelist || whitelist.length === 0) {
    logger.info("Whitelist is empty, skipping pre-warming");
    return { checked: 0, enriched: 0, failed: 0 };
  }

  // Map entries to their title keys
  const whitelistMap = new Map(
    whitelist
      .map(entry => {
        const titleKey = normalizeTitleKey(entry.title || "");
        return titleKey ? [titleKey, entry] : null;
      })
      .filter((pair): pair is [string, typeof whitelist[0]] => pair !== null)
  );

  const titleKeys = Array.from(whitelistMap.keys());
  let cachedMetadataList: (MangaMetadata | null)[];
  try {
    cachedMetadataList = await batchGetMangaMetadata(redis || ({} as any), titleKeys);
  } catch (err) {
    logger.error({ err }, "Failed to batch get existing metadata for pre-warming");
    return { checked: titleKeys.length, enriched: 0, failed: 0 };
  }

  // Filter keys that need enrichment
  const keysNeedingEnrichment: { titleKey: string; title: string; source: string; url: string }[] = [];
  for (let i = 0; i < titleKeys.length; i++) {
    const titleKey = titleKeys[i];
    const entry = whitelistMap.get(titleKey)!;
    const cached = cachedMetadataList[i];
    
    if (isMetadataEmpty(cached)) {
      // Find the first source that has a valid URL
      const sourceWithUrl = entry.sources?.find(s => s.url && s.source);
      if (sourceWithUrl && sourceWithUrl.url) {
        keysNeedingEnrichment.push({
          titleKey,
          title: entry.title || "",
          source: sourceWithUrl.source,
          url: sourceWithUrl.url,
        });
      }
    }
  }

  logger.info(
    { totalWhitelist: whitelist.length, needingEnrichment: keysNeedingEnrichment.length, limit: maxFetches },
    "Identified titles needing metadata enrichment"
  );

  if (keysNeedingEnrichment.length === 0) {
    logger.info("All whitelist entries have warm metadata caches!");
    return { checked: titleKeys.length, enriched: 0, failed: 0 };
  }

  // Fetch only up to the limit to prevent timeouts
  const tasksToFetch = keysNeedingEnrichment.slice(0, maxFetches);
  const limit = pLimit(3); // Moderate concurrency to prevent hammering providers
  
  let enrichedCount = 0;
  let failedCount = 0;

  const enrichmentPromises = tasksToFetch.map(task =>
    limit(async () => {
      try {
        const meta = await enrichSingleMangaMetadata(
          task.titleKey,
          task.title,
          task.source,
          task.url,
          redis
        );
        if (meta && !isMetadataEmpty(meta)) {
          enrichedCount++;
        } else {
          failedCount++;
        }
      } catch (err) {
        logger.error({ title: task.title, err }, "Failed to enrich metadata during pre-warming");
        failedCount++;
      }
    })
  );

  await Promise.all(enrichmentPromises);

  logger.info(
    {
      checked: titleKeys.length,
      needingEnrichment: keysNeedingEnrichment.length,
      enriched: enrichedCount,
      failed: failedCount,
      durationMs: Date.now() - startTime,
    },
    "Metadata cache pre-warming finished"
  );

  return {
    checked: titleKeys.length,
    enriched: enrichedCount,
    failed: failedCount,
  };
}
