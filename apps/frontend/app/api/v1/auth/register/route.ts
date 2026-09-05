import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/server-api";
export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();
    if (!email || !password)
      return NextResponse.json(
        { error: "Email & password required" },
        { status: 400 }
      );
    const BACKEND_URL = backendUrl();
    const res = await fetch(`${BACKEND_URL}/api/v1/auth?action=register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (!res.ok || !json.success)
      return NextResponse.json(
        { error: json.error || "Register failed" },
        { status: res.status }
      );
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const backendJwt = setCookies
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ikiru_dashboard_session="));
    const backendJwtValue = backendJwt
      ? backendJwt.split("=").slice(1).join("=")
      : "";
    const csrfCookie = setCookies
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ikiru_csrf_token="));
    const csrfTokenValue = csrfCookie
      ? csrfCookie.split("=").slice(1).join("=")
      : "";
    const roleCookie = setCookies
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ikiru_role="));
    const roleValue = roleCookie
      ? roleCookie.split("=").slice(1).join("=")
      : "member";
    const response = NextResponse.json({ success: true });
    if (backendJwtValue) {
      response.cookies.set("ikiru_dashboard_session", backendJwtValue, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      });
      if (csrfTokenValue)
        response.cookies.set("ikiru_csrf_token", csrfTokenValue, {
          httpOnly: false,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 7 * 24 * 60 * 60,
        });
      if (roleValue)
        response.cookies.set("ikiru_role", roleValue, {
          httpOnly: false,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 7 * 24 * 60 * 60,
        });
      return response;
    }
    return NextResponse.json(
      { error: "Backend did not issue cookie" },
      { status: 500 }
    );
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
