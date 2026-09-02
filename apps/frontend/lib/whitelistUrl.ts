import type { WhitelistRouteItem } from "@/lib/types";

export function deriveSeriesUrl(chapterUrl?: string): string | undefined {
  if (!chapterUrl) return undefined;
  try {
    const u = new URL(chapterUrl);
    const segs = u.pathname.split("/").filter(Boolean);
    const mi = segs.indexOf("manga");
    if (mi !== -1 && segs[mi + 1]) return `${u.origin}/manga/${segs[mi + 1]}/`;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function resolveDetailUrl(item: WhitelistRouteItem): string | undefined {
  return item.seriesUrl || item.url || deriveSeriesUrl(item.url);
}
