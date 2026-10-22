/**
 * Session refresh proxy → backend POST /api/auth?action=refresh.
 *
 * lib/reader/transport.ts calls this path from the browser whenever a request
 * comes back 401. The route did not exist, so the fetch 404'd, handle401()
 * resolved false, and the client did `window.location.href = "/login"` — the
 * operator was bounced to the login screen mid-action. Worse, the mutation that
 * triggered the 401 had already shown its pending spinner ("is thinking…") and
 * the reload lost it, which is what looked like an add that never finished.
 *
 * The backend endpoint lives at /api/auth?action=refresh and returns fresh
 * Set-Cookie headers, so this route forwards the cookie and passes the new
 * cookies straight back to the browser.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders } from "@/lib/server-api";

export async function POST(request: NextRequest) {
  try {
    const res = await fetch(`${backendUrl()}/api/auth?action=refresh`, {
      method: "POST",
      headers: authHeaders(request),
      cache: "no-store",
    });

    const body = await res.json().catch(() => ({}));

    const out = NextResponse.json(body, { status: res.status });

    // Relay the refreshed session/CSRF cookies to the browser. Without this the
    // backend would mint a new token that never reaches the client, and the very
    // next request would 401 again.
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        out.headers.append("Set-Cookie", value);
      }
    });

    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: `auth-refresh failed: ${msg.slice(0, 200)}` },
      { status: 502 },
    );
  }
}
