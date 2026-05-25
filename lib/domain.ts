import { getLogger } from "./logger.js";
import {
  ChapterItem,
  WhitelistEntry,
  WhitelistSource,
} from "./types.js";
import { env } from "./config/env.js";
import { redis } from "./redis.js";
import { getDynamicOverrides } from "./services/dynamicConfig.js";

// Global cache for dynamic overrides to keep lookups fast and sync
let dynamicOverridesCache: { shinigamiBase?: string; ikiruBase?: string } = {};

const logger = getLogger({ scope: "domain" });

/**
 * Update the local cache of dynamic overrides.
 * Should be called at the start of a cron run or when an override is set.
 */
export async function syncDynamicOverrides() {
  try {
    dynamicOverridesCache = await getDynamicOverrides();
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to sync dynamic overrides from Redis");
  }
}

/**
 * 1. SOURCE RELATED LOGIC
 */

export function getShinigamiPublicBase(): string {
  return (
    dynamicOverridesCache.shinigamiBase ||
    env.SHINIGAMI_BASE_URL ||
    env.SECONDARY_PUBLIC_BASE ||
    "https://g.shinigami.asia"
  )
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function getIkiruPublicBase(): string {
  return (
    dynamicOverridesCache.ikiruBase ||
    env.IKIRU_BASE_URL ||
    "https://ikiru.wtf"
  )
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function normalizeSource(source = ""): string {
  const s = String(source).toLowerCase().trim();
  if (s === "shinigami") {
    return "shinigami";
  }
  // Default all sources to ikiru
  return "ikiru";
}

export function sourceLabel(source = ""): string {
  const s = normalizeSource(source);
  if (s === "shinigami") return "Shinigami";
  return "Ikiru";
}

export function normalizeSourceUrl(url: string | null | undefined = ""): string {
  if (!url) return "";
  let normalized = String(url).toLowerCase().trim();
  
  // Strip legacy prefixes if present (e.g. 'chapter:https://...', 'manga:https://...')
  normalized = normalized.replace(/^(?:chapter|manga|series):/i, "");
  
  if (!normalized.endsWith("/")) normalized += "/";

  const ikiruBase = getIkiruPublicBase();
  const shigBase = getShinigamiPublicBase();

  const shigDomains =
    /^(https?:\/\/(?:[a-z0-9-]+\.)?(?:shinigami\.asia|shinigami\.id|shngm\.id))(?:[/:?#]|$)/i;
  if (shigDomains.test(normalized)) {
    return normalized.replace(/^https?:\/\/[^/]+/i, shigBase);
  }

  if (/^https?:\/\/(?:[a-z0-9-]+\.)?(ikiru\.[a-z]{2,})(?:[/:?#]|$)/i.test(normalized)) {
    return normalized.replace(/^https?:\/\/[^/]+/i, ikiruBase);
  }

  return normalized;
}

export function inferSourceFromUrl(url = ""): string | null {
  const normalized = normalizeSourceUrl(url);
  if (!normalized) return null;

  const ikiruBase = getIkiruPublicBase();
  const shigBase = getShinigamiPublicBase();

  if (normalized.startsWith(`${ikiruBase}/manga/`)) return "ikiru";
  
  if (
    normalized.startsWith(`${shigBase}/series/`) ||
    normalized.startsWith(`${shigBase}/manga/`) ||
    normalized.startsWith(`${shigBase}/komik/`)
  ) {
    return "shinigami";
  }
  return null;
}

/**
 * 2. MANGA RELATED LOGIC
 */

const REGEX_TITLE_METADATA = /\s*[([].*?(?:official|bahasa|colored|raw|english|indo|reboot|project|mirror|manhwa|manga).*?[)\]]\s*/gi;
const REGEX_OFFICIAL_SUFFIX = /\s*-\s*official\s*$/i;
const REGEX_NON_ALPHANUM_SYMBOLS = /[^a-z0-9\s]/gi;
const REGEX_WHITESPACE = /\s+/g;

export function normalizeTitleKey(str: string | null | undefined = ""): string {
  if (!str) return "";
  let val = String(str).toLowerCase();
  
  // Handle obfuscated spaced titles (e.g., "b e c o m i n g")
  if (val.length > 5) {
    const spaces = (val.match(/ /g) || []).length;
    if (spaces > val.length / 3) {
      // Treat 2+ spaces as word boundary, single space as letter boundary
      val = val.replace(/\s{2,}/g, "\0");
      val = val.replace(/ /g, "");
      val = val.replace(/\0/g, " ");
    }
  }

  return val
    .replace(REGEX_TITLE_METADATA, "")
    .replace(REGEX_OFFICIAL_SUFFIX, "")
    .replace(/[^a-z0-9\s]/g, "") // Hapus simbol tapi PERTAHANKAN spasi
    .replace(/\s+/g, " ") // Rapikan spasi ganda
    .trim();
}

export function compactTitleKey(str: string | null | undefined = ""): string {
  // Hanya hapus spasi saat benar-benar butuh key yang sangat ketat (internal matching)
  return normalizeTitleKey(str).replace(/\s+/g, "");
}

export function isSameNormalizedTitle(left = "", right = ""): boolean {
  const leftKey = compactTitleKey(left);
  const rightKey = compactTitleKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;

  // High threshold prevents matching different seasons as same title
  return fuzzyTitleSimilarity(leftKey, rightKey) > 0.95;
}

export function getChapterNumber(chapterText = ""): number | null {
  const str = String(chapterText).toLowerCase().replace(/\s+/g, " ").trim();

  // Keyword-based search
  const keywordMatch = str.match(
    /(?:chapter|ch\.?|episode|ep\.?|bab|vol\.?|cas\.?)\s*(\d+(?:\.\d+)?)/,
  );
  if (keywordMatch) {
    const num = Number.parseFloat(keywordMatch[1]);
    return Number.isFinite(num) ? num : null;
  }

  // Fallback to any trailing number
  const numbers = str.match(/\d+(?:\.\d+)?/g);
  if (numbers && numbers.length > 0) {
    const lastNum = Number.parseFloat(numbers[numbers.length - 1]);
    return Number.isFinite(lastNum) ? lastNum : null;
  }

  if (
    str.includes("special") ||
    str.includes("prolog") ||
    str.includes("oneshot")
  ) {
    return 0;
  }

  return null;
}

export function normalizeChapterIdentity(chapter = ""): string | null {
  const chapterNumber = getChapterNumber(chapter);

  if (chapterNumber !== null) {
    const formatted = Number.isInteger(chapterNumber)
      ? chapterNumber.toString()
      : chapterNumber.toFixed(1).replace(/\.0$/, "");
    return `num:${formatted}`;
  }

  const chapterKey = String(chapter || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return chapterKey ? `text:${chapterKey}` : null;
}

export function createWhitelistMatcher(whitelist: WhitelistEntry[]) {
  return (item: { title?: string; url?: string | null; mangaUrl?: string | null; source?: string }) => {
    if (!item || !whitelist) return null;

    const itemTitleKey = normalizeTitleKey(item.title);
    const itemUrlKey = normalizeSourceUrl(item.mangaUrl || item.url);
    const itemSource = item.source ? normalizeSource(item.source) : null;

    if (!itemTitleKey && !itemUrlKey) return null;

    for (const entry of whitelist) {
      // 1. URL Match (Priority)
      if (itemUrlKey) {
        if (entry._normalizedUrls?.has(itemUrlKey)) return entry;
        
        // Fallback for non-pre-normalized entries
        if (!entry._normalizedUrls) {
          for (const s of entry.sources) {
            if (s.url && normalizeSourceUrl(s.url) === itemUrlKey) return entry;
          }
        }
      }

      // 2. Title Match (requires source check for safety if URL didn't match)
      const entryTitleKey = entry._normalizedTitle || normalizeTitleKey(entry.title);
      if (itemTitleKey && entryTitleKey === itemTitleKey) {
        // If we have an item source, verify it exists in the entry
        if (itemSource) {
          const hasMatchingSource = entry.sources.some(s => normalizeSource(s.source) === itemSource);
          if (hasMatchingSource) return entry;
        } else {
          // If no item source provided, title match is sufficient
          return entry;
        }
      }
    }
    return null;
  };
}

export function fuzzyTitleSimilarity(str1 = "", str2 = ""): number {
  const s1 = normalizeTitleKey(str1);
  const s2 = normalizeTitleKey(str2);

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;

  const getBigrams = (str: string) => {
    const bigrams = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.substring(i, i + 2));
    }
    return bigrams;
  };

  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);

  let intersection = 0;
  for (const b of b1) {
    if (b2.has(b)) intersection++;
  }

  return (2 * intersection) / (b1.size + b2.size);
}

/**
 * 3. WHITELIST RELATED LOGIC
 */

export const MARK_REASON_LABELS: Record<string, string> = Object.freeze({
  hiatus: "Hiatus",
  end_season: "Selesai Season",
  end: "Tamat",
  read: "Sudah Baca",
});

export function normalizeMarkReason(value: any): string | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (!raw || raw === "clear" || raw === "none") return null;
  return MARK_REASON_LABELS[raw] ? raw : null;
}

export function normalizeWhitelist(list: any[] = []): WhitelistEntry[] {
  const source = Array.isArray(list) ? list : [];
  const result: WhitelistEntry[] = [];
  const seenTitles = new Map<string, number>();

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.title || "").trim();
    if (!title) continue;

    const key = compactTitleKey(title);
    if (!key) continue;

    if (!seenTitles.has(key)) {
      seenTitles.set(key, result.length);

      let initialSources: WhitelistSource[] = [];
      if (Array.isArray(item.sources)) {
        initialSources = item.sources.map((s: any) => ({
          url: s.url ? String(s.url).trim() : null,
          source: normalizeSource(s.source),
          mark: normalizeMarkReason(s.mark),
        }));
      } else if (item.source) {
        initialSources.push({
          url: item.url ? String(item.url).trim() : null,
          source: normalizeSource(item.source),
          mark: normalizeMarkReason(item.mark),
        });
      }

      result.push({ title, sources: initialSources });
      continue;
    }

    const idx = seenTitles.get(key)!;
    const existing = result[idx];

    const sourcesToAdd = Array.isArray(item.sources)
      ? item.sources
      : item.source
        ? [item]
        : [];

    if (sourcesToAdd.length > 0) {
      sourcesToAdd.forEach((s: any) => {
        const normSrc = normalizeSource(s.source);
        const normUrl = s.url ? String(s.url).trim() : null;

        const hasSource = existing.sources.some(
          (es) => es.source === normSrc && (!normUrl || es.url === normUrl),
        );

        if (!hasSource) {
          existing.sources.push({
            url: normUrl,
            source: normSrc,
            mark: normalizeMarkReason(s.mark),
          });
        }
      });
    }
  }

  return result;
}
