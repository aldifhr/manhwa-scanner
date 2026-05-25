import {
  normalizeChapterIdentity,
  normalizeSourceUrl,
  normalizeTitleKey,
} from "../../domain.js";
import { ChapterItem, DispatchChapterMeta } from "../../types.js";

// Re-export for backward compatibility
export type { DispatchChapterMeta } from "../../types.js";

/**
 * Build a cross-source deduplication key for a chapter.
 */
export function buildCrossSourceChapterKey(item: ChapterItem): string | null {
  const titleKey = normalizeTitleKey(item?.canonicalTitle || item?.title || "");
  const chapterKey = normalizeChapterIdentity(item?.chapter || "");
  if (!titleKey || !chapterKey) return null;
  return `chapter:dedupe:${titleKey}:${chapterKey}`;
}

/**
 * Get the updated time in milliseconds from a chapter item.
 */
export function getUpdatedTimeMs(item: ChapterItem): number | null {
  const ms = new Date(item?.updatedTime ?? "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Choose between two meta objects based on updated time if they are duplicates.
 */
export function preferDuplicateMeta(
  existing: DispatchChapterMeta,
  candidate: DispatchChapterMeta,
): DispatchChapterMeta {
  const existingMs = getUpdatedTimeMs(existing?.item);
  const candidateMs = getUpdatedTimeMs(candidate?.item);

  if (
    existingMs !== null &&
    candidateMs !== null &&
    candidateMs !== existingMs
  ) {
    // Prefer the EARLIER release (First to release wins the 'Source War')
    return candidateMs < existingMs ? candidate : existing;
  }

  return existing;
}

/**
 * Build meta objects for a list of matched chapters.
 */
export function buildDispatchChapterMeta(matched: ChapterItem[] = []): DispatchChapterMeta[] {
  return matched.map((item) => {
    const normalizedChapterUrl = normalizeSourceUrl(item?.url);
    return {
      item,
      key: normalizedChapterUrl ? `chapter:${normalizedChapterUrl}` : null,
      duplicateKey: buildCrossSourceChapterKey(item),
    };
  });
}
