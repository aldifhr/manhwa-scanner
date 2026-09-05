import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, getRole } from "@/lib/auth";
import { getSecurityHeaders } from "@/lib/security/headers";

// Endpoints that must NEVER be behind the auth gate (login page, auth API,
// anonymous proxy routes, service worker, PWA manifest, static icons).
// Keep this as a single source of truth. Use EXACT for leaf paths and
// PREFIX for path families (e.g. "/api/reader/rss" covers
// "/api/reader/rss?source=ikiru" but NOT "/api/reader/rss-foo").
//
// ── PUBLIC_PREFIX audit (2026-07-14 hardening, revised 2026-08-23) ──
// KEEP:
//   /api/auth/login     — This IS the login endpoint; must be anonymous.
//   /api/cron           — External webhook entrypoint called by FastCron
//                         (which cannot log in). The server-side CRON token still
//                         authenticates the call to the backend.
//   /api/reader/rss*    — Opened for anonymous /recent page (commit a0e626b).
//                         Returns recent chapters feed; cover URLs are rewritten
//                         to same-origin proxy (see below) so anon can render.
//   /api/reader/proxy, /cover, /cover-img — Must be public when rss is public,
//                         otherwise anon rss returns 401 for every cover image
//                         (middleware would block /api/reader/proxy?url=).
//                         SSRF protection stays in backend allowlist; FE just
//                         adds auth header fallback (API_TOKEN) for anon.
// REMOVED (kept behind auth):
//   /api/reader/dashboard — full operational snapshot + MinIO presigned URLs (data exposure).
//   /api/reader/queue, /stats, /whitelist, /dispatch-history — operational/internal.
const PUBLIC_EXACT = new Set<string>([
  "/",
  "/recent",
  "/bookmarks",
  "/about",
  "/login",
  "/register",
  "/sw.js",
  "/manifest.json",
  "/icon.svg",
  "/favicon.ico",
  "/cn.png",
  "/jp.png",
  "/kr.png",
]);

const PUBLIC_PREFIX = [
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/cron",
  "/api/v1/reader/rss",
  "/api/v1/reader/rss/new",
  "/api/v1/reader/proxy",
  "/api/v1/reader/cover",
  "/api/v1/reader/cover-img",
  "/api/v1/reader/activity",
  "/api/v1/public/stats",
  "/api/v1/rss",
  "/api/v1/rss/new",
  "/api/v1/health/detailed",
  "/api/v1/debug",
  "/debug",
  // Legacy backward-compat (rewritten via next.config.ts rewrites -> /api/v1/*)
  "/api/reader/rss",
  "/api/reader/rss/new",
  "/api/reader/proxy",
  "/api/reader/cover",
  "/api/reader/cover-img",
  "/api/reader/activity",
  "/api/cron",
];

const PUBLIC_GET_PREFIX = [
  "/api/v1/reader/whitelist",
  "/api/v1/whitelist",
  "/api/v1/stats",
  "/api/v1/queue",
  "/api/v1/dashboard",
  "/api/reader/whitelist",
];

function isPublicPath(pathname: string, method: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  const isGet = method === "GET" || method === "HEAD";
  if (
    isGet &&
    PUBLIC_GET_PREFIX.some(
      (p) =>
        pathname === p ||
        pathname.startsWith(p + "/") ||
        pathname.startsWith(p + "?")
    )
  )
    return true;
  return PUBLIC_PREFIX.some(
    (p) =>
      pathname === p ||
      pathname.startsWith(p + "/") ||
      pathname.startsWith(p + "?")
  );
}

function applySecurityHeaders(res: NextResponse): NextResponse {
  const headers = getSecurityHeaders(process.env.NODE_ENV === "development");
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname, request.method)) {
    return applySecurityHeaders(NextResponse.next());
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    if (pathname.startsWith("/api/")) {
      return applySecurityHeaders(
        NextResponse.json(
          { success: false, error: "unauthorized" },
          { status: 401 }
        )
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  const role = getRole(token);
  const isMutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const needsAdmin =
    pathname.startsWith("/admin") ||
    pathname.startsWith("/status") ||
    pathname.startsWith("/whitelist") ||
    pathname.startsWith("/dispatch-history") ||
    pathname.startsWith("/exclude-list") ||
    (isMutating &&
      (pathname.startsWith("/api/v1/reader/whitelist") ||
        pathname.startsWith("/api/v1/whitelist") ||
        pathname.startsWith("/api/v1/excluded-titles") ||
        pathname.startsWith("/api/excluded-titles") ||
        pathname.startsWith("/api/v1/reader/excluded") ||
        pathname.startsWith("/api/v1/health/refresh") ||
        pathname.startsWith("/api/v1/cron") ||
        pathname.startsWith("/api/cron") ||
        pathname.startsWith("/api/v1/queue/retry") ||
        pathname.startsWith("/api/v1/logs")));

  if (needsAdmin && role !== "admin") {
    if (pathname.startsWith("/api/")) {
      return applySecurityHeaders(
        NextResponse.json(
          { success: false, error: "forbidden — admin only" },
          { status: 403 }
        )
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    // Match all routes except static assets, favicon, and icon
    "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};
