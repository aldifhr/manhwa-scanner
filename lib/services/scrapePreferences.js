import { normalizeSource, normalizeSourceUrl } from "../domain.js";

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

export function buildPreferredSecondaryEntries(whitelist = []) {
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
      const url = normalizeSourceUrl(src?.url || "");
      if (!url) continue;
      if (source === "shinigami_project" || source === "shinigami_mirror") {
        out[source].push({ title: entry.title, url });
      }
    }
  }

  const dedupe = (entries = []) => {
    const seen = new Set();
    return entries.filter((entry) => {
      const key = `${entry?.url || ""}:${String(entry?.title || "").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  out.shinigami_project = dedupe(out.shinigami_project);
  out.shinigami_mirror = dedupe(out.shinigami_mirror);
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
    preferredSecondaryEntries: buildPreferredSecondaryEntries(whitelist),
    ...overrides,
  };
}
