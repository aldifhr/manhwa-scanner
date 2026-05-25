import { normalizeSource, normalizeSourceUrl } from "../domain.js";
import { WhitelistEntry, WhitelistSource, PreferenceScrapeOptions } from "../types.js";

export interface PreferredSecondaryResult {
  shinigami: string[];
  [key: string]: string[];
}

export interface PreferredSecondaryEntryResult {
  shinigami: { title: string; url: string }[];
  [key: string]: { title: string; url: string }[];
}

export function buildPreferredSecondaryTitles(whitelist: WhitelistEntry[] = []): PreferredSecondaryResult {
  const out: PreferredSecondaryResult = {
    shinigami: [],
  };

  for (const entry of whitelist) {
    if (!entry?.title) continue;
    const sourcesToRead: WhitelistSource[] = Array.isArray(entry.sources) && entry.sources.length > 0
      ? entry.sources
      : [entry as unknown as WhitelistSource];

    for (const src of sourcesToRead) {
      const source = normalizeSource(src.source);
      if (source === "shinigami") {
        out.shinigami.push(entry.title);
      }
    }
  }

  // De-duplicate
  out.shinigami = [...new Set(out.shinigami)];

  return out;
}

export function buildPreferredSecondaryUrls(whitelist: WhitelistEntry[] = []): PreferredSecondaryResult {
  const out: PreferredSecondaryResult = {
    shinigami: [],
  };

  for (const entry of whitelist) {
    const sourcesToRead: WhitelistSource[] = Array.isArray(entry.sources) && entry.sources.length > 0
      ? entry.sources
      : [entry as unknown as WhitelistSource];

    for (const src of sourcesToRead) {
      const source = normalizeSource(src.source);
      const url = normalizeSourceUrl(src.url || "");
      if (url && source === "shinigami") {
        out.shinigami.push(url);
      }
    }
  }

  // De-duplicate
  out.shinigami = [...new Set(out.shinigami)];

  return out;
}

export function buildPreferredSecondaryEntries(whitelist: WhitelistEntry[] = []): PreferredSecondaryEntryResult {
  const out: PreferredSecondaryEntryResult = {
    shinigami: [],
  };

  for (const entry of whitelist) {
    if (!entry?.title) continue;
    const sourcesToRead: WhitelistSource[] = Array.isArray(entry.sources) && entry.sources.length > 0
      ? entry.sources
      : [entry as unknown as WhitelistSource];

    for (const src of sourcesToRead) {
      const source = normalizeSource(src.source);
      const url = normalizeSourceUrl(src.url || "");
      if (!url) continue;
      if (source === "shinigami") {
        out.shinigami.push({ title: entry.title, url });
      }
    }
  }

  const dedupe = (entries: { title: string; url: string }[] = []) => {
    const seen = new Set<string>();
    return entries.filter((entry: { title: string; url: string }) => {
      const key = `${entry?.url || ""}:${String(entry?.title || "").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  out.shinigami = dedupe(out.shinigami);
  return out;
}

export interface PreferredIkiruResult {
  titles: string[];
  urls: string[];
}

export function buildPreferredIkiruPreferences(whitelist: WhitelistEntry[] = []): PreferredIkiruResult {
  const titles: string[] = [];
  const urls: string[] = [];

  for (const entry of whitelist) {
    if (!entry?.title) continue;
    
    const sourcesToRead: WhitelistSource[] = Array.isArray(entry.sources) && entry.sources.length > 0
      ? entry.sources
      : [entry as unknown as WhitelistSource];

    for (const src of sourcesToRead) {
      const source = normalizeSource(src.source);
      if (source === "ikiru") {
        titles.push(entry.title);
        const url = normalizeSourceUrl(src.url || "");
        if (url) urls.push(url);
      }
    }
  }

  return {
    titles: [...new Set(titles)],
    urls: [...new Set(urls)],
  };
}

export function buildScrapeOptions(whitelist: WhitelistEntry[] = [], overrides: Partial<PreferenceScrapeOptions> = {}): PreferenceScrapeOptions {
  const preferredIkiru = buildPreferredIkiruPreferences(whitelist);
  return {
    preferredIkiru,
    preferredIkiruTitles: preferredIkiru.titles,
    preferredSecondaryTitles: buildPreferredSecondaryTitles(whitelist),
    preferredSecondaryUrls: buildPreferredSecondaryUrls(whitelist),
    preferredSecondaryEntries: buildPreferredSecondaryEntries(whitelist),
    sourceMaxAgeMs: 3600000, // 1 hour default
    enableSecondary: true,
    batchSize: 10,
    earlyTermination: { noResults: true, consecutiveEmptyPages: 2 },
    ...overrides,
  };
}
