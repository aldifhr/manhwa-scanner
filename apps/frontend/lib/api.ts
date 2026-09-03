import { WhitelistRouteItem } from "@/lib/types";
import { Reader } from "@/lib/reader";

export async function getWhitelist(
  page = 1,
  pageSize = 1000
): Promise<WhitelistRouteItem[]> {
  return Reader.getWhitelist(page, pageSize) as unknown as Promise<
    WhitelistRouteItem[]
  >;
}

/* ── History (GET /api/history) ── */
/** Flat per-chapter log of what was actually delivered. */
import {
  DispatchHistoryItem,
  ExcludedTitleItem,
  RssFlatPage,
  CatalogResolveResult,
  StatsData,
  QueueDepth,
  AnalyticsOverview,
  AnalyticsSeriesDetail,
  AnalyticsEngagement,
  RssCustomFeedResult,
  RssFilterMetadata,
  DashboardSnapshot,
} from "@/lib/types";

/* ── Whitelist mutations — delegate to Reader seam (no bare fetch) ── */

export async function addWhitelistEntry(data: {
  title: string;
  seriesUrl?: string;
  source?: string;
  title_key?: string;
  cover?: string | null;
  status?: string | null;
  rating?: string | number | null;
  origin?: string | null;
  type?: string | null;
  genres?: string[];
  description?: string | null;
}): Promise<{ status: "added" | "already_exists" }> {
  const body: Record<string, unknown> = { title: data.title };
  if (data.seriesUrl) body.url = data.seriesUrl;
  if (data.source) body.source = data.source;
  if (data.title_key) body.title_key = data.title_key;
  if (data.cover) body.cover = data.cover;
  if (data.status) body.status = data.status;
  if (data.rating !== null && data.rating !== undefined) body.rating = data.rating;
  if (data.origin) body.origin = data.origin;
  if (data.type) body.type = data.type;
  if (data.genres && data.genres.length > 0) body.genres = data.genres;
  if (data.description) body.description = data.description;
  return Reader.addWhitelistEntry(body) as Promise<{ status: "added" | "already_exists" }>;
}

export async function removeWhitelistEntry(data: {
  title_key?: string;
  title?: string;
  url?: string;
  source?: string;
}): Promise<void> {
  return Reader.removeWhitelistEntry(data as Record<string, unknown>);
}

/* ── Excluded titles (RSS "Exclude" feature) — delegate to Reader ── */

export async function getExcludedTitles(): Promise<ExcludedTitleItem[]> {
  return Reader.getExcludedTitles() as Promise<ExcludedTitleItem[]>;
}

export async function addExcludedTitle(data: {
  title_key: string;
  title?: string;
  source?: string;
  cover?: string | null;
  series_url?: string | null;
}): Promise<{ status: "ok" | "error" }> {
  return Reader.addExcludedTitle(data as Record<string, unknown>) as Promise<{ status: "ok" | "error" }>;
}

export async function removeExcludedTitle(data: {
  title_key: string;
  source?: string;
}): Promise<void> {
  return Reader.removeExcludedTitle(data as Record<string, unknown>);
}

export async function bulkExcludeBySource(source: string): Promise<{ excluded: number }> {
  return Reader.bulkExcludeBySource(source);
}

/* ── RSS Flat (no grouping) ── */

/** Fetch a single page of the flat RSS feed (server-side paginated). */
export async function getRssFeedFlatPage(
  page: number,
  limit = 1000,
  exclude?: string,
  whitelist = false,
  source?: string | null,
  type?: string | null
): Promise<RssFlatPage> {
  return Reader.getRssFlatPage(page, limit, {
    exclude,
    whitelist,
    source,
    type,
  }) as unknown as Promise<RssFlatPage>;
}

/**
 * Count RSS series (distinct titleKey) newer than `lastSeen`. Uses the backend's lightweight
 * /api/rss/new?since= endpoint (single request). No fallback walk — pure BE count.
 * @param opts.distinct - jika false hitung chapter, default true = hitung judul unik (series)
 */
export async function countNewSince(
  lastSeen: number,
  opts?: { distinct?: boolean }
): Promise<number> {
  return Reader.countNewSince(lastSeen, opts);
}

/* ── URL Resolver (GET /api/catalog/resolve) ── */

export async function resolveCatalogUrl(
  url: string
): Promise<CatalogResolveResult | null> {
  return Reader.resolveCatalogUrl(url) as Promise<CatalogResolveResult | null>;
}

/* ── Dispatch History ── */

export async function getDispatchHistory(
  page = 1,
  pageSize = 50,
  search = ""
): Promise<DispatchHistoryItem[]> {
  return Reader.getDispatchHistory(
    page,
    pageSize,
    search
  ) as unknown as Promise<DispatchHistoryItem[]>;
}

/* ── Stats (GET /api/reader/stats) ── */

export async function getStats(): Promise<StatsData | null> {
  return Reader.getStats() as Promise<StatsData | null>;
}

/* ── Dashboard snapshot (overview widgets) ── */

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  return Reader.getDashboardSnapshot() as Promise<DashboardSnapshot>;
}

/* ── Live dispatch queue depth (GET /api/reader/queue) ── */

export async function getQueueDepth(): Promise<QueueDepth> {
  return Reader.getQueueDepth() as Promise<QueueDepth>;
}

export async function getHealthDetailed(): Promise<{
  sources: Array<{
    name: string;
    status: string;
    lastScrape: string;
    lastSuccess: string;
    errorRate24h: number;
    consecutiveFailures: number;
    lastError: string | null;
    disabledUntil: string | null;
  }>;
  overall: string;
  uptime: number;
  version: string;
  circuit_breakers: Record<string, string>;
  db_pool: Record<string, number>;
}> {
  const { readerFetch } = await import("@/lib/reader/transport");
  const body = await readerFetch<{ success: boolean; data: unknown }>("/api/v1/health/detailed");
  return (body as unknown as { data: unknown }).data as unknown as {
    sources: Array<{
      name: string;
      status: string;
      lastScrape: string;
      lastSuccess: string;
      errorRate24h: number;
      consecutiveFailures: number;
      lastError: string | null;
      disabledUntil: string | null;
    }>;
    overall: string;
    uptime: number;
    version: string;
    circuit_breakers: Record<string, string>;
    db_pool: Record<string, number>;
  };
}

/* ── Analytics (GET /api/analytics/*) ── */

export async function getAnalyticsOverview(): Promise<AnalyticsOverview | null> {
  return Reader.getAnalyticsOverview() as Promise<AnalyticsOverview | null>;
}

export async function getAnalyticsSeriesDetail(
  titleKey: string
): Promise<AnalyticsSeriesDetail | null> {
  return Reader.getAnalyticsSeriesDetail(
    titleKey
  ) as Promise<AnalyticsSeriesDetail | null>;
}

export async function getAnalyticsEngagement(): Promise<AnalyticsEngagement | null> {
  return Reader.getAnalyticsEngagement() as Promise<AnalyticsEngagement | null>;
}

/* ── Custom RSS Feed (GET /api/rss/custom) ── */

export async function getRssCustomFeed(params: {
  genres?: string;
  sources?: string;
  origins?: string;
  status?: string;
  minRating?: string;
  maxRating?: string;
  unreadOnly?: boolean;
  subscribedOnly?: boolean;
  sort?: string;
  limit?: number;
  page?: number;
}): Promise<RssCustomFeedResult> {
  return Reader.getRssCustomFeed(
    params
  ) as unknown as Promise<RssCustomFeedResult>;
}

export async function getRssFilterMetadata(): Promise<RssFilterMetadata> {
  return Reader.getRssFilterMetadata() as unknown as Promise<RssFilterMetadata>;
}

/* ── Audit Log removed — page deleted per CONTEXT.md 2026-09-02 ── */

/* ── Bookmarks (GET/POST/DELETE /api/v1/bookmarks) ── */

export interface BookmarkEntry {
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source: string;
  position_pct: number;
  updated_at: string;
  title?: string;
  cover?: string | null;
}

export async function getBookmarks(): Promise<BookmarkEntry[]> {
  const { readerFetch } = await import("@/lib/reader/transport");
  const body = await readerFetch<{ success: boolean; data: BookmarkEntry[] }>("/api/v1/bookmarks");
  return body.data || [];
}

export async function saveBookmark(data: {
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source?: string;
  position_pct?: number;
  title?: string;
  cover?: string | null;
}): Promise<void> {
  const { readerFetch } = await import("@/lib/reader/transport");
  await readerFetch("/api/v1/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteBookmark(titleKey: string, chapterNumber: number): Promise<void> {
  const { readerFetch } = await import("@/lib/reader/transport");
  await readerFetch(`/api/v1/bookmarks/${titleKey}/${chapterNumber}`, {
    method: "DELETE",
  });
}

/* ── A/B Testing removed — /ab-tests page deleted per CONTEXT.md 2026-09-02 ── */
