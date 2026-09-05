import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/server-api";

export async function POST(request: Request) {
  try {
    const { password, email } = await request.json();
    if (!password) {
      return NextResponse.json({ error: "Password required" }, { status: 400 });
    }
    const payload: Record<string, string> = { password };
    if (email) payload.email = String(email).toLowerCase().trim();

    const BACKEND_URL = backendUrl();
    const res = await fetch(`${BACKEND_URL}/api/v1/auth?action=login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    const json = await res.json();
    if (!res.ok || !json.success || !json.data?.ok) {
      return NextResponse.json(
        { error: json.error?.message || "Invalid credentials" },
        { status: 401 }
      );
    }

    // Extract backend session cookie from Set-Cookie header.
    // The backend /api/auth?action=login returns a REAL HS256 JWT in
    // `ikiru_dashboard_session`. We MUST forward THAT exact JWT as our
    // `ikiru_dashboard_session` cookie — NOT mint a fake `v2.sid.sig`
    // token (the backend would reject it with 401). The FE gate is the
    // same JWT the backend issued.
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const backendJwt = setCookies
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ikiru_dashboard_session="));
    const backendJwtValue = backendJwt
      ? backendJwt.split("=").slice(1).join("=")
      : "";

    // Also extract the CSRF token cookie (non-httponly, JS-readable).
    // Backend sets ikiru_csrf_token on login; FE needs it for
    // double-submit CSRF validation on mutating requests.
    const csrfCookie = setCookies
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ikiru_csrf_token="));
    const csrfTokenValue = csrfCookie
      ? csrfCookie.split("=").slice(1).join("=")
      : "";

    const response = NextResponse.json({ success: true });

    // Set the REAL backend JWT as our session cookie (same name, same value).
    // Browser sends it back; server-api.authHeaders forwards it to the backend.
    if (backendJwtValue) {
      response.cookies.set("ikiru_dashboard_session", backendJwtValue, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60, // 7d (matches backend JWT exp)
      });

      // Forward CSRF token cookie to browser (non-httponly so JS can read it).
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

    // No session cookie from the backend → do NOT mint a fake token (the
    // backend would reject it on every call, silently producing an empty
    // dashboard). Surface the misconfiguration instead.
    return NextResponse.json(
      { error: "Backend did not issue a session cookie" },
      { status: 500 }
    );
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
