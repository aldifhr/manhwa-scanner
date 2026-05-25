/**
 * Batch Scraper Service
 * Groups manga by source and scrapes efficiently
 */

import type { RedisClient, ChapterItem, WhitelistEntry } from "../types.js";
import { getLogger } from "../logger.js";
import { normalizeSource } from "../scrapers/shared.js";
import { mangaProviderRegistry } from "../providers/registry.js";
import { getLastChaptersBatch } from "./chapter-tracker.js";
import pLimit from "p-limit";

const logger = getLogger({ scope: "batch-scraper" });

interface GroupedManga {
  [source: string]: WhitelistEntry[];
}

/**
 * Group manga by source for batch processing
 */
export function groupBySource(whitelist: WhitelistEntry[]): GroupedManga {
  const grouped: GroupedManga = {};
  const seen = new Set<string>(); // Prevent duplicates

  for (const manga of whitelist) {
    for (const sourceData of manga.sources || []) {
      const source = normalizeSource(sourceData.source);
      const url = sourceData.url;
      
      if (!source || !url) continue;
      
      // Create unique key to prevent duplicates
      const key = `${source}:${manga.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      
      if (!grouped[source]) {
        grouped[source] = [];
      }
      
      grouped[source].push({
        ...manga,
        sources: [{ source, url }], // Single source per entry
      });
    }
  }

  return grouped;
}

/**
 * Scrape a batch of manga from the same source
 */
export async function scrapeBatch(
  source: string,
  mangaList: WhitelistEntry[],
  redis: RedisClient
): Promise<ChapterItem[]> {
  const startTime = Date.now();
  
  logger.info({ 
    source, 
    count: mangaList.length 
  }, "Starting batch scrape");

  try {
    // Get provider
    const provider = mangaProviderRegistry.getProvider(source);
    if (!provider) {
      logger.warn({ source }, "Provider not found");
      return [];
    }

    // Get last known chapters for all manga (batch)
    const titles = mangaList.map(m => m.title);
    const lastChapters = await getLastChaptersBatch(titles, redis);

    // Scrape with parallel processing (rate limited)
    const chapters = await scrapeParallel(
      source,
      provider,
      mangaList,
      lastChapters,
      redis
    );

    const duration = Date.now() - startTime;
    logger.info({ 
      source, 
      count: mangaList.length,
      chapters: chapters.length,
      duration 
    }, "Batch scrape completed");

    return chapters;
  } catch (err) {
    logger.error({ err, source }, "Batch scrape failed");
    return [];
  }
}

/**
 * Scrape manga in parallel with rate limiting
 */
async function scrapeParallel(
  source: string,
  provider: any,
  mangaList: WhitelistEntry[],
  lastChapters: Map<string, string | null>,
  redis: RedisClient
): Promise<ChapterItem[]> {
  const limit = pLimit(5); // 5 concurrent requests
  const allChapters: ChapterItem[] = [];

  const promises = mangaList.map((manga) =>
    limit(async () => {
      try {
        const lastKnown = lastChapters.get(manga.title);
        
        // Create matcher for this manga only
        const preferredMatcher = (title: string) => {
          const normalized = title.toLowerCase().trim();
          const target = manga.title.toLowerCase().trim();
          return normalized === target || normalized.includes(target);
        };

        // Scrape updates
        const result = await provider.scrapeUpdates({
          redis,
          preferredMatcher,
          logger: getLogger({ scope: `batch:${source}` }),
        });

        let chapters = result.results || [];

        // Filter only new chapters (incremental)
        if (lastKnown && chapters.length > 0) {
          const beforeFilter = chapters.length;
          chapters = filterNewChapters(chapters, lastKnown);
          
          if (beforeFilter > chapters.length) {
            logger.debug({ 
              manga: manga.title,
              before: beforeFilter,
              after: chapters.length,
              lastKnown 
            }, "Filtered old chapters");
          }
        }

        return chapters;
      } catch (err) {
        logger.error({ 
          err, 
          manga: manga.title,
          source 
        }, "Failed to scrape manga in batch");
        return [];
      }
    })
  );

  const results = await Promise.all(promises);
  
  for (const chapters of results) {
    allChapters.push(...chapters);
  }

  return allChapters;
}

/**
 * Filter chapters newer than lastKnown
 */
function filterNewChapters(
  chapters: ChapterItem[],
  lastKnown: string
): ChapterItem[] {
  return chapters.filter(ch => {
    if (!ch.chapter) return false;
    
    const chapterNum = extractChapterNumber(ch.chapter);
    const lastNum = extractChapterNumber(lastKnown);
    
    if (chapterNum === null || lastNum === null) {
      // Fallback to string comparison
      return ch.chapter > lastKnown;
    }
    
    return chapterNum > lastNum;
  });
}

/**
 * Extract chapter number from string
 */
function extractChapterNumber(chapter: string): number | null {
  const match = chapter.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Scrape all sources in batches
 */
export async function scrapeAllBatches(
  whitelist: WhitelistEntry[],
  redis: RedisClient
): Promise<ChapterItem[]> {
  const startTime = Date.now();
  
  // Group by source
  const grouped = groupBySource(whitelist);
  const sources = Object.keys(grouped);
  
  logger.info({ 
    totalManga: whitelist.length,
    sources: sources.length,
    breakdown: Object.entries(grouped).map(([source, list]) => ({
      source,
      count: list.length
    }))
  }, "Starting batch scraping for all sources");

  const allChapters: ChapterItem[] = [];

  // Scrape each source batch in parallel
  const batchPromises = Object.entries(grouped).map(async ([source, mangaList]) => {
    return scrapeBatch(source, mangaList, redis);
  });

  const results = await Promise.all(batchPromises);
  for (const chapters of results) {
    allChapters.push(...chapters);
  }

  const duration = Date.now() - startTime;
  logger.info({ 
    totalManga: whitelist.length,
    sources: sources.length,
    chapters: allChapters.length,
    duration 
  }, "All batch scraping completed");

  return allChapters;
}
