const LS_KEY = "continueReading";
const MAX_ENTRIES = 20;

export interface ContinueReadingEntry {
  titleKey: string;
  title: string;
  cover: string | null;
  source: string;
  lastChapter: string;
  chapterUrl: string;
  seriesUrl: string;
  origin: string;
  updatedAt: string;
}

export function loadContinueReading(): ContinueReadingEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ContinueReadingEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveContinueReading(entries: ContinueReadingEntry[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {}
}

export function trackChapter(ch: any) {
  if (!ch || !ch.titleKey) return;
  const entries = loadContinueReading();
  const idx = entries.findIndex((e) => e.titleKey === ch.titleKey);
  const entry: ContinueReadingEntry = {
    titleKey: ch.titleKey,
    title: ch.title || ch.titleKey,
    cover: ch.cover || null,
    source: ch.source || "",
    lastChapter: ch.chapterLabel || String(ch.chapterNumber || ""),
    chapterUrl: ch.chapterUrl || ch.url || "",
    seriesUrl: ch.seriesUrl || "",
    origin: ch.origin || "",
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) entries[idx] = entry;
  else entries.unshift(entry);
  saveContinueReading(entries);
}

export function removeContinueReadingEntry(titleKey: string) {
  saveContinueReading(loadContinueReading().filter((e) => e.titleKey !== titleKey));
}

export function clearContinueReading() {
  saveContinueReading([]);
}
