import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

// Proxies POST /api/auth?action=refresh to the backend. The browser
// auto-sends the `ikiru_dashboard_session` cookie; the backend
// issues a fresh 7-day JWT and Set-Cookies it. The browser
// stores the new cookie automatically (no manual handling needed).
export async function POST(request: Request) {
  try {
    const res = await fetch(`${backendUrl()}/api/v1/auth?action=refresh`, {
      method: "POST",
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.FAST),
    });
    const data = await res.json().catch(() => ({}));
    const response = Response.json(data, { status: res.ok ? 200 : res.status });
    // Forward the backend's Set-Cookie so the browser actually receives the
    // refreshed JWT. Without this, refreshSession() "succeeds" but the old
    // 7-day cookie is never replaced (forced logout every 7 days).
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
      // Strip any Domain attribute: the backend may Set-Cookie with
      // `Domain=scanner.aldifhr.fun`, which a browser on the FE origin
      // a route-domain would reject outright — leaving the old cookie
      // untouched. Host-only (no Domain) makes it apply to the FE host.
      const hostOnly = cookie.replace(/;\s*Domain=[^;]*/i, "");
      response.headers.append("Set-Cookie", hostOnly);
    }
    return response;
  } catch (err) {
    return catchError(err);
  }
}
