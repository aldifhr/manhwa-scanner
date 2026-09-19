export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/server-api";

export async function POST(request: Request) {
  try {
    const { password } = await request.json();
    if (!password) {
      return NextResponse.json({ error: "Password required" }, { status: 400 });
    }
    const BACKEND_URL = backendUrl();
    const res = await fetch(`${BACKEND_URL}/api/v1/auth?action=login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const msg = (json as { message?: string })?.message || "Rate limit exceeded (5/min). Coba lagi 60 detik.";
      return NextResponse.json({ error: msg }, { status: 429, headers: { "Retry-After": "60" } });
    }
    if (!res.ok || !json.success || !json.data?.ok) {
      // Backend may return {error: "rate_limited"} with 429 or {error: "Invalid credentials"} with 401
      const backendMsg =
        (json as { message?: string; error?: string | { message?: string } })?.message ||
        (typeof json.error === "string" ? json.error : (json.error as { message?: string } | undefined)?.message);
      if (backendMsg?.includes("Rate limit") || json.error === "rate_limited") {
        return NextResponse.json({ error: "Rate limit exceeded (5/min). Tunggu 60 detik." }, { status: 429 });
      }
      return NextResponse.json({ error: backendMsg || "Invalid credentials" }, { status: 401 });
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const backendJwt = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("ikiru_dashboard_session="));
    const backendJwtValue = backendJwt ? backendJwt.split("=").slice(1).join("=") : "";
    const csrfCookie = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("ikiru_csrf_token="));
    const csrfTokenValue = csrfCookie ? csrfCookie.split("=").slice(1).join("=") : "";
    const response = NextResponse.json({ success: true });
    if (backendJwtValue) {
      // ponytail: lax host-only = first-party, not blocked as 3rd-party cookie (none+domain was causing loop on Brave/Incognito)
      // Domain .aldifhr.fun sharing handled server-side via authHeaders forwarding, no need for client cross-site
      response.cookies.set("ikiru_dashboard_session", backendJwtValue, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      });
      if (csrfTokenValue) {
        response.cookies.set("ikiru_csrf_token", csrfTokenValue, {
          httpOnly: false,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 7 * 24 * 60 * 60,
        });
      }
      return response;
    }
    return NextResponse.json({ error: "Backend did not issue a session cookie" }, { status: 500 });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
