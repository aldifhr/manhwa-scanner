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
  const m = String(chapterText).match(/\d+(\.\d+)?/);
  return m ? Number.parseFloat(m[0]) : 0;
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
