import { rewriteCoverUrl } from "@/lib/utils";
import { NextResponse } from "next/server";
import {
  backendUrl,
  authHeaders,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";

// ── In-memory TTL cache (global so whitelist mutate can clear it) ──
const cache: Map<string, { data: unknown; expiry: number }> = ((
  globalThis as unknown as {
    __dashboardCache?: Map<string, { data: unknown; expiry: number }>;
  }
).__dashboardCache ??= new Map());
const CACHE_TTL = 10_000;
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

export async function GET(request: Request) {
  try {
    // Key by session cookie so different users never share cached data.
    const sessionKey =
      (request.headers.get("cookie") || "").match(
        /(?:^|;\s*)ikiru_dashboard_session=([^;]*)/
      )?.[1] || "anon";
    const cached = getCached(sessionKey);
    if (cached) return NextResponse.json(cached);

    const snapRes = await fetch(`${backendUrl()}/api/v1/dashboard-snapshot`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.SLOW),
    });

    if (!snapRes.ok) {
      return errorResponse(
        `Dashboard snapshot returned ${snapRes.status}`,
        snapRes.status
      );
    }

    const snapBody = await snapRes.json();
    if (!snapBody.success || !snapBody.data) {
      return errorResponse("No dashboard snapshot data", 503);
    }

    const {
      overview,
      sourceHealth,
      recentChapters,
      recentFeed,
      whitelistCount,
      queueLength,
      cronStatus,
    } = snapBody.data;

    const responseBody = {
      success: true,
      data: {
        overview: overview ?? null,
        sourceHealth: sourceHealth ?? {},
        recentChapters: (recentChapters ?? [])
          .slice(0, 5)
          .map((ch: { cover?: string | null } & Record<string, unknown>) => ({
            ...ch,
            cover: rewriteCoverUrl(ch.cover),
            seriesUrl: ch.seriesUrl || ch.series_url || null,
          })),
        recentFeed: (recentFeed ?? []).map(
          (ch: { cover?: string | null } & Record<string, unknown>) => ({
            ...ch,
            cover: rewriteCoverUrl(ch.cover),
            seriesUrl: ch.seriesUrl || ch.series_url || null,
          })
        ),
        whitelistCount: whitelistCount ?? 0,
        queueLength: queueLength ?? 0,
        cronStatus: cronStatus ?? null,
      },
    };

    setCache(sessionKey, responseBody);
    return NextResponse.json(responseBody);
  } catch (err) {
    return catchError(err);
  }
}
