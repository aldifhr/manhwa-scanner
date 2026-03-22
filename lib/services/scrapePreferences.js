import { normalizeSource, normalizeSourceUrl } from "../domain/source.js";

export function buildPreferredSecondaryTitles(whitelist = []) {
  const out = {
    shinigami_project: [],
    shinigami_mirror: [],
  };

  for (const entry of whitelist) {
    const source = normalizeSource(entry?.source);
    if ((source === "shinigami_project" || source === "shinigami_mirror") && entry?.title) {
      out[source].push(entry.title);
    }
  }

  return out;
}

export function buildPreferredSecondaryUrls(whitelist = []) {
  const out = {
    shinigami_project: [],
    shinigami_mirror: [],
  };

  for (const entry of whitelist) {
    const source = normalizeSource(entry?.source);
    const url = normalizeSourceUrl(entry?.url || "");
    if ((source === "shinigami_project" || source === "shinigami_mirror") && url) {
      out[source].push(url);
    }
  }

  return out;
}

export function buildPreferredIkiruTitles(whitelist = []) {
  const out = [];

  for (const entry of whitelist) {
    const source = normalizeSource(entry?.source);
    if (source === "ikiru" && entry?.title) {
      out.push(entry.title);
    }
  }

  return out;
}

export function buildScrapeOptions(whitelist = [], overrides = {}) {
  return {
    preferredIkiruTitles: buildPreferredIkiruTitles(whitelist),
    preferredSecondaryTitles: buildPreferredSecondaryTitles(whitelist),
    preferredSecondaryUrls: buildPreferredSecondaryUrls(whitelist),
    ...overrides,
  };
}
