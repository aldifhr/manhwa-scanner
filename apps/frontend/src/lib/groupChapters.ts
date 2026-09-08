import type { FlatChapter } from "$lib/feed";

function normalizeTitleKey(k: string): string {
  if (!k) return "";
  return k
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    const dt = new Date(
      d.slice(0, 4) +
        "-" +
        d.slice(4, 6) +
        "-" +
        d.slice(6, 11) +
        ":" +
        d.slice(11, 13) +
        ":" +
        d.slice(13, 15) +
        "Z"
    );
    const expiry = dt.getTime() + exp * 1000;
    return Date.now() > expiry - 24 * 3600 * 1000; // treat as expired if <24h left
  } catch {
    return false;
  }
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
  type?: string | null;
  seriesUrl: string;
  rating?: string | number | null;
  genres?: string[];
  description?: string | null;
  isWhitelisted: boolean;
  sentAt?: string;
  chapters: GroupedChapter[];
}

/** Group flat RSS rows. Group key is normalized titleKey + source, so SAME title
 *  from different sources stays as separate cards (per-source split). */
export function groupChapters(items: FlatChapter[]): GroupedSeries[] {
  const map = new Map<string, GroupedSeries>();
  const coverSource = new Map<string, string>();
  for (const it of items) {
    const tk = it.titleKey;
    const gk = `${normalizeTitleKey(tk)}|${it.source || ""}`; // per-source split
    let g = map.get(gk);
    if (!g) {
      g = {
        titleKey: tk,
        title: it.title,
        cover: it.cover,
        origin: it.origin,
        type: (it as unknown as { type?: string | null }).type ?? null,
        seriesUrl: it.seriesUrl,
        rating: it.rating,
        genres: it.genres,
        description: it.description,
        isWhitelisted: it.isWhitelisted,
        chapters: [],
      };
      map.set(gk, g!);
      if (it.cover) coverSource.set(gk, it.source);
    } else {
      // keep type if missing (for flag visibility)
      if (!g!.type && it.type) g!.type = it.type;
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
    // keep latest sentAt for label rendering
    if (
      it.sentAt &&
      (!g!.sentAt ||
        new Date(it.sentAt).getTime() > new Date(g!.sentAt).getTime())
    )
      g!.sentAt = it.sentAt;
    // cover priority: shinigami > ikiru > voratoon (non-expired). Expired voratoon presigned is skipped.
    const curPri = g!.cover ? coverPriority(coverSource.get(gk) || "") : 99;
    const newPri = coverPriority(it.source);
    const curExpired = isVoratoonExpired(g!.cover);
    const newExpired = isVoratoonExpired(it.cover || "");
    if (
      it.cover &&
      (!g!.cover || curExpired || (!newExpired && newPri < curPri))
    ) {
      coverSource.set(gk, it.source);
      g!.cover = it.cover;
      if (it.seriesUrl) g!.seriesUrl = it.seriesUrl;
      // also adopt title from higher priority source if available
      if (it.title && newPri < curPri) g!.title = it.title;
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


