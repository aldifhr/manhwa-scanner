// Deep module: Reader — seam untuk semua fetch whitelist/history/rss.
// Interface adalah test surface; di balik seam: pagination, snake→camel, csrf, 401.
// Transport + mapper dipisah biar testable (inject fetch, unit test mapper tanpa network).
import type {
  QueueDepth,
  DashboardSnapshot,
  ExcludedTitleItem,
} from "@/lib/types";
import { readerFetch, paginatedGet } from "./transport";
import { mapWhitelist, mapHistory, mapRss, mapExcluded } from "./mapper";

function buildRssParams(
  page: number,
  limit: number,
  opts: {
    exclude?: string;
    whitelist?: boolean;
    source?: string | null;
    type?: string | null;
  }
) {
  const p = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    group: "false",
  });
  if (opts.exclude) p.set("exclude", opts.exclude);
  if (opts.whitelist) p.set("whitelist", "true");
  if (opts.source) p.set("source", opts.source);
  if (opts.type) p.set("type", opts.type);
  return p;
}

export const Reader = {
  getWhitelist: (page = 1, pageSize = 1000, merge = true) => {
    const p = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      merge: merge ? "true" : "false",
    });
    return paginatedGet(
      "/api/v1/reader/whitelist",
      p,
      mapWhitelist
    ) as unknown as Promise<import("@/lib/types").WhitelistRouteItem[]>;
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
      mapHistory
    ) as unknown as Promise<import("@/lib/types").DispatchHistoryItem[]>;
  },
  getDispatchHistoryPage: async (
    page = 1,
    pageSize = 50,
    search = ""
  ): Promise<{
    results: import("@/lib/types").DispatchHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> => {
    const p = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (search) p.set("search", search);
    const data = await readerFetch<{
      success: boolean;
      data: {
        results: unknown[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
      };
    }>(`/api/v1/dispatch-history?${p}`);
    const d = data.data as {
      results: unknown[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      total_pages?: number;
    };
    return {
      results: (d?.results ?? []).map(mapHistory) as import("@/lib/types").DispatchHistoryItem[],
      total: d?.total ?? 0,
      page: d?.page ?? page,
      pageSize: d?.pageSize ?? pageSize,
      totalPages: d?.totalPages ?? (d as { total_pages?: number })?.total_pages ?? 1,
    };
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
  ) =>
    paginatedGet(
      "/api/v1/reader/rss",
      buildRssParams(page, limit, opts),
      mapRss
    ) as unknown as Promise<import("@/lib/types").RssFlatItem[]>,
  getExcludedTitles: async (): Promise<ExcludedTitleItem[]> => {
    const data = await readerFetch<{
      success: boolean;
      data: { results: Record<string, unknown>[] };
    }>("/api/v1/excluded-titles");
    return (data.data?.results ?? []).map(mapExcluded) as ExcludedTitleItem[];
  },
  getDashboardSnapshot: async (): Promise<DashboardSnapshot | null> => {
    const data = await readerFetch<{
      success: boolean;
      data: DashboardSnapshot;
    }>("/api/v1/dashboard-snapshot");
    return (data.data ?? null) as DashboardSnapshot | null;
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
  // Whitelist mutations — single seam so api.ts has no bare fetch
  addWhitelistEntry: async (data: Record<string, unknown>) => {
    try {
      const res = await readerFetch<{ status?: string; success?: boolean }>(
        "/api/v1/reader/whitelist",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      );
      return { status: "added" as const };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("409") || msg.toLowerCase().includes("already_exists") || msg.toLowerCase().includes("already exists")) {
        return { status: "already_exists" as const };
      }
      throw e;
    }
  },
  removeWhitelistEntry: async (data: Record<string, unknown>) => {
    try {
      const res = await readerFetch<{
        status?: string;
        deleted?: number;
        success?: boolean;
        error?: string | { message?: string };
      }>("/api/v1/reader/whitelist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if ((res as unknown as { status?: string }).status === "not_found" || (res as unknown as { deleted?: number }).deleted === 0) {
        throw new Error("No matching whitelist entry to delete");
      }
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("404") || msg.toLowerCase().includes("not_found")) {
        throw new Error("No matching whitelist entry to delete");
      }
      throw e;
    }
  },
  addExcludedTitle: async (data: Record<string, unknown>) => {
    const res = await readerFetch<{ success?: boolean; data?: unknown }>(
      "/api/v1/excluded-titles",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }
    );
    return { status: "ok" as const };
  },
  removeExcludedTitle: async (data: Record<string, unknown>) => {
    await readerFetch("/api/v1/excluded-titles", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  },
  bulkExcludeBySource: async (source: string) => {
    const data = await readerFetch<{ success: boolean; data: { excluded: number } }>(
      "/api/v1/excluded-titles/bulk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      }
    );
    return { excluded: data.data?.excluded ?? 0 };
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
    const p = buildRssParams(page, limit, opts);
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
