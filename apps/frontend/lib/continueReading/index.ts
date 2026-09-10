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

// — sync (was sync.ts) —
const SYNC_ENDPOINT = "/api/v1/continue-reading";
export async function fetchRemote(): Promise<
  Record<string, ContinueReadingEntry>
> {
  const res = await fetch(SYNC_ENDPOINT, { cache: "no-store", credentials: "include" });
  if (!res.ok) return {};
  const body = await res.json().catch(() => null);
  const remote: Record<string, ContinueReadingEntry> = body?.data ?? body ?? {};
  if (!remote || typeof remote !== "object") return {};
  return remote;
}
export async function pushRemote(
  clean: Record<string, ContinueReadingEntry>
): Promise<void> {
  const res = await fetch(
    SYNC_ENDPOINT,
    withCsrf({
      method: "PUT",
      credentials: "include" as RequestCredentials,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clean),
    })
  ).catch(() => null as unknown as Response);
  if (!res || !res.ok) {
    const err = new Error(`push failed ${res?.status ?? "network"}`);
    (err as unknown as { status?: number }).status = res?.status;
    throw err;
  }
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

let globalLastPushed = "";
let globalLastPushTime = 0;
let consecutiveFailures = 0;
let globalHasFetchedRemote = false;
let globalFetchPromise: Promise<Record<string, ContinueReadingEntry>> | null =
  null;

export function useContinueReading(
  store: ContinueReadingStore = localStorageStore,
  sync: {
    fetchRemote?: typeof fetchRemote;
    pushRemote?: typeof pushRemote;
  } = {}
) {
  const {
    fetchRemote: doFetch = fetchRemote,
    pushRemote: doPush = pushRemote,
  } = sync;
  const [entries, setEntries] = useState<Map<string, ContinueReadingEntry>>(
    () => new Map()
  );
  const hasHydrated = useRef(false);
  useEffect(() => {
    const loaded = store.load();
    if (loaded.size > 0) setEntries(loaded);
    const id = setTimeout(() => {
      hasHydrated.current = true;
    }, 0);
    return () => clearTimeout(id);
  }, [store]);
  useEffect(() => {
    if (
      typeof document !== "undefined" &&
      !document.cookie.match(/(?:^|;\s*)ikiru_csrf_token=/)
    ) {
      hasHydrated.current = true;
      globalHasFetchedRemote = true;
      return;
    }
    if (globalHasFetchedRemote) {
      hasHydrated.current = true;
      return;
    }
    globalHasFetchedRemote = true;
    let cancelled = false;
    let didFinish = false;
    (async () => {
      try {
        if (!globalFetchPromise) globalFetchPromise = doFetch();
        const remote = await globalFetchPromise;
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
        globalHasFetchedRemote = false;
        globalFetchPromise = null;
        setTimeout(() => {
          globalHasFetchedRemote = false;
        }, 60000);
      } finally {
        didFinish = true;
        if (!cancelled) hasHydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
      // StrictMode: first mount unmounted before fetch finished — reset globals so second mount fetches
      if (!didFinish) {
        globalHasFetchedRemote = false;
        globalFetchPromise = null;
      }
    };
  }, [store, doFetch]);
  useEffect(() => {
    if (entries.size === 0 && !hasHydrated.current) {
      const loaded = store.load();
      if (loaded.size > 0) return;
    }
    store.save(entries);
    if (!hasHydrated.current) return;
    if (entries.size === 0) return;
    if (
      typeof document !== "undefined" &&
      !document.cookie.match(/(?:^|;\s*)ikiru_csrf_token=/)
    )
      return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (consecutiveFailures >= 3 && Date.now() - globalLastPushTime < 60000)
      return;
    const clean = Object.fromEntries(
      [...entries].filter(
        ([, v]) => v?.titleKey?.trim() && v?.chapterUrl?.trim()
      )
    );
    if (Object.keys(clean).length === 0) {
      if (entries.size > 0) store.clear();
      return;
    }
    const payloadStr = JSON.stringify(clean);
    if (payloadStr === globalLastPushed) return;
    const delay = 8000 + Math.random() * 2000;
    const id = setTimeout(() => {
      if (payloadStr === globalLastPushed) return;
      if (consecutiveFailures >= 3 && Date.now() - globalLastPushTime < 60000)
        return;
      globalLastPushed = payloadStr;
      globalLastPushTime = Date.now();
      doPush(clean as Record<string, ContinueReadingEntry>).then(
        () => {
          consecutiveFailures = 0;
        },
        () => {
          consecutiveFailures += 1;
          if (consecutiveFailures < 3) globalLastPushed = "";
        }
      );
    }, delay);
    return () => clearTimeout(id);
  }, [entries, store, doPush]);
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
  }, []);
  const clearAll = useCallback(() => {
    setEntries(new Map());
  }, []);
  return { entries, trackReading, trackChapter, removeReading, clearAll };
}
