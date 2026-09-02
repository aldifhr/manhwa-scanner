import { withCsrf } from "@/lib/csrf";

/* ── Whitelist route returns transformed items ── */

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

/* ── Whitelist (raw from GET /api/whitelist) ── */

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
  if (data.rating !== null && data.rating !== undefined)
    body.rating = data.rating;
  if (data.origin) body.origin = data.origin;
  if (data.type) body.type = data.type;
  if (data.genres && data.genres.length > 0) body.genres = data.genres;
  if (data.description) body.description = data.description;

  const res = await fetch(
    "/api/v1/reader/whitelist",
    withCsrf({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  if (!res.ok) {
    if (res.status === 409) return { status: "already_exists" };
    const body = await res.json().catch(() => ({}));
    const errMsg =
      typeof body.error === "string"
        ? body.error
        : body.error?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return { status: "added" };
}

/** Matches backend WhitelistDeleteRequest: { title_key?, url?, title?, source? } */
export async function removeWhitelistEntry(data: {
  title_key?: string;
  title?: string;
  url?: string;
  source?: string;
}): Promise<void> {
  const res = await fetch(
    "/api/v1/reader/whitelist",
    withCsrf({
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  );
  const body = (await res.json().catch(() => ({}))) as {
    status?: string;
    deleted?: number;
    error?: string | { message?: string };
  };
  // BE returns 404 {status:"not_found"} when nothing matched, OR 200
  // {status:"ok", deleted:0} on a silent no-op. Both mean "nothing was
  // deleted" — treat as failure so the FE optimistic-remove is rolled back
  // on the next refetch instead of leaving a ghost card.
  if (!res.ok) {
    const errMsg =
      typeof (body as { error?: unknown }).error === "string"
        ? String((body as { error: string }).error)
        : ((body as { error?: { message?: string } }).error
            ?.message as string) ||
          (body as { message?: string }).message ||
          `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  if (body.status === "not_found" || body.deleted === 0) {
    const errMsg =
      typeof body.error === "string"
        ? body.error
        : body.error?.message || "No matching whitelist entry to delete";
    throw new Error(errMsg);
  }
}

/* ── Excluded titles (RSS "Exclude" feature) ── */

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
  const res = await fetch(
    "/api/v1/excluded-titles",
    withCsrf({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      typeof body.error === "string"
        ? body.error
        : body.error?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return { status: body?.success ? "ok" : "error" };
}

export async function removeExcludedTitle(data: {
  title_key: string;
  source?: string;
}): Promise<void> {
  const res = await fetch(
    "/api/v1/excluded-titles",
    withCsrf({
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  );
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: unknown;
    received?: unknown;
  };
  if (!res.ok || body.success === false) {
    console.error("[removeExcludedTitle] failed", {
      sent: data,
      body,
      status: res.status,
    });
    const errMsg =
      typeof body.error === "string"
        ? body.received
          ? `${body.error} (received: ${JSON.stringify(body.received).slice(0, 200)})`
          : body.error
        : (body.error as { message?: string })?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
}

export async function bulkExcludeBySource(
  source: string
): Promise<{ excluded: number }> {
  const res = await fetch(
    "/api/v1/excluded-titles/bulk",
    withCsrf({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    })
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      typeof body.error === "string"
        ? body.error
        : body.error?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return { excluded: body?.data?.excluded ?? 0 };
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
  const res = await fetch("/api/v1/health/detailed", {
    headers: {
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN || "manhwascan"}`,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
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

/* ── Audit Log (GET /api/v1/audit-log) ── */

export interface AuditLogEntry {
  id: number;
  action: string;
  actor: string;
  target: string;
  details: Record<string, unknown>;
  ip: string;
  created_at: string;
}

export async function getAuditLog(params?: {
  limit?: number;
  offset?: number;
  action?: string;
  actor?: string;
  since?: string;
}): Promise<AuditLogEntry[]> {
  const p = new URLSearchParams();
  if (params?.limit) p.set("limit", String(params.limit));
  if (params?.offset) p.set("offset", String(params.offset));
  if (params?.action) p.set("action", params.action);
  if (params?.actor) p.set("actor", params.actor);
  if (params?.since) p.set("since", params.since);
  const res = await fetch(`/api/v1/audit-log?${p}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data || [];
}

export async function getAuditStats(days = 7): Promise<Record<string, number>> {
  const res = await fetch(`/api/v1/audit-log/stats?days=${days}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data || {};
}

/* ── Bookmarks (GET/POST/DELETE /api/v1/bookmarks) ── */

export interface BookmarkEntry {
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source: string;
  position_pct: number;
  updated_at: string;
}

export async function getBookmarks(): Promise<BookmarkEntry[]> {
  const res = await fetch("/api/v1/bookmarks");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data || [];
}

export async function saveBookmark(data: {
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source?: string;
  position_pct?: number;
}): Promise<void> {
  const res = await fetch("/api/v1/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function deleteBookmark(
  titleKey: string,
  chapterNumber: number
): Promise<void> {
  const res = await fetch(`/api/v1/bookmarks/${titleKey}/${chapterNumber}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/* ── A/B Testing removed — /ab-tests page deleted per CONTEXT.md 2026-09-02 ── */
