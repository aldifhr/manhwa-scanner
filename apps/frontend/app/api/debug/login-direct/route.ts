import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/server-api";

/**
 * Debug proxy WITHOUT "Invalid request" catch.
 * Returns raw errors (timeout, status, body, set-cookie) so
 * the /debug page can show the real login failure root cause.
 */
export async function POST(request: Request) {
  const started = Date.now();
  let password = "";
  try {
    const j = await request.json();
    password = j?.password ?? "";
  } catch (e) {
    return NextResponse.json(
      {
        error: "Request body is not JSON",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 400 }
    );
  }
  if (!password)
    return NextResponse.json(
      { error: "Password required (debug)" },
      { status: 400 }
    );

  const BACKEND_URL = backendUrl();
  const target = `${BACKEND_URL}/api/v1/auth?action=login`;

  try {
    const t0 = Date.now();
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - t0;
    const bodyText = await res.text();
    let bodyJson: unknown = null;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      // keep raw
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const hasSession = setCookies.some((c) =>
      c.startsWith("ikiru_dashboard_session=")
    );
    const hasCsrf = setCookies.some((c) => c.startsWith("ikiru_csrf_token="));

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      ms,
      totalMs: Date.now() - started,
      target,
      backendUrl: BACKEND_URL,
      hasSessionCookie: hasSession,
      hasCsrfCookie: hasCsrf,
      setCookieHeaders: setCookies,
      bodyText: bodyText.slice(0, 3000),
      bodyJson,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "Error";
    const isTimeout =
      msg.includes("Timeout") ||
      name === "TimeoutError" ||
      msg.includes("aborted");
    return NextResponse.json(
      {
        error: isTimeout
          ? "Backend timeout / aborted after 15s"
          : "Fetch failed",
        name,
        message: msg,
        target,
        backendUrl: BACKEND_URL,
        totalMs: Date.now() - started,
      },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
