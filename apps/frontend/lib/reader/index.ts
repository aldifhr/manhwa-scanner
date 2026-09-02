// Deep module: Reader — seam untuk semua fetch whitelist/history/rss.
// Interface adalah test surface; di balik seam: pagination, snake→camel, csrf, 401.
import { withCsrf } from "@/lib/csrf";
import type { QueueDepth } from "@/lib/types";

// --- adapter: satu tempat untuk auth & csrf & 401 ---
async function readerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const csrfInit = init
    ? (withCsrf(init as RequestInit) as RequestInit)
    : undefined;
  // forward AbortSignal if provided (for paginatedGet cancel)
  const res = await fetch(path, csrfInit);
  if (res.status === 204) return { success: true, data: { results: [] } } as T;
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let msg = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      msg =
        typeof body.error === "string"
          ? body.error
          : ((body.error as { message?: string })?.message ?? msg);
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    // AbortError should not be wrapped as HTTP error
    if (res.status === 401) throw new Error(`UNAUTHORIZED: ${msg}`);
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// --- helper: pagination seam (concurrency 4, cap 1000) ---
async function paginatedGet<T>(
  basePath: string,
  params: URLSearchParams,
  map: (r: unknown) => T,
  signal?: AbortSignal
): Promise<T[]> {
  const pageSize = Number(
    params.get("page_size") ?? params.get("limit") ?? 1000
  );
  if (pageSize > 1000) {
    params.set(params.has("page_size") ? "page_size" : "limit", "1000");
    const first = await readerFetch<{
      success: boolean;
      data: { results: unknown[]; totalPages?: number; total_pages?: number };
    }>(`${basePath}?${params}`, signal ? { signal } : undefined);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const totalPages = (first.data?.totalPages ??
      (first.data as { total_pages?: number })?.total_pages ??
      1) as number;
    const firstRows = (first.data?.results ?? []).map(map);
    if (totalPages <= 1) return firstRows;
    const fetchers = Array.from({ length: totalPages - 1 }, (_, i) => () => {
      const p = new URLSearchParams(params);
      p.set("page", String(i + 2));
      p.set(params.has("page_size") ? "page_size" : "limit", "1000");
      return readerFetch<{ success: boolean; data: { results: unknown[] } }>(
        `${basePath}?${p}`,
        signal ? { signal } : undefined
      );
    });
    const batched: unknown[] = [];
    for (let i = 0; i < fetchers.length; i += 4) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const batch = await Promise.allSettled(
        fetchers.slice(i, i + 4).map((f) => f())
      );
      for (const r of batch) {
        if (r.status === "fulfilled")
          batched.push(...((r.value.data?.results ?? []) as unknown[]));
        else if ((r.reason as Error)?.name !== "AbortError") throw r.reason;
      }
    }
    return [...firstRows, ...batched.map(map)];
  }
  const data = await readerFetch<{
    success: boolean;
    data: { results: unknown[] };
  }>(`${basePath}?${params}`, signal ? { signal } : undefined);
  return (data.data?.results ?? []).map(map);
}

// --- mappers: snake→camel seam ---
function mapWhitelist(r: Record<string, unknown>) {
  return {
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string),
    seriesUrl: (r.series_url as string) ?? (r.seriesUrl as string),
    canonicalTitleKey:
      (r.canonical_title_key as string) ?? (r.canonicalTitleKey as string),
  };
}
function mapHistory(r: Record<string, unknown>) {
  return r; // already camel in types
}
function mapRss(r: Record<string, unknown>) {
  return {
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string),
    chapterUrl: (r.chapter_url as string) ?? (r.chapterUrl as string),
    seriesUrl: (r.series_url as string) ?? (r.seriesUrl as string),
    isWhitelisted:
      (r.is_whitelisted as boolean) ?? (r.isWhitelisted as boolean),
  };
}

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
