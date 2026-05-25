/**
 * Priority Queue System
 * Process high-priority manga first when queue is full
 */

import type { RedisClient, ChapterItem, WhitelistEntry } from "../types.js";
import { getLogger } from "../logger.js";
import { normalizeTitleKey } from "../domain.js";

const logger = getLogger({ scope: "priority-queue" });

export type Priority = "high" | "medium" | "low";

interface PriorityConfig {
  high: number; // Weight for high priority
  medium: number; // Weight for medium priority
  low: number; // Weight for low priority
}

const DEFAULT_WEIGHTS: PriorityConfig = {
  high: 100,
  medium: 50,
  low: 10,
};

/**
 * Calculate manga priority based on multiple factors
 */
export async function calculateMangaPriority(
  manga: WhitelistEntry,
  redis: RedisClient
): Promise<{
  priority: Priority;
  score: number;
  factors: {
    bookmarks: number;
    recentActivity: number;
    updateFrequency: number;
  };
}> {
  try {
    const titleKey = normalizeTitleKey(manga.title);
    
    // Factor 1: Bookmark count (popularity)
    const bookmarkKey = `bookmarks:${titleKey}`;
    const bookmarkCount = await redis.exists(bookmarkKey) ? 
      (await redis.smembers(bookmarkKey)).length : 0;
    
    // Factor 2: Recent activity (chapters in last 7 days)
    const recentKey = `manga:${titleKey}:recent_activity`;
    const recentActivity = parseInt(await redis.get(recentKey) || "0");
    
    // Factor 3: Update frequency (chapters per week)
    const freqKey = `manga:${titleKey}:update_frequency`;
    const updateFrequency = parseFloat(await redis.get(freqKey) || "0");
    
    // Calculate score
    const score = 
      bookmarkCount * 10 + 
      recentActivity * 5 + 
      updateFrequency * 3;
    
    // Determine priority
    let priority: Priority;
    if (score >= 100) {
      priority = "high";
    } else if (score >= 30) {
      priority = "medium";
    } else {
      priority = "low";
    }
    
    return {
      priority,
      score,
      factors: {
        bookmarks: bookmarkCount,
        recentActivity,
        updateFrequency,
      },
    };
  } catch (err) {
    logger.error({ err, manga: manga.title }, "Failed to calculate priority");
    return {
      priority: "medium",
      score: 50,
      factors: {
        bookmarks: 0,
        recentActivity: 0,
        updateFrequency: 0,
      },
    };
  }
}

/**
 * Sort chapters by priority
 */
export function sortChaptersByPriority(
  chapters: Array<ChapterItem & { priority?: Priority }>,
  weights: PriorityConfig = DEFAULT_WEIGHTS
): Array<ChapterItem & { priority?: Priority }> {
  return chapters.sort((a, b) => {
    const priorityA = a.priority || "medium";
    const priorityB = b.priority || "medium";
    
    const weightA = weights[priorityA];
    const weightB = weights[priorityB];
    
    return weightB - weightA; // Descending (high priority first)
  });
}

/**
 * Filter chapters based on queue capacity
 * Drops low-priority chapters when queue is full
 */
export async function filterByQueueCapacity(
  chapters: ChapterItem[],
  redis: RedisClient,
  options: {
    maxQueueSize?: number;
    currentQueueSize?: number;
    dropLowPriority?: boolean;
  } = {}
): Promise<{
  accepted: ChapterItem[];
  dropped: ChapterItem[];
  stats: {
    total: number;
    accepted: number;
    dropped: number;
    byPriority: Record<Priority, number>;
  };
}> {
  const {
    maxQueueSize = 1000,
    currentQueueSize = 0,
    dropLowPriority = true,
  } = options;

  const availableSlots = Math.max(0, maxQueueSize - currentQueueSize);
  
  // If plenty of space, accept all
  if (availableSlots >= chapters.length) {
    return {
      accepted: chapters,
      dropped: [],
      stats: {
        total: chapters.length,
        accepted: chapters.length,
        dropped: 0,
        byPriority: { high: 0, medium: 0, low: 0 },
      },
    };
  }

  // Queue is full or nearly full
  logger.warn({ 
    availableSlots,
    chapters: chapters.length,
    currentQueue: currentQueueSize 
  }, "Queue capacity limited");

  if (!dropLowPriority) {
    // Accept first N chapters (FIFO)
    return {
      accepted: chapters.slice(0, availableSlots),
      dropped: chapters.slice(availableSlots),
      stats: {
        total: chapters.length,
        accepted: availableSlots,
        dropped: chapters.length - availableSlots,
        byPriority: { high: 0, medium: 0, low: 0 },
      },
    };
  }

  // Calculate priorities for all chapters
  const chaptersWithPriority = await Promise.all(
    chapters.map(async (chapter) => {
      // Get manga from whitelist
      const whitelistKey = "whitelist";
      const whitelistData = await redis.get(whitelistKey);
      const whitelist: WhitelistEntry[] = whitelistData 
        ? JSON.parse(whitelistData) 
        : [];
      
      const manga = whitelist.find(
        m => normalizeTitleKey(m.title) === normalizeTitleKey(chapter.title)
      );
      
      if (!manga) {
        return { ...chapter, priority: "medium" as Priority };
      }
      
      const { priority } = await calculateMangaPriority(manga, redis);
      return { ...chapter, priority };
    })
  );

  // Sort by priority
  const sorted = sortChaptersByPriority(chaptersWithPriority);

  // Accept high priority first
  const accepted: ChapterItem[] = [];
  const dropped: ChapterItem[] = [];
  const byPriority: Record<Priority, number> = { high: 0, medium: 0, low: 0 };

  for (const chapter of sorted) {
    if (accepted.length < availableSlots) {
      accepted.push(chapter);
    } else {
      dropped.push(chapter);
      byPriority[chapter.priority || "medium"]++;
    }
  }

  logger.info({ 
    accepted: accepted.length,
    dropped: dropped.length,
    droppedByPriority: byPriority 
  }, "Filtered by priority");

  return {
    accepted,
    dropped,
    stats: {
      total: chapters.length,
      accepted: accepted.length,
      dropped: dropped.length,
      byPriority,
    },
  };
}

/**
 * Update manga activity metrics (for priority calculation)
 */
export async function updateMangaActivity(
  manga: WhitelistEntry,
  redis: RedisClient,
  chaptersAdded: number = 1
): Promise<void> {
  try {
    const titleKey = normalizeTitleKey(manga.title);
    
    // Update recent activity (7-day rolling count)
    const recentKey = `manga:${titleKey}:recent_activity`;
    const currentActivity = parseInt(await redis.get(recentKey) || "0");
    await redis.set(recentKey, (currentActivity + chaptersAdded).toString());
    await redis.expire(recentKey, 7 * 24 * 60 * 60); // 7 days
    
    // Update update frequency (chapters per week)
    const freqKey = `manga:${titleKey}:update_frequency`;
    const currentFreq = parseFloat(await redis.get(freqKey) || "0");
    const newFreq = (currentFreq * 0.9) + (chaptersAdded * 0.1); // Exponential moving average
    await redis.set(freqKey, newFreq.toString());
    
    logger.debug({ 
      manga: manga.title,
      chaptersAdded,
      newFreq 
    }, "Updated manga activity");
  } catch (err) {
    logger.error({ err, manga: manga.title }, "Failed to update manga activity");
  }
}

/**
 * Get priority stats for all manga
 */
export async function getPriorityStats(
  whitelist: WhitelistEntry[],
  redis: RedisClient
): Promise<{
  high: number;
  medium: number;
  low: number;
  total: number;
}> {
  const stats = { high: 0, medium: 0, low: 0, total: whitelist.length };
  
  for (const manga of whitelist) {
    const { priority } = await calculateMangaPriority(manga, redis);
    stats[priority]++;
  }
  
  return stats;
}
