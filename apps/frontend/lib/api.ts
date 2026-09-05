import { Reader } from "@/lib/reader";
import type {
  WhitelistRouteItem,
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

// Thin compat shim — all logic lives in Reader (single seam). Keep named exports for existing imports.
export const getWhitelist = (page = 1, pageSize = 1000) =>
  Reader.getWhitelist(page, pageSize) as unknown as Promise<
    WhitelistRouteItem[]
  >;

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
  if (data.rating != null) body.rating = data.rating;
  if (data.origin) body.origin = data.origin;
  if (data.type) body.type = data.type;
  if (data.genres?.length) body.genres = data.genres;
  if (data.description) body.description = data.description;
  return Reader.addWhitelistEntry(body) as Promise<{
    status: "added" | "already_exists";
  }>;
}
export const removeWhitelistEntry = (data: {
  title_key?: string;
  title?: string;
  url?: string;
  source?: string;
}) => Reader.removeWhitelistEntry(data as Record<string, unknown>);
export const getExcludedTitles = () =>
  Reader.getExcludedTitles() as Promise<ExcludedTitleItem[]>;
export const addExcludedTitle = (data: {
  title_key: string;
  title?: string;
  source?: string;
  cover?: string | null;
  series_url?: string | null;
}) =>
  Reader.addExcludedTitle(data as Record<string, unknown>) as Promise<{
    status: "ok" | "error";
  }>;
export const removeExcludedTitle = (data: {
  title_key: string;
  source?: string;
}) => Reader.removeExcludedTitle(data as Record<string, unknown>);
export const bulkExcludeBySource = (source: string) =>
  Reader.bulkExcludeBySource(source);
export const getRssFeedFlatPage = (
  page: number,
  limit = 1000,
  exclude?: string,
  whitelist = false,
  source?: string | null,
  type?: string | null
) =>
  Reader.getRssFlatPage(page, limit, {
    exclude,
    whitelist,
    source,
    type,
  }) as unknown as Promise<RssFlatPage>;
export const countNewSince = (
  lastSeen: number,
  opts?: { distinct?: boolean }
) => Reader.countNewSince(lastSeen, opts);
export const resolveCatalogUrl = (url: string) =>
  Reader.resolveCatalogUrl(url) as Promise<CatalogResolveResult | null>;
export const getDispatchHistory = (page = 1, pageSize = 50, search = "") =>
  Reader.getDispatchHistory(page, pageSize, search) as unknown as Promise<
    DispatchHistoryItem[]
  >;
export const getStats = () => Reader.getStats() as Promise<StatsData | null>;
export const getDashboardSnapshot = () =>
  Reader.getDashboardSnapshot() as Promise<DashboardSnapshot>;
export const getQueueDepth = () =>
  Reader.getQueueDepth() as Promise<QueueDepth>;
export const getAnalyticsOverview = () =>
  Reader.getAnalyticsOverview() as Promise<AnalyticsOverview | null>;
export const getAnalyticsSeriesDetail = (titleKey: string) =>
  Reader.getAnalyticsSeriesDetail(
    titleKey
  ) as Promise<AnalyticsSeriesDetail | null>;
export const getAnalyticsEngagement = () =>
  Reader.getAnalyticsEngagement() as Promise<AnalyticsEngagement | null>;

export interface RetentionData {
  overall_retention_30d: number;
  total_whitelisted: number;
  retained_titles: number;
  churned_titles: number;
  top_retained: {
    title_key: string;
    title: string;
    dispatched_30d: number;
    read_sessions: number;
    retention_pct: number;
  }[];
  top_churned: {
    title_key: string;
    title: string;
    dispatched_30d: number;
    read_sessions: number;
    retention_pct: number;
  }[];
}
export async function getAnalyticsRetention(): Promise<RetentionData | null> {
  try {
    const { readerFetch } = await import("@/lib/reader/transport");
    const data = await readerFetch<{ success: boolean; data: RetentionData }>(
      "/api/v1/analytics/retention"
    );
    return (data.data ?? null) as RetentionData | null;
  } catch (e) {
    if ((e as Error)?.message?.includes("404")) return null;
    throw e;
  }
}
export const getRssCustomFeed = (params: {
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
}) =>
  Reader.getRssCustomFeed(params) as unknown as Promise<RssCustomFeedResult>;
export const getRssFilterMetadata = () =>
  Reader.getRssFilterMetadata() as unknown as Promise<RssFilterMetadata>;
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
  voratoon_covers?: Array<{
    title_key: string;
    title: string;
    cover: string;
    expiry: string;
    hours_remaining: number;
    expiring_soon: boolean;
    expired: boolean;
  }>;
}> {
  const { readerFetch } = await import("@/lib/reader/transport");
  const body = await readerFetch<{ success: boolean; data: unknown }>(
    "/api/v1/health/detailed"
  );
  return (body as unknown as { data: unknown }).data as never;
}

// Bookmarks
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
export async function getBookmarks(
  page = 1,
  pageSize = 50
): Promise<BookmarkEntry[]> {
  try {
    const { readerFetch } = await import("@/lib/reader/transport");
    const qs =
      page !== 1 || pageSize !== 50
        ? `?page=${page}&page_size=${pageSize}`
        : "";
    const body = await readerFetch<{
      success: boolean;
      data: BookmarkEntry[] | { results: BookmarkEntry[] };
    }>(`/api/v1/bookmarks${qs}`);
    const d = body.data as unknown;
    if (Array.isArray(d)) return d as BookmarkEntry[];
    if (
      d &&
      typeof d === "object" &&
      "results" in (d as Record<string, unknown>)
    )
      return (
        ((d as { results: BookmarkEntry[] }).results as BookmarkEntry[]) || []
      );
    return [];
  } catch (e) {
    if ((e as Error)?.message?.includes("404")) return [];
    throw e;
  }
}
export async function getBookmarksPaginated(
  page = 1,
  pageSize = 50
): Promise<{ results: BookmarkEntry[]; total: number; hasMore: boolean }> {
  const { readerFetch } = await import("@/lib/reader/transport");
  const body = await readerFetch<{
    success: boolean;
    data: { results: BookmarkEntry[]; total: number; hasMore: boolean };
  }>(`/api/v1/bookmarks?page=${page}&page_size=${pageSize}`);
  const d = body.data as unknown;
  if (Array.isArray(d))
    return {
      results: d as BookmarkEntry[],
      total: (d as BookmarkEntry[]).length,
      hasMore: false,
    };
  return (
    (d as { results: BookmarkEntry[]; total: number; hasMore: boolean }) || {
      results: [],
      total: 0,
      hasMore: false,
    }
  );
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
export async function deleteBookmark(
  titleKey: string,
  chapterNumber: number
): Promise<void> {
  const { readerFetch } = await import("@/lib/reader/transport");
  await readerFetch(`/api/v1/bookmarks/${titleKey}/${chapterNumber}`, {
    method: "DELETE",
  });
}
