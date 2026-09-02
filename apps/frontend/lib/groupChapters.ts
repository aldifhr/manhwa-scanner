import type { FlatChapter } from "@/lib/feed";

interface GroupedChapter {
  /** unique key per chapter+source */
  key: string;
  chapter: string;
  chapterLabel: string;
  chapterNumber: number;
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

/** Group flat RSS rows. Group key is titleKey + source so the SAME title
 *  from multiple sources (ikiru / shinigami / voratoon) shows as SEPARATE
 *  cards — each linking to its own source series page. (Previously grouped
 *  by titleKey alone, which forced one card with a single arbitrary URL.) */
export function groupChapters(items: FlatChapter[]): GroupedSeries[] {
  const map = new Map<string, GroupedSeries>();
  for (const it of items) {
    const tk = it.titleKey;
    const gk = `${tk}::${it.source}`; // per-source group key
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
      };
      map.set(gk, g);
    }
    g.chapters.push({
      key: `${tk}:${it.source}:${it.chapter}`,
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
    if (it.isWhitelisted) g.isWhitelisted = true;
    // prefer first non-empty description/rating/genres (RSS may have empty desc on one source)
    if (!g.description && it.description) g.description = it.description;
    if ((!g.rating || g.rating === "") && it.rating) g.rating = it.rating;
    if ((!g.genres || g.genres.length === 0) && it.genres?.length)
      g.genres = it.genres;
    if (g.status == null && it.status) g.status = it.status;
    // keep latest sentAt for label rendering
    if (
      it.sentAt &&
      (!g.sentAt ||
        new Date(it.sentAt).getTime() > new Date(g.sentAt).getTime())
    )
      g.sentAt = it.sentAt;
    // prefer a non-empty cover; when we adopt a new cover, also adopt that
    // item's seriesUrl so the card's link matches its visible identity
    // (otherwise a voratoon cover + tag could link to a shinigami URL when
    // the two sources share a title_key but have different series pages).
    if (!g.cover && it.cover) {
      g.cover = it.cover;
      if (it.seriesUrl) g.seriesUrl = it.seriesUrl;
    }
  }
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
