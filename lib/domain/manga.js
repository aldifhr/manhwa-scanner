import { normalizeSource, normalizeSourceUrl } from "./source.js";

export function normalizeTitleKey(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactTitleKey(str = "") {
  return normalizeTitleKey(str).replace(/\s+/g, "");
}

export function isSameNormalizedTitle(left = "", right = "") {
  const leftKey = normalizeTitleKey(left);
  const rightKey = normalizeTitleKey(right);
  if (!leftKey || !rightKey) return false;
  return leftKey === rightKey || compactTitleKey(leftKey) === compactTitleKey(rightKey);
}

export function getChapterNumber(chapterText = "") {
  const str = String(chapterText).toLowerCase();
  
  // 1. Explicit keyword match
  const keywordMatch = str.match(/(?:chapter|ch\.?|episode|ep\.?|bab|vol\.?)\s*(\d+(?:\.\d+)?)/);
  if (keywordMatch) {
    return Number.parseFloat(keywordMatch[1]);
  }
  
  // 2. Fallback: Take the last number in the string (solves "Season 2 - 15")
  const numbers = str.match(/\d+(\.\d+)?/g);
  if (numbers && numbers.length > 0) {
    return Number.parseFloat(numbers[numbers.length - 1]);
  }
  
  return 0;
}

/**
 * Normalizes a chapter string to a canonical identity key (num:X or text:X).
 * Used for cross-source deduplication.
 */
export function normalizeChapterIdentity(chapter = "") {
  const chapterNumber = getChapterNumber(chapter);
  if (chapterNumber > 0) return `num:${chapterNumber}`;

  const chapterKey = String(chapter || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return chapterKey ? `text:${chapterKey}` : null;
}

export function createWhitelistMatcher(whitelist = []) {
  const prepared = whitelist.map((entry) => ({
    title: entry.title ? normalizeTitleKey(entry.title) : null,
    sources: (entry.sources || []).map(s => ({
      hasUrl: Boolean(s.url),
      url: s.url ? normalizeSourceUrl(s.url) : null,
      source: normalizeSource(s.source)
    }))
  }));

  return (item) => {
    const itemUrl = item?.mangaUrl ? normalizeSourceUrl(item.mangaUrl) : null;
    const itemTitle = item?.title ? normalizeTitleKey(item.title) : null;
    const itemSource = normalizeSource(item?.source);

    return prepared.some((entry) => {
      // If title matches, check sources
      const titleMatch = entry.title && itemTitle && isSameNormalizedTitle(itemTitle, entry.title);
      
      return entry.sources.some(s => {
        if (s.source && itemSource !== s.source) return false;
        if (s.hasUrl) return Boolean(itemUrl) && itemUrl === s.url;
        return titleMatch;
      });
    });
  };
}

/**
 * Calculates string similarity between 0 and 1 using Sørensen–Dice coefficient.
 * Optimized for short titles.
 */
export function fuzzyTitleSimilarity(str1 = "", str2 = "") {
  const s1 = normalizeTitleKey(str1).replace(/\s+/g, "");
  const s2 = normalizeTitleKey(str2).replace(/\s+/g, "");
  
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;

  const getBigrams = (str) => {
    const bigrams = new Set();
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
