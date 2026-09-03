// Reusable feed domain — single source for FlatChapter + helpers
// Deep module seam: AllTab, Home, Group, Reader share this.

export interface FlatChapter {
  title: string;
  titleKey: string;
  canonicalTitleKey?: string;
  isSent?: boolean;
  chapter: string;
  chapterLabel: string;
  chapterNumber: number;
  url: string;
  chapterUrl: string;
  source: string;
  cover: string;
  origin: string;
  type?: string | null;
  seriesUrl: string;
  status?: string | null;
  rating?: string | number | null;
  genres?: string[];
  isWhitelisted: boolean;
  createdAt: string;
  sentAt: string;
  description?: string | null;
}

export const KNOWN_ORIGINS = ["korean", "japanese", "chinese"] as const;

export const KNOWN_TYPES = ["manhwa", "manhua"] as const;
export const NO_TYPE = "no_type" as const;

export function normalizeType(t: unknown): string {
  const v = String(t ?? "").trim().toLowerCase();
  if ((KNOWN_TYPES as readonly string[]).includes(v)) return v;
  return NO_TYPE;
}
export function typeLabel(t: string): string {
  if (t === "manhwa") return "Manhwa";
  if (t === "manhua") return "Manhua";
  return "No Type";
}

export function resolveSeriesUrl(c: FlatChapter): string {
  return c.seriesUrl || c.chapterUrl;
}

export function compareFlatByNewest(a: FlatChapter, b: FlatChapter): number {
  const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
  const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
  if (tb !== ta) return tb - ta;
  if (a.titleKey !== b.titleKey) return a.titleKey.localeCompare(b.titleKey);
  return (a.chapterUrl || a.url || "").localeCompare(
    b.chapterUrl || b.url || ""
  );
}

export function chapterKey(c: FlatChapter): string {
  return `${c.titleKey}:${c.source}:${c.chapterUrl || c.url || c.chapter}`;
}
