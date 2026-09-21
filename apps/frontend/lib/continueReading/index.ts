import { useState, useEffect, useCallback } from "react";

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

// — store (was store.ts) —
const LS_KEY = "continue_reading";
export const MAX_ENTRIES = 20;
export interface ContinueReadingStore {
  load(): Map<string, ContinueReadingEntry>;
  save(
    entries: Map<string, ContinueReadingEntry>
  ): Map<string, ContinueReadingEntry>;
  clear(): void;
}
function loadFromStorage(): Map<string, ContinueReadingEntry> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(LS_KEY);
    const data: Record<string, ContinueReadingEntry> = raw
      ? JSON.parse(raw)
      : {};
    const m = new Map<string, ContinueReadingEntry>();
    for (const [k, v] of Object.entries(data))
      if (v?.titleKey && v?.updatedAt && v?.chapterUrl) m.set(k, v);
    return m;
  } catch {
    return new Map();
  }
}
function saveToStorage(
  entries: Map<string, ContinueReadingEntry>
): Map<string, ContinueReadingEntry> {
  try {
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
export const localStorageStore: ContinueReadingStore = {
  load: loadFromStorage,
  save: saveToStorage,
  clear: () => {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {}
  },
};
export function createInMemoryStore(
  initial?: Map<string, ContinueReadingEntry>
): ContinueReadingStore {
  let mem = new Map(initial);
  return {
    load: () => new Map(mem),
    save: (entries) => {
      const sorted = [...entries.values()].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      mem = new Map<string, ContinueReadingEntry>();
      for (const e of sorted.slice(0, MAX_ENTRIES)) mem.set(e.titleKey, e);
      return new Map(mem);
    },
    clear: () => {
      mem = new Map();
    },
  };
}

// — sync via BE continue_reading table per device (session_hash) —
async function fetchFromApi(): Promise<Map<string, ContinueReadingEntry> | null> {
  try {
    const res = await fetch("/api/v1/continue-reading", { credentials: "include" });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const entries = j?.data?.entries;
    if (!entries || typeof entries !== "object") return null;
    const m = new Map<string, ContinueReadingEntry>();
    for (const [k, v] of Object.entries(entries as Record<string, ContinueReadingEntry>)) if ((v as any)?.titleKey) m.set(k, v as ContinueReadingEntry);
    return m;
  } catch {
    return null;
  }
}
async function saveToApi(entries: Map<string, ContinueReadingEntry>): Promise<void> {
  try {
    await fetch("/api/v1/continue-reading", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: Object.fromEntries(entries) }),
    });
  } catch {}
}

// — builder helpers —
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
  store: ContinueReadingStore = localStorageStore
) {
  const [entries, setEntries] = useState<Map<string, ContinueReadingEntry>>(
    () => new Map()
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = store.load();
      const remote = await fetchFromApi();
      if (cancelled) return;
      if (remote && remote.size > 0) {
        // merge: remote wins if newer
        const merged = new Map(local);
        for (const [k, v] of remote) {
          const lv = merged.get(k);
          if (!lv || new Date(v.updatedAt) > new Date(lv.updatedAt)) merged.set(k, v);
        }
        if (merged.size > 0) setEntries(merged);
        else if (local.size > 0) setEntries(local);
      } else if (local.size > 0) setEntries(local);
    })();
    return () => { cancelled = true; };
  }, [store]);
  useEffect(() => {
    store.save(entries);
    if (entries.size > 0) saveToApi(entries);
  }, [entries, store]);
  const trackReading = useCallback((entry: ContinueReadingEntry) => {
    if (!entry?.titleKey || !entry?.chapterUrl) return;
    setEntries((prev) => {
      const existing = prev.get(entry.titleKey);
      if (existing && new Date(entry.updatedAt) <= new Date(existing.updatedAt))
        return prev;
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
    fetch("/api/v1/continue-reading", {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titleKey }),
    }).catch(() => {});
  }, []);
  const clearAll = useCallback(() => {
    setEntries(new Map());
    fetch("/api/v1/continue-reading", { method: "DELETE", credentials: "include" }).catch(() => {});
  }, []);
  return { entries, trackReading, trackChapter, removeReading, clearAll };
}
