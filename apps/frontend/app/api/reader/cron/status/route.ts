import { NextResponse } from "next/server";
import {
  backendUrl,
  authHeaders,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";
import { verifyToken, COOKIE_NAME } from "@/lib/auth";

const cache: Map<string, { data: unknown; expiry: number }> = ((
  globalThis as unknown as {
    __cronStatusCache?: Map<string, { data: unknown; expiry: number }>;
  }
).__cronStatusCache ??= new Map());
const CACHE_TTL = 15_000;
const MAX_CACHE = 10;

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

function authorized(request: Request): boolean {
  const token = request.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`))?.[1];
  return !!token && verifyToken(token);
}

export async function GET(request: Request) {
  try {
    if (!authorized(request)) {
      return errorResponse("unauthorized", 401);
    }

    const sessionKey =
      (request.headers.get("cookie") || "").match(
        /(?:^|;\s*)ikiru_dashboard_session=([^;]*)/
      )?.[1] || "anon";
    const cached = getCached(sessionKey);
    if (cached) return NextResponse.json(cached);

    const res = await fetch(`${backendUrl()}/api/cron/status`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
    });

    if (!res.ok) {
      return errorResponse(
        `Cron status returned ${res.status}`,
        res.status >= 500 ? 502 : res.status
      );
    }

    const body = await res.json();
    setCache(sessionKey, body);
    return NextResponse.json(body);
  } catch (err) {
    return catchError(err);
  }
}
