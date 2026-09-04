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

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function resolveDetailUrl(item: WhitelistRouteItem): string | undefined {
  // 1) langsung pakai seriesUrl/url kalau ada
  if (item.seriesUrl && /^https?:\/\//.test(item.seriesUrl))
    return item.seriesUrl;
  if (item.url && /^https?:\/\//.test(item.url)) return item.url;
  const derived = deriveSeriesUrl(item.url);
  if (derived) return derived;

  // 2) fallback untuk voratoon/shinigami/ikiru kalau seriesUrl kosong tapi kita tahu source + title
  //    whitelist merge kadang titleKey jadi UUID shinigami padahal cover voratoon — derive dari title
  const title = (item as unknown as { title?: string }).title || "";
  const sources = (() => {
    const s: string[] = [];
    if (item.source) s.push(item.source);
    if (Array.isArray(item.sources)) {
      for (const x of item.sources) {
        if (typeof x === "string" && x) s.push(x);
        else if (x && typeof x === "object" && "source" in x)
          s.push(String((x as { source: string }).source));
      }
    }
    return s.map((x) => x.toLowerCase());
  })();

  const slug = slugFromTitle(title);
  if (!slug) return undefined;

  if (sources.includes("voratoon"))
    return `https://v1.voratoon.com/series/${slug}`;
  if (sources.includes("ikiru")) return `https://07.ikiru.wtf/manga/${slug}/`;
  if (sources.includes("shinigami")) {
    // kalau titleKey UUID, pakai itu; kalau bukan, pakai slug title
    const rawKey =
      (item as unknown as { titleKey?: string; id?: string }).titleKey ||
      (item as unknown as { id?: string }).id ||
      "";
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        rawKey
      );
    if (isUuid) return `https://11.shinigami.asia/series/${rawKey}`;
    return `https://11.shinigami.asia/series/${slug}`;
  }

  return undefined;
}
