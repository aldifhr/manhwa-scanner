import type { RequestHandler } from "./$types";
import { backendUrl } from "$lib/server-api";

export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    const { password } = await request.json() as { password?: string };
    if (!password) return Response.json({ error: "Password required" }, { status: 400 });
    const BACKEND_URL = backendUrl();
    const res = await fetch(`${BACKEND_URL}/api/v1/auth?action=login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15000)
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.success || !json.data?.ok) {
      return Response.json({ error: json.error?.message || "Invalid credentials" }, { status: 401 });
    }
    const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
    // fallback parse via get('set-cookie') if getSetCookie not available (SvelteKit fetch)
    const rawSet = res.headers.get("set-cookie") ?? "";
    const allCookies = setCookies.length ? setCookies : rawSet ? [rawSet] : [];
    const findVal = (name: string) => {
      for (const c of allCookies) {
        const m = c.match(new RegExp(`${name}=([^;]+)`));
        if (m) return decodeURIComponent(m[1]);
      }
      // try json data cookies
      if (json.data?.[name]) return json.data[name];
      return "";
    };
    const jwt = findVal("ikiru_dashboard_session") || json.data?.token || "";
    const csrf = findVal("ikiru_csrf_token") || "";
    if (!jwt) return Response.json({ error: "Backend did not issue a session cookie" }, { status: 500 });
    const isProd = process.env.NODE_ENV === "production";
    cookies.set("ikiru_dashboard_session", jwt, { httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: 7*24*60*60 });
    if (csrf) cookies.set("ikiru_csrf_token", csrf, { httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 7*24*60*60 });
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
};
export const GET: RequestHandler = async () => Response.json({ error: "Method not allowed" }, { status: 405 });
