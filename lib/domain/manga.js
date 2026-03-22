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

export function createWhitelistMatcher(whitelist = []) {
  const prepared = whitelist.map((entry) => ({
    hasUrl: Boolean(entry.url),
    url: entry.url ? normalizeSourceUrl(entry.url) : null,
    title: entry.title ? normalizeTitleKey(entry.title) : null,
    source: normalizeSource(entry.source),
  }));

  return (item) => {
    const itemUrl = item?.mangaUrl ? normalizeSourceUrl(item.mangaUrl) : null;
    const itemTitle = item?.title ? normalizeTitleKey(item.title) : null;
    const itemSource = normalizeSource(item?.source);

    return prepared.some((entry) => {
      if (entry.source && itemSource !== entry.source) return false;
      if (entry.hasUrl) return Boolean(itemUrl) && itemUrl === entry.url;
      if (!entry.title || !itemTitle) return false;
      return isSameNormalizedTitle(itemTitle, entry.title);
    });
  };
}
