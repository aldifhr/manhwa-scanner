import { normalizeSource, normalizeSourceUrl } from "../domain/source.js";

export function buildPreferredSecondaryTitles(whitelist = []) {
  const out = {
    shinigami_project: [],
    shinigami_mirror: [],
  };

  for (const entry of whitelist) {
    if (!entry?.title) continue;
    const sourcesToRead = Array.isArray(entry.sources) && entry.sources.length > 0 
      ? entry.sources 
      : [entry];
      
    for (const src of sourcesToRead) {
      const source = normalizeSource(src?.source);
      if (source === "shinigami_project" || source === "shinigami_mirror") {
        out[source].push(entry.title);
      }
    }
  }

  // De-duplicate
  out.shinigami_project = [...new Set(out.shinigami_project)];
  out.shinigami_mirror = [...new Set(out.shinigami_mirror)];

  return out;
}

export function buildPreferredSecondaryUrls(whitelist = []) {
  const out = {
    shinigami_project: [],
    shinigami_mirror: [],
  };

  for (const entry of whitelist) {
    const sourcesToRead = Array.isArray(entry.sources) && entry.sources.length > 0 
      ? entry.sources 
      : [entry];
      
    for (const src of sourcesToRead) {
      const source = normalizeSource(src?.source);
      const url = normalizeSourceUrl(src?.url || "");
      if (url && (source === "shinigami_project" || source === "shinigami_mirror")) {
        out[source].push(url);
      }
    }
  }

  // De-duplicate
  out.shinigami_project = [...new Set(out.shinigami_project)];
  out.shinigami_mirror = [...new Set(out.shinigami_mirror)];

  return out;
}

export function buildPreferredIkiruTitles(whitelist = []) {
  const out = [];

  for (const entry of whitelist) {
    const sourcesToRead = Array.isArray(entry.sources) && entry.sources.length > 0 
      ? entry.sources 
      : [entry];
      
    for (const src of sourcesToRead) {
      const source = normalizeSource(src?.source);
      if (source === "ikiru" && entry?.title) {
        out.push(entry.title);
      }
    }
  }

  return [...new Set(out)];
}

export function buildScrapeOptions(whitelist = [], overrides = {}) {
  return {
    preferredIkiruTitles: buildPreferredIkiruTitles(whitelist),
    preferredSecondaryTitles: buildPreferredSecondaryTitles(whitelist),
    preferredSecondaryUrls: buildPreferredSecondaryUrls(whitelist),
    ...overrides,
  };
}
