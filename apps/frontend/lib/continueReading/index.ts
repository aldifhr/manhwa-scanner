// Deep module: ContinueReading — seam for tracking read progress.
// Storage + sync extracted to store.ts / sync.ts for DI + testability.

import { useState, useEffect, useCallback, useRef } from "react";
import { localStorageStore, MAX_ENTRIES, type ContinueReadingStore } from "./store";
import { fetchRemote, pushRemote } from "./sync";

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

export function useContinueReading(
  store: ContinueReadingStore = localStorageStore,
  sync: { fetchRemote?: typeof fetchRemote; pushRemote?: typeof pushRemote } = {}
) {
  const { fetchRemote: doFetch = fetchRemote, pushRemote: doPush = pushRemote } = sync;
  const [entries, setEntries] = useState<Map<string, ContinueReadingEntry>>(() => new Map());
  const hasHydrated = useRef(false);
  const hasFetchedRemote = useRef(false);

  useEffect(() => {
    const loaded = store.load();
    if (loaded.size > 0) setEntries(loaded);
    // mark hydrated after microtask so initial save effect can skip wiping
    const id = setTimeout(() => {
      hasHydrated.current = true;
    }, 0);
    return () => clearTimeout(id);
  }, [store]);

  useEffect(() => {
    if (hasFetchedRemote.current) {
      hasHydrated.current = true;
      return;
    }
    hasFetchedRemote.current = true;
    let cancelled = false;
    (async () => {
      try {
        const remote = await doFetch();
        if (cancelled || !remote || typeof remote !== "object") return;
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
          if (changed) store.save(next);
          return changed ? next : prev;
        });
      } catch {
        /* backend not yet implemented — keep local only */
      } finally {
        if (!cancelled) hasHydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, doFetch]);

  useEffect(() => {
    if (entries.size === 0 && !hasHydrated.current) {
      const loaded = store.load();
      if (loaded.size > 0) return;
    }
    store.save(entries);
    if (!hasHydrated.current) return;
    const id = setTimeout(() => {
      const clean = Object.fromEntries(
        [...entries].filter(([, v]) => v?.titleKey?.trim() && v?.chapterUrl?.trim())
      );
      if (Object.keys(clean).length === 0 && entries.size > 0) {
        store.clear();
        return;
      }
      doPush(clean as Record<string, ContinueReadingEntry>);
    }, 1500);
    return () => clearTimeout(id);
  }, [entries, store, doPush]);

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
