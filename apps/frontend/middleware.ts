import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME } from "@/lib/auth";

// Security headers applied to every response the middleware handles, and
// mirrored in next.config.ts (source: "/(.*)") so static assets are covered too.
// NOTE: script-src / style-src keep 'unsafe-inline' because Next.js App Router
// injects inline RSC hydration scripts — a strict nonce-free CSP would break
// hydration. 'self' + same-origin proxied images is otherwise locked down.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

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
  "/login",
  "/about",
  "/sw.js",
  "/manifest.json",
  "/icon.svg",
  "/favicon.ico",
  // Origin flag images referenced from AllCard / GroupedSeriesCard; they are
  // plain static assets and must not 307-redirect when a request arrives
  // without a session cookie.
  "/cn.png",
  "/jp.png",
  "/kr.png",
]);

const PUBLIC_PREFIX = [
  "/api/v1/auth/login",
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
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some(
    (p) =>
      pathname === p ||
      pathname.startsWith(p + "/") ||
      pathname.startsWith(p + "?")
  );
}

function applySecurityHeaders(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (
      k === "Content-Security-Policy" &&
      process.env.NODE_ENV === "development"
    ) {
      // Dev mode: add 'unsafe-eval' for Next.js React Refresh (HMR).
      // Production CSP skips this to keep script-injection surface minimal.
      res.headers.set(
        k,
        v.replace(
          "script-src 'self' 'unsafe-inline'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        )
      );
    } else {
      res.headers.set(k, v);
    }
  }
  return res;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return applySecurityHeaders(NextResponse.next());
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  // Hardened: FE only checks cookie presence. HS256 signature + exp are verified
  // server-side (app/api/auth/* sets httpOnly + backend re-validates on every
  // proxied call). Keeping verifyToken() in lib/auth for tests, but not gating
  // the edge — a forged token will 401 at the API layer, not here.
  // API routes (/api/*) must NOT redirect to /login on missing token —
  // the browser fetch would follow the 307 to the HTML login page, then
  // res.json() throws and the client crashes with "Cannot read properties of
  // null (reading 'success')". Instead return a 401 JSON so fetchJson throws a
  // clean "HTTP 401" the UI catches. Covers /api/reader/* AND /api/excluded-titles*
  // (which previously fell through to the HTML redirect).
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

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    // Match all routes except static assets, favicon, and icon
    "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};
