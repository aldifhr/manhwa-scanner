import { NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT } from "@/lib/server-api";
import { rewriteCoverUrl } from "@/lib/utils";

// ── In-memory TTL cache (global so whitelist mutate can clear it) ──
// Stats fans out 4 upstream requests per call and is polled (DashboardHome/
// stats page). A short TTL absorbs duplicate polls without staling the data.
const cache: Map<string, { data: unknown; expiry: number }> = ((
  globalThis as unknown as {
    __statsCache?: Map<string, { data: unknown; expiry: number }>;
  }
).__statsCache ??= new Map());
const CACHE_TTL = 15_000;
const MAX_CACHE = 20;

function getCached(key: string) {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: unknown) {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
  if (cache.size > MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

interface BackendStatsData {
  total: number;
  statusDistribution: Record<string, number>;
  sourceDistribution: Record<string, number>;
  ratingBuckets: {
    buckets: Record<string, number>;
    totalWithRating: number;
  };
}

interface DailyStat {
  date: string;
  chaptersSent: number;
}

interface CatalogItem {
  titleKey: string;
  title: string;
  cover: string | null;
  status?: string;
  source?: string;
  metadata?: { rating?: string | null } | null;
}

interface RssMangaGroup {
  titleKey: string;
  title: string;
  cover: string | null;
  sources: string[];
  latestChapter?: {
    chapterLabel: string;
    chapterNumber: number;
    url: string;
    createdAt: string;
    source?: string;
  } | null;
  chapters?: {
    chapterLabel: string;
    chapterNumber: number;
    createdAt: string;
    url: string;
    source?: string;
  }[];
}

function toPctArray(obj: Record<string, number>, total: number) {
  return Object.entries(obj).map(([label, count]) => ({
    label,
    count,
    percentage: total > 0 ? Math.round((count / total) * 100) : 0,
  }));
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string>,
  timeout: number
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  // Key the cache by session so one user's authed response is never served
  // to another.
  const session =
    (request.headers.get("cookie") || "").match(
      /(?:^|;\s*)ikiru_dashboard_session=([^;]*)/
    )?.[1] || "anon";
  const cacheKeyStr = `stats:${session}`;
  const cached = getCached(cacheKeyStr);
  if (cached) return NextResponse.json(cached);

  try {
    const headers = authHeaders(request);

    const [statsRes, healthRes, catalogBody, rssBody] = await Promise.all([
      fetch(`${backendUrl()}/api/catalog/stats`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT.SLOW),
      }).catch(() => null),
      fetch(`${backendUrl()}/api/health-status`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT.FAST),
      }).catch(() => null),
      fetchJson<{ success: boolean; data?: { results?: CatalogItem[] } }>(
        `${backendUrl()}/api/catalog?all=true&page_size=1000`,
        headers,
        TIMEOUT.DEFAULT
      ),
      fetchJson<{ success: boolean; data?: { results?: RssMangaGroup[] } }>(
        `${backendUrl()}/api/v1/rss?format=json&limit=5`,
        headers,
        TIMEOUT.DEFAULT
      ),
    ]);

    // Compute stats from catalog data (fallback when /api/catalog/stats is 404)
    const allItems = catalogBody?.data?.results ?? [];
    const total = allItems.length;

    const statusDistribution: Record<string, number> = {};
    const sourceDistribution: Record<string, number> = {};
    const ratingBuckets: Record<string, number> = {};
    let totalWithRating = 0;

    for (const item of allItems) {
      const st = item.status ?? "unknown";
      statusDistribution[st] = (statusDistribution[st] ?? 0) + 1;
      const src = item.source ?? "unknown";
      sourceDistribution[src] = (sourceDistribution[src] ?? 0) + 1;
      if (item.metadata?.rating) {
        const r = parseFloat(item.metadata.rating);
        if (!isNaN(r)) {
          const bucket = String(Math.floor(r));
          ratingBuckets[bucket] = (ratingBuckets[bucket] ?? 0) + 1;
          totalWithRating++;
        }
      }
    }

    let raw: BackendStatsData;
    if (statsRes && statsRes.ok) {
      try {
        const body = await statsRes.json();
        raw = body?.data;
        if (!body.success || !raw)
          raw = {
            total,
            statusDistribution,
            sourceDistribution,
            ratingBuckets: { buckets: ratingBuckets, totalWithRating },
          };
      } catch {
        // Malformed /api/catalog/stats response — fall back to catalog-derived.
        raw = {
          total,
          statusDistribution,
          sourceDistribution,
          ratingBuckets: { buckets: ratingBuckets, totalWithRating },
        };
      }
    } else {
      // Backend /api/catalog/stats unavailable — compute from catalog
      raw = {
        total,
        statusDistribution,
        sourceDistribution,
        ratingBuckets: { buckets: ratingBuckets, totalWithRating },
      };
    }

    // Extract daily trends from health-status
    let trends: { date: string; chapters: number }[] = [];
    if (healthRes?.ok) {
      try {
        const healthBody = await healthRes.json();
        if (Array.isArray(healthBody?.data?.dailyStats)) {
          trends = healthBody.data.dailyStats.map((d: DailyStat) => ({
            date: d.date,
            chapters: d.chaptersSent ?? 0,
          }));
        }
      } catch {
        /* non-critical */
      }
    }

    // Top rated from catalog (reuses allItems from stats computation above)
    const topRated = allItems
      .filter((item) => item.metadata?.rating != null)
      .map((item) => ({
        id: item.titleKey,
        title: item.title,
        cover: rewriteCoverUrl(item.cover),
        rating: parseFloat(item.metadata!.rating!) || 0,
      }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5);

    // Recent updates from RSS (grouped format)
    const rssGroups = rssBody?.data?.results ?? [];
    const recentUpdates = rssGroups.slice(0, 5).map((group) => {
      const latest = group.latestChapter ?? group.chapters?.[0];
      return {
        id: group.titleKey,
        title: group.title,
        cover: rewriteCoverUrl(group.cover),
        chapterLabel: latest?.chapterLabel ?? "",
        chapterNumber: latest?.chapterNumber ?? 0,
        time: latest?.createdAt ?? "",
        source: latest?.source || group.sources?.[0] || "",
      };
    });

    const rated = raw.ratingBuckets?.totalWithRating ?? 0;
    // Compute avg rating from the catalog slice (only meaningful when the
    // backend /api/catalog/stats is unavailable; otherwise it's derived there).
    let avgRating: number | null = null;
    if (rated > 0) {
      let sum = 0;
      for (const [bucket, count] of Object.entries(
        raw.ratingBuckets?.buckets ?? {}
      )) {
        const mid = parseFloat(bucket) + 0.5;
        if (!isNaN(mid)) sum += mid * count;
      }
      avgRating = rated > 0 ? Math.round((sum / rated) * 100) / 100 : null;
    }

    const data = {
      total: raw.total,
      rated,
      avgRating,
      byStatus: toPctArray(raw.statusDistribution, raw.total),
      bySource: toPctArray(raw.sourceDistribution, raw.total),
      ratingDistribution: toPctArray(
        raw.ratingBuckets?.buckets ?? {},
        raw.ratingBuckets?.totalWithRating ?? 1
      ),
      topRated,
      recentUpdates,
      trends,
      sourceStats: Object.entries(raw.sourceDistribution).map(
        ([source, chapters]) => ({ source, chapters })
      ),
    };

    const body = { success: true, data };
    setCache(cacheKeyStr, body);
    return NextResponse.json(body);
  } catch (err) {
    console.error("[stats] upstream request failed", err);
    return NextResponse.json(
      { success: false, error: "Upstream request failed" },
      { status: 502 }
    );
  }
}
