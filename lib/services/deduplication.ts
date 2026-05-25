/**
 * Optimized Deduplication Service
 * Uses MGET for batch checking (90% faster)
 */

import type { RedisClient, ChapterItem } from "../types.js";
import { getLogger } from "../logger.js";
import { normalizeTitleKey } from "../domain.js";

const logger = getLogger({ scope: "dedup" });

// Key prefix for sent chapters
const SENT_PREFIX = "sent:";

/**
 * Generate Redis key for a chapter
 */
function getChapterKey(chapter: ChapterItem): string {
  const titleKey = normalizeTitleKey(chapter.title);
  const chapterKey = chapter.chapter?.replace(/[^a-z0-9]/gi, "_") || "unknown";
  return `${SENT_PREFIX}${titleKey}:${chapterKey}`;
}

/**
 * Check if chapters were already sent (batch MGET)
 * Returns only NEW chapters (not sent before)
 */
export async function filterUnsentChapters(
  chapters: ChapterItem[],
  redis: RedisClient
): Promise<{
  unsent: ChapterItem[];
  duplicates: ChapterItem[];
  stats: {
    total: number;
    unsent: number;
    duplicates: number;
    duration: number;
  };
}> {
  const startTime = Date.now();
  
  if (chapters.length === 0) {
    return {
      unsent: [],
      duplicates: [],
      stats: { total: 0, unsent: 0, duplicates: 0, duration: 0 },
    };
  }

  try {
    // Generate all keys
    const keys = chapters.map(ch => getChapterKey(ch));
    
    // Batch check with MGET (one Redis call!)
    const results = await redis.mget(...keys);
    
    // Filter based on results
    const unsent: ChapterItem[] = [];
    const duplicates: ChapterItem[] = [];
    
    for (let i = 0; i < chapters.length; i++) {
      if (results[i] === null) {
        // Not sent before
        unsent.push(chapters[i]);
      } else {
        // Already sent
        duplicates.push(chapters[i]);
      }
    }

    const duration = Date.now() - startTime;
    const stats = {
      total: chapters.length,
      unsent: unsent.length,
      duplicates: duplicates.length,
      duration,
    };

    logger.debug(stats, "Deduplication completed (MGET)");

    return { unsent, duplicates, stats };
  } catch (err) {
    logger.error({ err }, "Deduplication failed, returning all chapters");
    
    // On error, return all chapters as unsent (safe fallback)
    return {
      unsent: chapters,
      duplicates: [],
      stats: {
        total: chapters.length,
        unsent: chapters.length,
        duplicates: 0,
        duration: Date.now() - startTime,
      },
    };
  }
}

/**
 * Mark chapters as sent (batch pipeline)
 */
export async function markChaptersAsSent(
  chapters: ChapterItem[],
  redis: RedisClient,
  ttl: number = 30 * 24 * 60 * 60 // 30 days
): Promise<void> {
  if (chapters.length === 0) return;

  try {
    const pipeline = redis.pipeline();
    
    for (const chapter of chapters) {
      const key = getChapterKey(chapter);
      const value = String(Date.now());
      
      // Set with TTL
      pipeline.set(key, value, { ex: ttl });
    }

    await pipeline.exec();
    
    logger.debug({ 
      count: chapters.length,
      ttl 
    }, "Marked chapters as sent (pipeline)");
  } catch (err) {
    logger.error({ err }, "Failed to mark chapters as sent");
  }
}

/**
 * Check if a single chapter was sent
 */
export async function isChapterSent(
  chapter: ChapterItem,
  redis: RedisClient
): Promise<boolean> {
  try {
    const key = getChapterKey(chapter);
    const result = await redis.get(key);
    return result !== null;
  } catch (err) {
    logger.error({ err }, "Failed to check if chapter was sent");
    return false; // Assume not sent on error
  }
}

/**
 * Clear sent history for a manga
 */
export async function clearSentHistory(
  mangaTitle: string,
  redis: RedisClient
): Promise<number> {
  try {
    const titleKey = normalizeTitleKey(mangaTitle);
    const pattern = `${SENT_PREFIX}${titleKey}:*`;
    
    // Scan for keys
    let cursor = "0";
    let deletedCount = 0;
    
    do {
      const result = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = result[0];
      const keys = result[1];
      
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== "0");

    logger.info({ 
      mangaTitle,
      deletedCount 
    }, "Cleared sent history");

    return deletedCount;
  } catch (err) {
    logger.error({ err, mangaTitle }, "Failed to clear sent history");
    return 0;
  }
}
