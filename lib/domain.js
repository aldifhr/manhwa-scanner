/**
 * 1. SOURCE RELATED LOGIC
 */

export function getShinigamiPublicBase() {
  return (process.env.SHINIGAMI_BASE_URL || process.env.SECONDARY_PUBLIC_BASE || "https://a.shinigami.asia")
    .replace(/\/+$/, "").toLowerCase();
}

export function getIkiruPublicBase() {
  return (process.env.IKIRU_BASE_URL || "https://02.ikiru.wtf")
    .replace(/\/+$/, "").toLowerCase();
}

export function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

export function sourceLabel(source = "") {
  const s = normalizeSource(source);
  if (s === "shinigami_project") return "Shinigami (Project)";
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

export function normalizeSourceUrl(url = "") {
  let normalized = String(url).toLowerCase().trim();
  if (!normalized) return "";

  if (!normalized.endsWith("/")) normalized += "/";

  const ikiruBase = getIkiruPublicBase();
  const shigBase = getShinigamiPublicBase();

  const shigDomains = /^(https?:\/\/(?:[a-z0-9-]+\.)?(?:shinigami\.asia))(?:[/:?#]|$)/i;
  if (shigDomains.test(normalized)) {
    return normalized.replace(/^https?:\/\/[^/]+/i, shigBase);
  }

  if (/^https?:\/\/(?:[a-z0-9-]+\.)?(ikiru\.wtf)(?:[/:?#]|$)/i.test(normalized)) {
    return normalized.replace(/^https?:\/\/[^/]+/i, ikiruBase);
  }

  return normalized;
}

export function inferSourceFromUrl(url = "") {
  const normalized = normalizeSourceUrl(url);
  if (!normalized) return null;

  const ikiruBase = getIkiruPublicBase();
  const shigBase = getShinigamiPublicBase();

  if (normalized.startsWith(`${ikiruBase}/manga/`)) return "ikiru";
  if (normalized.startsWith(`${shigBase}/series/`)) return "shinigami_project";
  return null;
}

/**
 * 2. MANGA RELATED LOGIC
 */

export function normalizeTitleKey(str = "") {
  return String(str)
    .toLowerCase()
    // Strip common metadata suffixes that break matching
    .replace(/\s*[([].*?(?:official|bahasa|colored|raw|english|indo).*?[)\]]\s*/gi, " ")
    .replace(/\s*-\s*official\s*$/i, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactTitleKey(str = "") {
  return normalizeTitleKey(str).replace(/\s+/g, "");
}

export function isSameNormalizedTitle(left = "", right = "") {
  const leftKey = normalizeTitleKey(left);
  const rightKey = normalizeTitleKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  if (leftKey.replace(/\s+/g, "") === rightKey.replace(/\s+/g, "")) return true;

  // High-threshold fuzzy match for slightly mangled titles
  return fuzzyTitleSimilarity(leftKey, rightKey) > 0.85;
}

export function getChapterNumber(chapterText = "") {
  const str = String(chapterText)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

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

  return null;
}

export function normalizeChapterIdentity(chapter = "") {
  const chapterNumber = getChapterNumber(chapter);

  if (chapterNumber !== null) {
    const formatted = Number.isInteger(chapterNumber)
      ? chapterNumber.toString()
      : chapterNumber.toFixed(1).replace(/\.0$/, "");
    return `num:${formatted}`;
  }

  const chapterKey = String(chapter || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return chapterKey ? `text:${chapterKey}` : null;
}

export function createWhitelistMatcher(whitelist = []) {
  const prepared = whitelist.map((entry) => {
    const titleKey = entry.title ? normalizeTitleKey(entry.title) : null;
    const titleCompact = titleKey ? compactTitleKey(titleKey) : null;
    return {
      original: entry,
      title: titleKey,
      titleCompact,
      sources: (entry.sources || []).map(s => ({
        hasUrl: Boolean(s.url),
        url: s.url ? normalizeSourceUrl(s.url) : null,
        source: normalizeSource(s.source),
      })),
    };
  });

  return (item) => {
    const itemUrl = item?.mangaUrl ? normalizeSourceUrl(item.mangaUrl) : null;
    const itemTitle = item?.title ? normalizeTitleKey(item.title) : null;
    const itemTitleCompact = itemTitle ? compactTitleKey(itemTitle) : null;
    const itemSource = normalizeSource(item?.source);

    return prepared.find((entry) => {
      // 1. Check title Match (Exact, Compact, or Fuzzy)
      const titleMatch = entry.title && itemTitle && (
        itemTitle === entry.title ||
        itemTitleCompact === entry.titleCompact ||
        fuzzyTitleSimilarity(itemTitle, entry.title) > 0.88
      );

      // 2. Check source/URL match
      const sourceMatch = entry.sources.some(s => {
        if (s.source && itemSource !== s.source) return false;
        if (s.hasUrl) return Boolean(itemUrl) && itemUrl === s.url;
        return titleMatch;
      });

      return sourceMatch;
    })?.original || null;
  };
}

export function fuzzyTitleSimilarity(str1 = "", str2 = "") {
  const s1 = normalizeTitleKey(str1);
  const s2 = normalizeTitleKey(str2);

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

/**
 * 3. WHITELIST RELATED LOGIC
 */

export const MARK_REASON_LABELS = Object.freeze({
  hiatus: "Hiatus",
  end_season: "Selesai Season",
  end: "Tamat",
  read: "Sudah Baca",
});

export function normalizeMarkReason(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (!raw || raw === "clear" || raw === "none") return null;
  return MARK_REASON_LABELS[raw] ? raw : null;
}

export function normalizeWhitelist(list = []) {
  const source = Array.isArray(list) ? list : [];
  const result = [];
  const seenTitles = new Map();

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.title || "").trim();
    if (!title) continue;

    const key = compactTitleKey(title);
    if (!key) continue;

    if (!seenTitles.has(key)) {
      seenTitles.set(key, result.length);

      let initialSources = [];
      if (Array.isArray(item.sources)) {
        initialSources = item.sources.map(s => ({
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

    const idx = seenTitles.get(key);
    const existing = result[idx];

    const sourcesToAdd = Array.isArray(item.sources) ? item.sources :
      (item.source ? [item] : []);

    if (sourcesToAdd.length > 0) {
      sourcesToAdd.forEach(s => {
        const normSrc = normalizeSource(s.source);
        const normUrl = s.url ? String(s.url).trim() : null;

        const hasSource = existing.sources.some(es =>
          es.source === normSrc &&
          (!normUrl || es.url === normUrl),
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
