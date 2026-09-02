// Deep module: ContinueReading — seam for tracking read progress.
// Interface is the test surface; behind the seam: localStorage, sync, deduplication, max 20.

import { useState, useEffect, useCallback, useRef } from "react";
import { withCsrf } from "@/lib/csrf";

export interface ContinueReadingEntry {
  title: string;
  titleKey: string;
  cover: string | null;
  source: string;
  lastChapter: string;
  chapterUrl: string;
  seriesUrl: string;
  origin: string;
  updatedAt: string;
}

const LS_KEY = "continue_reading";
const SYNC_ENDPOINT = "/api/v1/continue-reading";
const MAX_ENTRIES = 20;
let globalHasFetched = false;

// — internal: storage seam (ter-isolasi untuk testability) —
function loadFromStorage(): Map<string, ContinueReadingEntry> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(LS_KEY);
    const data: Record<string, ContinueReadingEntry> = raw
      ? JSON.parse(raw)
      : {};
    const m = new Map<string, ContinueReadingEntry>();
    for (const [k, v] of Object.entries(data)) {
      if (v?.titleKey && v?.updatedAt && v?.chapterUrl) m.set(k, v);
    }
    return m;
  } catch {
    return new Map();
  }
}

function saveToStorage(entries: Map<string, ContinueReadingEntry>) {
  try {
    // cap sebelum simpan — keep most recent 20
    const sorted = [...entries.values()].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    const capped = new Map<string, ContinueReadingEntry>();
    for (const e of sorted.slice(0, MAX_ENTRIES)) capped.set(e.titleKey, e);
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(capped)));
    return capped;
  } catch {
    return entries;
  }
}

// — builder helpers — caller tidak perlu tahu mapping field manual —
export function buildEntryFromChapter(ch: {
  title: string;
  titleKey: string;
  cover?: string | null;
  source: string;
  chapter?: string | null;
  chapterLabel?: string | null;
  chapterNumber?: number | string | null;
  chapterUrl?: string | null;
  url?: string | null;
  seriesUrl?: string | null;
  origin?: string | null;
}): ContinueReadingEntry | null {
  const titleKey = ch.titleKey?.trim();
  if (!titleKey) return null;
  const chapterUrl = (ch.chapterUrl || ch.url || ch.seriesUrl || "").trim();
  if (!chapterUrl) return null;
  const lastChapter =
    (ch.chapterLabel && String(ch.chapterLabel).trim()) ||
    (ch.chapterNumber != null ? String(ch.chapterNumber).trim() : "") ||
    (ch.chapter && String(ch.chapter).trim()) ||
    "?";
  return {
    title: ch.title || titleKey,
    titleKey,
    cover: ch.cover ?? null,
    source: ch.source || "unknown",
    lastChapter,
    chapterUrl,
    seriesUrl: ch.seriesUrl || chapterUrl,
    origin: ch.origin || "",
    updatedAt: new Date().toISOString(),
  };
}

export function useContinueReading() {
  const [entries, setEntries] = useState<Map<string, ContinueReadingEntry>>(
    () => new Map()
  );
  const hasHydrated = useRef(false);

  // Load from localStorage after mount — avoids hydration mismatch (server empty vs client populated)
  useEffect(() => {
    const loaded = loadFromStorage();
    if (loaded.size > 0) setEntries(loaded);
  }, []);

  // Hydrate from backend (cross-device) — merges with local, newer wins (once globally to avoid spam)
  useEffect(() => {
    if (globalHasFetched) {
      const t = setTimeout(() => {
        hasHydrated.current = true;
      }, 1200);
      return () => clearTimeout(t);
    }
    globalHasFetched = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(SYNC_ENDPOINT, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = await res.json().catch(() => null);
        const remote: Record<string, ContinueReadingEntry> =
          body?.data ?? body ?? {};
        if (!remote || typeof remote !== "object") return;
        setEntries((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const [k, v] of Object.entries(remote)) {
            if (!v?.titleKey || !v?.updatedAt) continue;
            const cur = next.get(k);
            if (!cur || new Date(v.updatedAt) > new Date(cur.updatedAt)) {
              next.set(k, v);
              changed = true;
            }
          }
          if (changed) saveToStorage(next);
          return changed ? next : prev;
        });
      } catch {
        /* backend not yet implemented — keep local only */
      } finally {
        hasHydrated.current = true;
      }
    })();
    const t = setTimeout(() => {
      hasHydrated.current = true;
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    // Skip initial empty save before storage load (avoids wiping localStorage on hydration)
    if (entries.size === 0 && !hasHydrated.current) {
      const raw =
        typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
      if (raw) return;
    }
    saveToStorage(entries);
    if (!hasHydrated.current) return;
    const id = setTimeout(() => {
      // Filter invalid entries before sync — BE requires titleKey + chapterUrl
      const clean = Object.fromEntries(
        [...entries].filter(
          ([, v]) => v?.titleKey?.trim() && v?.chapterUrl?.trim()
        )
      );
      if (Object.keys(clean).length === 0 && entries.size > 0) {
        // All entries invalid → clean localStorage to stop spam
        try {
          localStorage.removeItem(LS_KEY);
        } catch {}
        return;
      }
      fetch(
        SYNC_ENDPOINT,
        withCsrf({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(clean),
        })
      ).catch(() => {});
    }, 1500);
    return () => clearTimeout(id);
  }, [entries]);

  const trackReading = useCallback((entry: ContinueReadingEntry) => {
    if (!entry?.titleKey || !entry?.chapterUrl) return;
    setEntries((prev) => {
      const existing = prev.get(entry.titleKey);
      if (
        existing &&
        new Date(entry.updatedAt) <= new Date(existing.updatedAt)
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(entry.titleKey, entry);
      if (next.size > MAX_ENTRIES) {
        const sorted = [...next.values()].sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        const capped = new Map<string, ContinueReadingEntry>();
        for (const e of sorted.slice(0, MAX_ENTRIES)) capped.set(e.titleKey, e);
        return capped;
      }
      return next;
    });
  }, []);

  const trackChapter = useCallback(
    (ch: Parameters<typeof buildEntryFromChapter>[0]) => {
      const entry = buildEntryFromChapter(ch);
      if (entry) trackReading(entry);
    },
    [trackReading]
  );

  const removeReading = useCallback((titleKey: string) => {
    setEntries((prev) => {
      const next = new Map(prev);
      next.delete(titleKey);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setEntries(new Map());
  }, []);

  return {
    entries,
    trackReading,
    trackChapter,
    removeReading,
    clearAll,
  };
}
