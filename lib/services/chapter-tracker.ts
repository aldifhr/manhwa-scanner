/**
 * Chapter Tracker Service
 * Tracks last known chapter for incremental scraping
 */

import type { RedisClient } from "../types.js";
import { getLogger } from "../logger.js";
import { normalizeTitleKey } from "../domain.js";
import { MANGA_LAST_CHAPTERS_KEY } from "../constants/redis.js";

const logger = getLogger({ scope: "chapter-tracker" });

/**
 * Get last known chapter for a manga
 */
export async function getLastChapter(
  mangaTitle: string,
  redis: RedisClient
): Promise<string | null> {
  try {
    const titleKey = normalizeTitleKey(mangaTitle);
    
    // 1. Try new Hash first
    const lastChapter = await redis.hget(MANGA_LAST_CHAPTERS_KEY, titleKey);
    if (lastChapter) return lastChapter as string;
    
    // 2. Fallback to old key (lazy migration)
    const oldKey = `manga:${titleKey}:last_chapter`;
    const oldVal = await redis.get(oldKey);
    
    if (oldVal) {
      // Migrate to new Hash in background
      redis.hset(MANGA_LAST_CHAPTERS_KEY, { [titleKey]: oldVal }).catch(() => {});
      return oldVal as string;
    }
    
    return null;
  } catch (err) {
    logger.error({ err, mangaTitle }, "Failed to get last chapter");
    return null;
  }
}

/**
 * Set last known chapter for a manga
 */
export async function setLastChapter(
  mangaTitle: string,
  chapter: string,
  redis: RedisClient
): Promise<void> {
  try {
    const titleKey = normalizeTitleKey(mangaTitle);
    await redis.hset(MANGA_LAST_CHAPTERS_KEY, { [titleKey]: chapter });
    
    // Optional: Cleanup old key if it exists
    const oldKey = `manga:${titleKey}:last_chapter`;
    redis.del(oldKey).catch(() => {});
    
    logger.debug({ mangaTitle, chapter }, "Updated last chapter in Hash");
  } catch (err) {
    logger.error({ err, mangaTitle, chapter }, "Failed to set last chapter");
  }
}

/**
 * Get last known chapters for multiple manga (batch)
 */
export async function getLastChaptersBatch(
  mangaTitles: string[],
  redis: RedisClient
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  if (!mangaTitles.length) return results;
  
  try {
    const titleKeys = mangaTitles.map(title => normalizeTitleKey(title));
    
    // 1. Get from new Hash
    const values = await redis.hmget(MANGA_LAST_CHAPTERS_KEY, ...titleKeys);
    
    let hasMissing = false;
    let valuesArray: (string | null)[] = [];

    if (values) {
      if (!Array.isArray(values) && typeof values === "object") {
        const valuesRecord = values as Record<string, string | null>;
        valuesArray = titleKeys.map(tk => valuesRecord[tk] ?? null);
      } else {
        valuesArray = values as (string | null)[];
      }
    } else {
      valuesArray = new Array(titleKeys.length).fill(null);
    }

    mangaTitles.forEach((title, index) => {
      const val = valuesArray[index];
      results.set(title, val);
      if (!val) hasMissing = true;
    });

    // 2. If some are missing, they might still be in old keys
    if (hasMissing) {
      const missingIndices = mangaTitles
        .map((_, i) => i)
        .filter(i => !results.get(mangaTitles[i]));
      
      if (missingIndices.length > 0) {
        const oldKeys = missingIndices.map(i => `manga:${titleKeys[i]}:last_chapter`);
        const oldValues = await redis.mget(...oldKeys);
        
        const migrationPayload: Record<string, string> = {};
        
        oldValues.forEach((val, idx) => {
          if (val) {
            const originalIdx = missingIndices[idx];
            results.set(mangaTitles[originalIdx], val as string);
            migrationPayload[titleKeys[originalIdx]] = val as string;
          }
        });

        // Migrate found values to Hash
        if (Object.keys(migrationPayload).length > 0) {
          redis.hset(MANGA_LAST_CHAPTERS_KEY, migrationPayload).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to get last chapters batch");
    mangaTitles.forEach(title => { if (!results.has(title)) results.set(title, null); });
  }
  
  return results;
}

/**
 * Extract chapter number from chapter string
 */
export function extractChapterNumber(chapter: string): number | null {
  // "Chapter 100" → 100
  // "Ch. 100.5" → 100.5
  // "Episode 100" → 100
  const match = chapter.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Compare if chapterA is newer than chapterB
 */
export function isNewerChapter(chapterA: string, chapterB: string): boolean {
  const numA = extractChapterNumber(chapterA);
  const numB = extractChapterNumber(chapterB);
  
  if (numA === null || numB === null) {
    // Fallback to string comparison
    return chapterA > chapterB;
  }
  
  return numA > numB;
}

/**
 * Filter only chapters newer than lastKnown
 */
export function filterNewChapters(
  chapters: Array<{ chapter: string }>,
  lastKnown: string | null
): Array<{ chapter: string }> {
  if (!lastKnown) {
    // No last known chapter, return all
    return chapters;
  }
  
  return chapters.filter(ch => isNewerChapter(ch.chapter, lastKnown));
}
