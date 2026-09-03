import type { ContinueReadingEntry } from "./index";

const LS_KEY = "continue_reading";
export const MAX_ENTRIES = 20;

export interface ContinueReadingStore {
  load(): Map<string, ContinueReadingEntry>;
  save(entries: Map<string, ContinueReadingEntry>): Map<string, ContinueReadingEntry>;
  clear(): void;
}

function loadFromStorage(): Map<string, ContinueReadingEntry> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(LS_KEY);
    const data: Record<string, ContinueReadingEntry> = raw ? JSON.parse(raw) : {};
    const m = new Map<string, ContinueReadingEntry>();
    for (const [k, v] of Object.entries(data)) {
      if (v?.titleKey && v?.updatedAt && v?.chapterUrl) m.set(k, v);
    }
    return m;
  } catch {
    return new Map();
  }
}

function saveToStorage(entries: Map<string, ContinueReadingEntry>): Map<string, ContinueReadingEntry> {
  try {
    const sorted = [...entries.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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

export function createInMemoryStore(initial?: Map<string, ContinueReadingEntry>): ContinueReadingStore {
  let mem = new Map(initial);
  return {
    load: () => new Map(mem),
    save: (entries) => {
      const sorted = [...entries.values()].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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
