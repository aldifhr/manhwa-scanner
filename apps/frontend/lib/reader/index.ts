// Deep module: Reader — seam untuk semua fetch whitelist/history/rss.
// Interface adalah test surface; di balik seam: pagination, snake→camel, csrf, 401.
// Transport + mapper dipisah biar testable (inject fetch, unit test mapper tanpa network).
import type { QueueDepth } from "@/lib/types";
import { readerFetch, paginatedGet } from "./transport";
import { mapWhitelist, mapHistory, mapRss } from "./mapper";

export const Reader = {
  getWhitelist: (page = 1, pageSize = 1000, merge = true) => {
    const p = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      merge: merge ? "true" : "false",
    });
    return paginatedGet("/api/v1/reader/whitelist", p, mapWhitelist as never);
  },
  getDispatchHistory: (page = 1, pageSize = 1000, search = "") => {
    const p = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (search) p.set("search", search);
    return paginatedGet(
      "/api/v1/reader/dispatch-history",
      p,
      mapHistory as never
    );
  },
  getRssFlat: (
    page = 1,
    limit = 1000,
    opts: {
      exclude?: string;
      whitelist?: boolean;
      source?: string | null;
      type?: string | null;
    } = {}
  ) => {
    const p = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      group: "false",
    });
    if (opts.exclude) p.set("exclude", opts.exclude);
    if (opts.whitelist) p.set("whitelist", "true");
    if (opts.source) p.set("source", opts.source);
    if (opts.type) p.set("type", opts.type);
    return paginatedGet("/api/v1/reader/rss", p, mapRss as never);
  },
  getExcludedTitles: async () => {
    const data = await readerFetch<{
      success: boolean;
      data: { results: Record<string, unknown>[] };
    }>("/api/v1/excluded-titles");
    return (data.data?.results ?? []).map((r) => ({
      ...r,
      titleKey:
        (r.title_key as string) ??
        (r.titleKey as string) ??
        (r.id as string) ??
        "",
    }));
  },
  getDashboardSnapshot: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/dashboard-snapshot"
    );
    return data.data as unknown;
  },
  getStats: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/stats"
    );
    return (data.data ?? null) as unknown;
  },
  getQueueDepth: async (): Promise<QueueDepth> => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/queue"
    );
    return (data.data ?? {}) as QueueDepth;
  },
  getCronStatus: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/cron/status"
    );
    return (data.data ?? []) as unknown;
  },
  countNewSince: async (lastSeen: number, opts?: { distinct?: boolean }) => {
    const distinct = opts?.distinct ?? true;
    const qs = distinct ? `&distinct=title` : `&distinct=chapter`;
    const data = await readerFetch<{
      success: boolean;
      data: { newCount?: number; newCountDistinct?: number };
    }>(`/api/v1/rss/new?since=${lastSeen}${qs}`);
    const count = distinct
      ? (data?.data?.newCountDistinct ?? data?.data?.newCount)
      : data?.data?.newCount;
    if (typeof count === "number" && Number.isFinite(count)) return count;
    throw new Error("Invalid newCount from /api/v1/rss/new");
  },
  getRssHealth: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/rss/health"
    );
    return data.data as unknown;
  },
  resolveCatalogUrl: async (url: string) => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      `/api/v1/catalog/resolve?url=${encodeURIComponent(url)}`
    );
    return (data.data ?? null) as unknown;
  },
  getCronMonitor: async () => {
    const data = await readerFetch<Record<string, unknown>>(
      "/api/v1/cron/status"
    );
    return data as unknown;
  },
  // Analytics endpoints
  getAnalyticsOverview: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/analytics/overview"
    );
    return (data.data ?? null) as unknown;
  },
  getAnalyticsSeriesDetail: async (titleKey: string) => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      `/api/v1/analytics/series/${encodeURIComponent(titleKey)}`
    );
    return (data.data ?? null) as unknown;
  },
  getAnalyticsEngagement: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/analytics/engagement"
    );
    return (data.data ?? null) as unknown;
  },
  // Custom RSS feed endpoints
  getRssCustomFeed: async (params: {
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
  }) => {
    const p = new URLSearchParams();
    if (params.genres) p.set("genres", params.genres);
    if (params.sources) p.set("sources", params.sources);
    if (params.origins) p.set("origins", params.origins);
    if (params.status) p.set("status", params.status);
    if (params.minRating) p.set("min_rating", params.minRating);
    if (params.maxRating) p.set("max_rating", params.maxRating);
    if (params.unreadOnly) p.set("unread_only", "true");
    if (params.subscribedOnly) p.set("subscribed_only", "true");
    if (params.sort) p.set("sort", params.sort);
    p.set("limit", String(params.limit ?? 50));
    p.set("page", String(params.page ?? 1));
    const data = await readerFetch<{
      success: boolean;
      data: {
        results: Record<string, unknown>[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
        hasMore: boolean;
        filters: Record<string, unknown>;
      };
    }>(`/api/v1/rss/custom?${p}`);
    return data.data as unknown;
  },
  getRssFilterMetadata: async () => {
    const data = await readerFetch<{ success: boolean; data: unknown }>(
      "/api/v1/rss/filters/metadata"
    );
    return (data.data ?? null) as unknown;
  },
  // Page-wise seam for AllTab infinite scroll — hides snake→camel + hasMore logic
  async getRssFlatPage(
    page: number,
    limit = 1000,
    opts: {
      exclude?: string;
      whitelist?: boolean;
      source?: string | null;
      type?: string | null;
    } = {}
  ): Promise<{
    results: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
  }> {
    const p = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      group: "false",
    });
    if (opts.exclude) p.set("exclude", opts.exclude);
    if (opts.whitelist) p.set("whitelist", "true");
    if (opts.source) p.set("source", opts.source);
    if (opts.type) p.set("type", opts.type);
    const data = await readerFetch<{
      success: boolean;
      data: {
        results: Record<string, unknown>[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
        hasMore: boolean;
      };
    }>(`/api/v1/rss?${p}`);
    const d = data.data;
    const results = (d?.results ?? []).map(mapRss) as Record<string, unknown>[];
    const totalPages =
      (d?.totalPages as number) ??
      (d as unknown as { total_pages?: number })?.total_pages;
    const fallbackHasMore =
      typeof totalPages === "number"
        ? page < totalPages
        : results.length === limit && results.length > 0;
    return {
      results,
      total: d?.total ?? 0,
      page: d?.page ?? page,
      pageSize: d?.pageSize ?? limit,
      totalPages: totalPages ?? 1,
      hasMore: typeof d?.hasMore === "boolean" ? d.hasMore : fallbackHasMore,
    };
  },
};
