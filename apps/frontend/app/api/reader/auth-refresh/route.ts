import { NextResponse, NextRequest } from "next/server";
import { backendUrl, authHeaders } from "@/lib/server-api";

export async function POST(request: NextRequest) {
  const res = await fetch(`${backendUrl()}/api/v1/auth?action=refresh`, {
    method: "POST",
    headers: authHeaders(request as unknown as Request),
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const response = NextResponse.json({ success: true });
  for (const c of setCookies) {
    const [pair, ...attrs] = c.split(";").map((s) => s.trim());
    const [k, v] = pair.split("=");
    if (!k || !v) continue;
    // forward BE cookies as lax host-only (same fix as login)
    response.cookies.set(k, v, {
      httpOnly: k === "ikiru_dashboard_session",
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  }
  return response;
}
