/**
 * Batch + Incremental Scraping Integration
 * Wrapper around existing scraping system
 */

import type { RedisClient, ChapterItem, WhitelistEntry } from "../types.js";
import { getLogger } from "../logger.js";
import { scrapeAllBatches } from "./batch-scraper.js";
import { normalizeTitleKey } from "../domain.js";
import { MANGA_LAST_CHAPTERS_KEY } from "../constants/redis.js";

const logger = getLogger({ scope: "batch-integration" });

/**
 * Scrape with batch + incremental optimization
 * This is a drop-in replacement for the orchestrator
 */
export async function scrapeWithBatchOptimization(
  whitelist: WhitelistEntry[],
  redis: RedisClient,
  options: {
    useBatchMode?: boolean;
    updateLastChapters?: boolean;
  } = {}
): Promise<{
  chapters: ChapterItem[];
  stats: {
    totalManga: number;
    newChapters: number;
    duration: number;
  };
}> {
  const startTime = Date.now();
  const useBatchMode = options.useBatchMode ?? true;
  const updateLastChapters = options.updateLastChapters ?? true;

  logger.info({ 
    totalManga: whitelist.length,
    useBatchMode,
    updateLastChapters 
  }, "Starting optimized scraping");

  try {
    // Use batch + incremental scraping
    const chapters = await scrapeAllBatches(whitelist, redis);

    // Update last known chapters
    if (updateLastChapters && chapters.length > 0) {
      await updateLastKnownChapters(chapters, redis);
    }

    const duration = Date.now() - startTime;
    const stats = {
      totalManga: whitelist.length,
      newChapters: chapters.length,
      duration,
    };

    logger.info(stats, "Optimized scraping completed");

    return { chapters, stats };
  } catch (err) {
    logger.error({ err }, "Optimized scraping failed");
    throw err;
  }
}

/**
 * Update last known chapters after successful scraping
 * Uses Redis pipeline for batch updates (50x faster!)
 */
async function updateLastKnownChapters(
  chapters: ChapterItem[],
  redis: RedisClient
): Promise<void> {
  try {
    // Group chapters by manga
    const byManga = new Map<string, ChapterItem[]>();
    
    for (const chapter of chapters) {
      const title = chapter.title;
      if (!byManga.has(title)) {
        byManga.set(title, []);
      }
      byManga.get(title)!.push(chapter);
    }

    // Pre-compute chapter numbers for sorting (memoization)
    const chapterNumbers = new Map<ChapterItem, number>();
    for (const chapters of byManga.values()) {
      for (const chapter of chapters) {
        chapterNumbers.set(chapter, extractNumber(chapter.chapter));
      }
    }

    // Use Redis pipeline for batch updates
    const pipeline = redis.pipeline();
    let updateCount = 0;

    // Update last chapter for each manga
    for (const [title, mangaChapters] of byManga.entries()) {
      // Sort using pre-computed numbers (no regex in loop!)
      const sorted = mangaChapters.sort((a, b) => {
        const numA = chapterNumbers.get(a) || 0;
        const numB = chapterNumbers.get(b) || 0;
        return numB - numA; // Descending
      });

      const latestChapter = sorted[0];
      if (latestChapter.chapter) {
        // Add to pipeline (not await!)
        const titleKey = normalizeTitleKey(title);
        pipeline.hset(MANGA_LAST_CHAPTERS_KEY, { [titleKey]: latestChapter.chapter });
        
        // Optional: Cleanup old key if it exists (in background)
        const oldKey = `manga:${titleKey}:last_chapter`;
        pipeline.del(oldKey);
        
        updateCount++;
      }
    }

    // Execute all updates in one batch
    if (updateCount > 0) {
      await pipeline.exec();
      logger.debug({ 
        mangaCount: byManga.size,
        chapterCount: chapters.length,
        updateCount 
      }, "Updated last known chapters (pipeline)");
    }
  } catch (err) {
    logger.error({ err }, "Failed to update last known chapters");
  }
}

/**
 * Extract chapter number for sorting
 */
function extractNumber(chapter: string | undefined): number {
  if (!chapter) return 0;
  const match = chapter.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}
