import { normalizeTitleKey } from "./manga.js";
import { normalizeSource } from "./source.js";

export const MARK_REASON_LABELS = Object.freeze({
  hiatus: "Hiatus",
  end_season: "Selesai Season",
  end: "Tamat",
  read: "Sudah Baca",
});

/**
 * Normalizes a mark reason string to one of the supported values.
 */
export function normalizeMarkReason(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (!raw || raw === "clear" || raw === "none") return null;
  return MARK_REASON_LABELS[raw] ? raw : null;
}

/**
 * Normalizes the entire whitelist structure to ensure consistency.
 * Supports the nested multi-source format.
 */
export function normalizeWhitelist(list = []) {
  const source = Array.isArray(list) ? list : [];
  const result = [];
  const seenTitles = new Map();

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.title || "").trim();
    if (!title) continue;

    const key = normalizeTitleKey(title);
    if (!key) continue;

    if (!seenTitles.has(key)) {
      seenTitles.set(key, result.length);
      
      let initialSources = [];
      if (Array.isArray(item.sources)) {
        initialSources = item.sources.map(s => ({
          url: s.url ? String(s.url).trim() : null,
          source: normalizeSource(s.source),
          mark: normalizeMarkReason(s.mark)
        }));
      } else if (item.source) {
        // Handle legacy flat format: { title, url, source, mark }
        initialSources.push({
          url: item.url ? String(item.url).trim() : null,
          source: normalizeSource(item.source),
          mark: normalizeMarkReason(item.mark)
        });
      }

      result.push({ title, sources: initialSources });
      continue;
    }

    const idx = seenTitles.get(key);
    const existing = result[idx];
    
    // Process sources if present
    const sourcesToAdd = Array.isArray(item.sources) ? item.sources : 
                         (item.source ? [item] : []);
                         
    if (sourcesToAdd.length > 0) {
      sourcesToAdd.forEach(s => {
        const normSrc = normalizeSource(s.source);
        const normUrl = s.url ? String(s.url).trim() : null;
        
        const hasSource = existing.sources.some(es => 
          es.source === normSrc && 
          (!normUrl || es.url === normUrl)
        );
        
        if (!hasSource) {
          existing.sources.push({
            url: normUrl,
            source: normSrc,
            mark: normalizeMarkReason(s.mark)
          });
        }
      });
    }
  }

  return result;
}
