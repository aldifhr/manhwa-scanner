/**
 * Background job logic to pre-fetch metadata for all whitelist manga
 * Refactored into a service module to optimize Serverless Function limits on Vercel Hobby plan
 */

import type { Request, Response } from "express";
import { redis } from "../redis.js";
import { loadWhitelist } from "../services/storage.js";
import { mangaProviderRegistry } from "../providers/registry.js";
import { setMangaMetadata, batchGetMangaMetadata } from "../services/storage.js";
import { normalizeTitleKey, normalizeSource } from "../scrapers/shared.js";
import { getLogger } from "../logger.js";
import { createSuccessResponse, createErrorResponse } from "../api/response.js";
import { isMetadataEmpty } from "../services/metadata-enrichment.js";
import { initializeAllProviders } from "../boot.js";
import { supabase, withSupabaseTimeout } from "../supabase.js";
import pLimit from "p-limit";

const logger = getLogger({ scope: "prefetch-metadata" });

interface PrefetchStats {
  total: number;
  cached: number;
  fetched: number;
  failed: number;
  skipped: number;
  skippedNoProvider: number;
  skippedTimeout: number;
  durationMs: number;
}

/**
 * Pre-fetch metadata for all whitelist manga
 */
export async function handlePrefetchMetadata(req: Request, res: Response) {
  const startTime = Date.now();
  const stats: PrefetchStats = {
    total: 0,
    cached: 0,
    fetched: 0,
    failed: 0,
    skipped: 0,
    skippedNoProvider: 0,
    skippedTimeout: 0,
    durationMs: 0,
  };

  try {
    // Ensure providers are registered before use
    await initializeAllProviders();

    // Get all whitelist items
    const whitelist = await loadWhitelist(redis);
    if (!whitelist || whitelist.length === 0) {
      logger.info("No whitelist items found");
      return res.status(200).json(createSuccessResponse({ 
        message: "No whitelist items",
        stats 
      }));
    }

    logger.info({ count: whitelist.length }, "Starting metadata prefetch for whitelist");

    // Extract unique manga with their sources
    const mangaMap = new Map<string, { titleKey: string; source: string; url: string }>();
    let skippedNoSource = 0;
    
    for (const item of whitelist) {
      const titleKey = normalizeTitleKey(item.title);
      if (!titleKey) continue;

      // Get first available source URL
      let foundSource = false;
      for (const sourceData of item.sources || []) {
        const source = normalizeSource(sourceData.source);
        const url = sourceData.url;
        
        if (source && url && !mangaMap.has(titleKey)) {
          mangaMap.set(titleKey, { titleKey, source, url });
          foundSource = true;
          break;
        }
      }
      
      if (!foundSource && !mangaMap.has(titleKey)) {
        skippedNoSource++;
      }
    }

    stats.total = mangaMap.size;
    logger.info({ 
      total: stats.total, 
      skippedNoSource,
      whitelistCount: whitelist.length 
    }, "Unique manga to process");

    // Support ?force=true to re-fetch all (even cached)
    const forceRefresh = req.query?.force === "true" || (req as any).url?.includes("force=true");

    // Prune orphaned metadata from Supabase
    const titleKeys = Array.from(mangaMap.keys());
    try {
      const { data: dbKeys } = await withSupabaseTimeout(() => 
        supabase.from("manga_metadata").select("title_key")
      );
      if (dbKeys) {
        const orphaned = dbKeys
          .filter(row => !mangaMap.has(row.title_key))
          .map(row => row.title_key);
        
        if (orphaned.length > 0) {
          logger.info({ count: orphaned.length }, "Pruning orphaned metadata from Supabase");
          await withSupabaseTimeout(() => 
            supabase.from("manga_metadata").delete().in("title_key", orphaned)
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to prune orphaned metadata");
    }

    // Check which already have cached metadata
    const cachedMetadata = forceRefresh
      ? titleKeys.map(() => null) // treat all as uncached
      : await batchGetMangaMetadata(redis, titleKeys);
    
    const needsFetch: Array<{ titleKey: string; source: string; url: string }> = [];
    
    cachedMetadata.forEach((meta, index) => {
      const titleKey = titleKeys[index];
      const mangaData = mangaMap.get(titleKey);
      if (!mangaData) return;

      const isRecentlyUpdated = meta?.lastUpdated && (Date.now() - new Date(meta.lastUpdated).getTime() < 24 * 3600000);
      
      // SKIP fetch jika:
      // 1. Data lengkap (!isMetadataEmpty)
      // 2. ATAU Data belum lengkap tapi baru saja di-fetch dalam 24 jam terakhir (biar nggak spam)
      if (!forceRefresh && meta && (!isMetadataEmpty(meta) || isRecentlyUpdated)) {
        stats.cached++;
      } else {
        needsFetch.push(mangaData);
      }
    });

    logger.info({ 
      cached: stats.cached, 
      needsFetch: needsFetch.length 
    }, "Metadata cache status");

    // Log source breakdown
    const sourceBreakdown: Record<string, number> = {};
    needsFetch.forEach(({ source }) => {
      sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;
    });
    logger.info({ sourceBreakdown }, "Sources needing metadata fetch");

    if (needsFetch.length === 0) {
      stats.durationMs = Date.now() - startTime;
      return res.status(200).json(createSuccessResponse({ 
        message: "All metadata already cached",
        stats 
      }));
    }

    // Fetch missing metadata with rate limiting
    const limit = pLimit(5); // 5 concurrent fetches
    const TIMEOUT_MS = 55000; // 55s (within Vercel's 60s max)
    const deadline = Date.now() + TIMEOUT_MS;

    const fetchPromises = needsFetch.map(({ titleKey, source, url }) =>
      limit(async () => {
        // Check deadline
        if (Date.now() > deadline) {
          stats.skipped++;
          stats.skippedTimeout++;
          logger.warn({ titleKey, source }, "Skipped due to timeout");
          return null;
        }

        try {
          const provider = mangaProviderRegistry.getProvider(source);
          if (!provider || !provider.fetchMetadata) {
            logger.warn({ source, titleKey }, "Provider does not support metadata");
            stats.skipped++;
            stats.skippedNoProvider++;
            return null;
          }

          const metadata = await provider.fetchMetadata(url, redis);
          
          if (metadata) {
            await setMangaMetadata(redis, titleKey, metadata);
            stats.fetched++;
            logger.debug({ titleKey, source }, "Metadata fetched and cached");
            return { titleKey, metadata };
          } else {
            stats.failed++;
            return null;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ err: errMsg, titleKey, source }, "Failed to fetch metadata");
          stats.failed++;
          return null;
        }
      })
    );

    await Promise.all(fetchPromises);

    stats.durationMs = Date.now() - startTime;

    logger.info(
      {
        total: stats.total,
        cached: stats.cached,
        fetched: stats.fetched,
        failed: stats.failed,
        skipped: stats.skipped,
        durationMs: stats.durationMs,
      },
      "Metadata prefetch completed"
    );

    return res.status(200).json(createSuccessResponse({
      message: "Metadata prefetch completed",
      stats,
    }));

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg }, "Metadata prefetch failed");
    
    stats.durationMs = Date.now() - startTime;
    
    return res.status(500).json(createErrorResponse("PREFETCH_FAILED", errMsg, { stats }));
  }
}
