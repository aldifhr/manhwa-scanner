import type { FlatChapter } from "@/lib/feed";

function normalizeTitleKey(k: string): string {
  if (!k) return "";
  return k.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function coverPriority(source: string): number {
  const s = (source || "").toLowerCase();
  if (s === "shinigami") return 0;
  if (s === "ikiru") return 1;
  if (s === "voratoon") return 2;
  return 10;
}
function isVoratoonExpired(cover: string): boolean {
  if (!cover || !cover.includes("cvr.voratoon.id")) return false;
  const m = cover.match(/X-Amz-Date=([^&]+).*?X-Amz-Expires=(\d+)/);
  if (!m) return false;
  try {
    const d = m[1]; // 20260828T025606Z
    const exp = parseInt(m[2], 10);
    const dt = new Date(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,11)+":"+d.slice(11,13)+":"+d.slice(13,15)+"Z");
    const expiry = dt.getTime() + exp*1000;
    return Date.now() > expiry - 24*3600*1000; // treat as expired if <24h left
  } catch { return false; }
}


interface GroupedChapter {
  /** unique key per chapter+source */
  key: string;
  chapter: string;
  chapterLabel: string;
  chapterNumber: number;
  titleKey: string;
  url: string;
  chapterUrl: string;
  source: string;
  sentAt: string;
  createdAt: string;
  seriesUrl: string;
  isSent?: boolean;
  isWhitelisted: boolean;
}

export interface GroupedSeries {
  titleKey: string;
  title: string;
  cover: string;
  origin: string;
  seriesUrl: string;
  status?: string | null;
  rating?: string | number | null;
  genres?: string[];
  description?: string | null;
  isWhitelisted: boolean;
  sentAt?: string;
  chapters: GroupedChapter[];
}

/** Group flat RSS rows. Group key is normalized titleKey (dash/space/case) so the SAME title
 *  from multiple sources (ikiru/shinigami/voratoon) merges into ONE card
 *  with merged chapters. Cover priority: shinigami > ikiru > voratoon (non-expired). */
export function groupChapters(items: FlatChapter[]): GroupedSeries[] {
  const map = new Map<string, GroupedSeries & { _sources: Set<string> }>();
  for (const it of items) {
    const tk = it.titleKey;
    const gk = normalizeTitleKey(tk); // dedup across dash/space/case/uuid
    let g = map.get(gk);
    if (!g) {
      g = {
        titleKey: tk,
        title: it.title,
        cover: it.cover,
        origin: it.origin,
        seriesUrl: it.seriesUrl,
        status: it.status,
        rating: it.rating,
        genres: it.genres,
        description: it.description,
        isWhitelisted: it.isWhitelisted,
        chapters: [],
        _sources: new Set([it.source]),
      } as any;
      map.set(gk, g!);
    } else {
      g._sources.add(it.source);
    }
    g!.chapters.push({
      key: `${tk}:${it.source}:${it.chapter}`,
      titleKey: tk,
      chapter: it.chapter,
      chapterLabel: it.chapterLabel,
      chapterNumber: it.chapterNumber,
      url: it.url,
      chapterUrl: it.chapterUrl,
      source: it.source,
      sentAt: it.sentAt,
      createdAt: it.createdAt,
      seriesUrl: it.seriesUrl,
      isSent: it.isSent,
      isWhitelisted: it.isWhitelisted,
    });
    // keep series-level whitelist flag if any chapter is whitelisted
    if (it.isWhitelisted) g!.isWhitelisted = true;
    // prefer first non-empty description/rating/genres (RSS may have empty desc on one source)
    if (!g!.description && it.description) g!.description = it.description;
    if ((!g!.rating || g!.rating === "") && it.rating) g!.rating = it.rating;
    if ((!g!.genres || g!.genres.length === 0) && it.genres?.length)
      g!.genres = it.genres;
    if (g!.status == null && it.status) g!.status = it.status;
    // keep latest sentAt for label rendering
    if (
      it.sentAt &&
      (!g!.sentAt ||
        new Date(it.sentAt).getTime() > new Date(g!.sentAt).getTime())
    )
      g!.sentAt = it.sentAt;
    // cover priority: shinigami > ikiru > voratoon (non-expired). Expired voratoon presigned is skipped.
    const curPri = g!.cover ? coverPriority((g as any)._coverSource || "") : 99;
    const newPri = coverPriority(it.source);
    const curExpired = isVoratoonExpired(g!.cover);
    const newExpired = isVoratoonExpired(it.cover || "");
    if (it.cover && (!g!.cover || curExpired || (!newExpired && newPri < curPri))) {
      (g as any)._coverSource = it.source;
      g!.cover = it.cover;
      if (it.seriesUrl) g!.seriesUrl = it.seriesUrl;
      // also adopt title from higher priority source if available
      if (it.title && newPri < curPri) g!.title = it.title;
    }
  }
  // cleanup dedup helper
  for (const g of map.values()) delete (g as any)._sources;
  for (const g of map.values()) delete (g as any)._coverSource;
  // Sort chapters within a group by chapter number desc (newest first)
  const out = [...map.values()];
  for (const g of out) {
    g.chapters.sort((a, b) => b.chapterNumber - a.chapterNumber);
  }
  return out;
}

/** True if any chapter in the series arrived within `hours` (default 24). */
export function seriesHasNewWithin(series: GroupedSeries, hours = 24): boolean {
  const cutoff = Date.now() - hours * 3600 * 1000;
  for (const ch of series.chapters) {
    const t = ch.sentAt ? Date.parse(ch.sentAt) : NaN;
    if (!isNaN(t) && t >= cutoff) return true;
  }
  return false;
}
