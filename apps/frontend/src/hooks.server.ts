import type { Handle } from "@sveltejs/kit";
import { COOKIE_NAME, verifyToken } from "$lib/auth";
import { getSecurityHeaders } from "$lib/security/headers";

const PUBLIC_EXACT = new Set<string>([
  "/",
  "/recent",
  "/login",
  "/sw.js",
  "/manifest.json",
  "/icon.svg",
  "/favicon.ico",
  "/cn.png",
  "/jp.png",
  "/kr.png"
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
  "/api/reader/rss",
  "/api/reader/rss/new",
  "/api/reader/proxy",
  "/api/reader/cover",
  "/api/reader/cover-img",
  "/api/reader/activity",
  "/api/cron"
];

const PUBLIC_GET_PREFIX = [
  "/api/v1/reader/whitelist",
  "/api/v1/whitelist",
  "/api/v1/stats",
  "/api/v1/queue",
  "/api/v1/dashboard",
  "/api/reader/whitelist"
];

function isPublicPath(pathname: string, method: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  const isGet = method === "GET" || method === "HEAD";
  if (
    isGet &&
    PUBLIC_GET_PREFIX.some(
      (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?")
    )
  )
    return true;
  return PUBLIC_PREFIX.some(
    (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?")
  );
}

function applySecurityHeaders(headers: Headers, isDev: boolean) {
  const h = getSecurityHeaders(isDev);
  for (const [k, v] of Object.entries(h)) {
    try { headers.set(k, v); } catch {}
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  const isDev = process.env.NODE_ENV === "development";

  if (isPublicPath(pathname, event.request.method)) {
    const res = await resolve(event);
    applySecurityHeaders(res.headers, isDev);
    return res;
  }

  const token = event.cookies.get(COOKIE_NAME);
  if (!token || !verifyToken(token)) {
    if (pathname.startsWith("/api/")) {
      const h = getSecurityHeaders(isDev);
      const res = new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...h }
      });
      return res;
    }
    const loginUrl = new URL("/login", event.url);
    loginUrl.searchParams.set("redirect", pathname);
    const h = getSecurityHeaders(isDev);
    const headers = new Headers(h);
    headers.set("Location", loginUrl.toString());
    return new Response(null, { status: 302, headers });
  }

  const res = await resolve(event);
  applySecurityHeaders(res.headers, isDev);
  return res;
};
