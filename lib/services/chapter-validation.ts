/**
 * Data Validation Layer for Scraped Manga Chapters
 * Ensures accuracy, validity, and data integrity before dispatch
 */

import { ChapterItem } from "../types.js";
import { getChapterNumber, normalizeTitleKey } from "../domain.js";

export interface ValidationResult {
  valid: boolean;
  item?: ChapterItem;
  errors: string[];
  warnings: string[];
}

export interface ValidationOptions {
  /** Max chapter age in hours (default: 168 = 7 days) */
  maxAgeHours?: number;
  /** Require valid URL (default: true) */
  requireUrl?: boolean;
  /** Require chapter number (default: true) */
  requireChapterNumber?: boolean;
  /** Validate source is known (default: true) */
  validateSource?: boolean;
  /** Known valid sources */
  validSources?: string[];
}

const DEFAULT_OPTIONS: Required<ValidationOptions> = {
  maxAgeHours: 168,
  requireUrl: true,
  requireChapterNumber: true,
  validateSource: true,
  validSources: ["ikiru", "shinigami"],
};

const VALID_URL_PATTERN = /^https:\/\/[a-zA-Z0-9][-\w]*\.[\w.-]+\/.*$/;

/**
 * Validate a scraped chapter item for data integrity
 */
export function validateScrapedChapter(
  item: unknown,
  options: ValidationOptions = {},
): ValidationResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const errors: string[] = [];
  const warnings: string[] = [];

  // Type check
  if (!item || typeof item !== "object") {
    return { valid: false, errors: ["Item is null or not an object"], warnings: [] };
  }

  const chapterItem = item as Partial<ChapterItem>;

  // Required field: title
  if (!chapterItem.title || typeof chapterItem.title !== "string") {
    errors.push("Missing or invalid title");
  } else if (chapterItem.title.length < 2) {
    warnings.push("Title is very short, may be truncated");
  }

  // Required field: source
  if (opts.validateSource) {
    if (!chapterItem.source || typeof chapterItem.source !== "string") {
      errors.push("Missing source");
    } else if (!opts.validSources.includes(chapterItem.source)) {
      errors.push(`Unknown source: ${chapterItem.source}`);
    }
  }

  // URL validation
  if (opts.requireUrl) {
    if (!chapterItem.url || typeof chapterItem.url !== "string") {
      errors.push("Missing chapter URL");
    } else if (!VALID_URL_PATTERN.test(chapterItem.url)) {
      errors.push(`Invalid URL format: ${chapterItem.url.substring(0, 50)}`);
    } else if (!chapterItem.url.startsWith("https://")) {
      warnings.push("URL is not HTTPS");
    }
  }

  // Chapter number validation
  if (opts.requireChapterNumber) {
    const chapterNum = getChapterNumber(chapterItem.chapter);
    if (chapterNum === null) {
      errors.push(`Cannot parse chapter number from: ${chapterItem.chapter}`);
    } else if (chapterNum < 0) {
      errors.push(`Invalid chapter number: ${chapterNum}`);
    } else if (chapterNum === 0) {
      warnings.push("Chapter number is 0 (may be prologue/oneshot)");
    }
  }

  // Updated time validation
  if (chapterItem.updatedTime) {
    const updatedDate = new Date(chapterItem.updatedTime);
    if (isNaN(updatedDate.getTime())) {
      errors.push(`Invalid updatedTime: ${chapterItem.updatedTime}`);
    } else {
      const ageHours = (Date.now() - updatedDate.getTime()) / (1000 * 60 * 60);
      if (ageHours > opts.maxAgeHours) {
        warnings.push(`Chapter is ${Math.round(ageHours)} hours old (max: ${opts.maxAgeHours})`);
      }
      if (ageHours < 0) {
        errors.push("Chapter timestamp is in the future");
      }
    }
  } else {
    warnings.push("Missing updatedTime");
  }

  // Cross-field validation
  if (chapterItem.title && chapterItem.chapter) {
    const titleKey = normalizeTitleKey(chapterItem.title);
    if (!titleKey) {
      errors.push("Cannot normalize title key");
    }
  }

  // Manga URL validation (if present)
  if (chapterItem.mangaUrl && typeof chapterItem.mangaUrl === "string") {
    if (!VALID_URL_PATTERN.test(chapterItem.mangaUrl)) {
      warnings.push(`Invalid mangaUrl format: ${chapterItem.mangaUrl.substring(0, 50)}`);
    }
  }

  const valid = errors.length === 0;

  return {
    valid,
    item: valid ? (item as ChapterItem) : undefined,
    errors,
    warnings,
  };
}

/**
 * Batch validate multiple chapters
 */
export function validateScrapedChapters(
  items: unknown[],
  options: ValidationOptions = {},
): { valid: ChapterItem[]; invalid: { item: unknown; errors: string[] }[]; stats: { total: number; valid: number; invalid: number; warnings: number } } {
  const valid: ChapterItem[] = [];
  const invalid: { item: unknown; errors: string[] }[] = [];
  let warningCount = 0;

  for (const item of items) {
    const result = validateScrapedChapter(item, options);
    if (result.valid && result.item) {
      valid.push(result.item);
    } else {
      invalid.push({ item, errors: result.errors });
    }
    warningCount += result.warnings.length;
  }

  return {
    valid,
    invalid,
    stats: {
      total: items.length,
      valid: valid.length,
      invalid: invalid.length,
      warnings: warningCount,
    },
  };
}

/**
 * Check for duplicate chapters in batch
 */
export function findDuplicateChapters(items: ChapterItem[]): Map<string, ChapterItem[]> {
  const duplicates = new Map<string, ChapterItem[]>();
  const seen = new Map<string, ChapterItem>();

  for (const item of items) {
    const titleKey = normalizeTitleKey(item.title);
    const chapterNum = getChapterNumber(item.chapter);
    
    if (!titleKey || chapterNum === null) continue;
    
    const key = `${titleKey}:${chapterNum}`;
    const existing = seen.get(key);
    
    if (existing) {
      const dupes = duplicates.get(key) || [existing];
      dupes.push(item);
      duplicates.set(key, dupes);
    } else {
      seen.set(key, item);
    }
  }

  return duplicates;
}

/**
 * Detect suspicious data patterns
 */
export function detectDataAnomalies(items: ChapterItem[]): {
  emptyTitles: number;
  futureDates: number;
  veryOldChapters: number;
  duplicateChapters: number;
  invalidUrls: number;
} {
  const anomalies = {
    emptyTitles: 0,
    futureDates: 0,
    veryOldChapters: 0,
    duplicateChapters: 0,
    invalidUrls: 0,
  };

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const chapterKeys = new Set<string>();

  for (const item of items) {
    // Empty titles
    if (!item.title || item.title.length < 2) {
      anomalies.emptyTitles++;
    }

    // Future dates
    if (item.updatedTime) {
      const date = new Date(item.updatedTime).getTime();
      if (date > now) {
        anomalies.futureDates++;
      }
      if (date < sevenDaysAgo) {
        anomalies.veryOldChapters++;
      }
    }

    // Invalid URLs
    if (!item.url || !VALID_URL_PATTERN.test(item.url)) {
      anomalies.invalidUrls++;
    }

    // Duplicates
    const key = `${normalizeTitleKey(item.title)}:${getChapterNumber(item.chapter)}`;
    if (key && chapterKeys.has(key)) {
      anomalies.duplicateChapters++;
    } else if (key) {
      chapterKeys.add(key);
    }
  }

  return anomalies;
}
