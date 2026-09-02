import { NextResponse } from "next/server";
import { withCsrf } from "@/lib/csrf";

/**
 * Server-side backend URL for FE→backend fetches (proxy/image/auth routes).
 *
 * CRITICAL: must NEVER resolve to `localhost` on the deployed server.
 * `NEXT_PUBLIC_API_BASE` is inlined at BUILD time from the local `.env`
 * (which is `http://localhost:3000` in dev) — if a deploy is built from a
 * machine where that var is localhost, the value gets baked into the server
 * route and every FE→backend fetch throws (→ 502 for all covers/auth).
 *
 * Resolution order:
 *   1. BACKEND_URL  — server-only runtime env, the correct knob for prod.
 *   2. NEXT_PUBLIC_API_BASE — only if it is NOT a localhost address.
 *   3. https://scanner.aldifhr.fun — safe remote default.
 */
export function backendUrl(): string {
  const fromEnv = process.env.BACKEND_URL?.trim();
  if (fromEnv) {
    // In production never trust a localhost value (common mis-config via .env import).
    // Fall through to NEXT_PUBLIC_API_BASE / default instead of throwing ECONNREFUSED.
    const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(fromEnv);
    if (process.env.NODE_ENV === "production" && isLocal) {
      // prod mode on VPS: localhost backend is expected
      return fromEnv.replace(/\/$/, "");
    } else {
      return fromEnv.replace(/\/$/, "");
    }
  }
  const publicBase = process.env.NEXT_PUBLIC_API_BASE;
  if (publicBase && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(publicBase)) {
    return publicBase.replace(/\/$/, "");
  }
  return "https://scanner.aldifhr.fun";
}

/** @deprecated pakai backendUrl() per-request agar env reload (HMR/Vercel) kebaca. Tetap diekspor untuk compat. */
export const API_BASE = backendUrl();
export function getApiBase(): string {
  return backendUrl();
}
const TOKEN = process.env.API_TOKEN || "";

if (!TOKEN) {
  console.warn(
    "[server-api] API_TOKEN env not set — backend calls will be unauthenticated unless ikiru_dashboard_session cookie is present."
  );
}

export function authHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  // Forward ALL cookies to backend — double-submit CSRF requires both the
  // cookie value AND the header value to match.
  const cookie = request.headers.get("cookie") || "";
  const sessionMatch = cookie.match(
    /(?:^|;\s*)ikiru_dashboard_session=([^;]*)/
  );
  const csrfMatch = cookie.match(/(?:^|;\s*)ikiru_csrf_token=([^;]*)/);
  const parts: string[] = [];
  if (sessionMatch) parts.push(`ikiru_dashboard_session=${sessionMatch[1]}`);
  if (csrfMatch) parts.push(`ikiru_csrf_token=${csrfMatch[1]}`);
  if (parts.length > 0) headers["Cookie"] = parts.join("; ");

  // Forward CSRF token header for mutating requests.
  const csrfToken = request.headers.get("x-csrf-token") || "";
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  // Fall back to static API_TOKEN only if no session cookie and token present.
  if (!sessionMatch && TOKEN) {
    headers["Authorization"] = `Bearer ${TOKEN}`;
  }

  return headers;
}

export function hashSession(session: string): string {
  if (!session || session === "anon") return "anon";
  let h = 0;
  for (let i = 0; i < session.length; i++)
    h = (Math.imul(31, h) + session.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const TIMEOUT = {
  FAST: 10_000,
  DEFAULT: 30_000,
  SLOW: 45_000,
  RSS: 15_000,
  WHITELIST: 15_000,
  QUEUE: 8_000,
  COVER: 35_000,
} as const;

export function errorResponse(message: string, status = 500) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export async function refreshSession(): Promise<boolean> {
  // Client-side refresh. Hits the FE proxy route which forwards the
  // session cookie to the backend /api/auth?action=refresh.
  // The backend issues a fresh 7d JWT and Set-Cookies it; the
  // browser stores it automatically.
  try {
    const res = await fetch(
      `/api/reader/auth-refresh`,
      withCsrf({ method: "POST" })
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function catchError(err: unknown) {
  console.error("[api] upstream request failed", err);
  const msg = err instanceof Error ? err.message : String(err);
  const isTimeout =
    msg.includes("Timeout") ||
    (err instanceof Error && err.name === "TimeoutError");
  // Surface short, non-leaky reason so FE can show actionable error instead of generic 502
  const detail = isTimeout
    ? "Upstream timed out"
    : `Upstream request failed${msg ? `: ${msg.slice(0, 200)}` : ""}`;
  return errorResponse(detail, isTimeout ? 504 : 502);
}

// Deep module: createServerClient — single seam for all server→backend fetches
export function createServerClient(request: Request) {
  const base = backendUrl();
  const headers = authHeaders(request);
  return {
    base,
    headers,
    fetch: (path: string, init?: RequestInit) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
        signal: init?.signal ?? AbortSignal.timeout(TIMEOUT.DEFAULT),
      }),
    fetchWithTimeout: (path: string, init?: RequestInit, ms = TIMEOUT.DEFAULT) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(ms),
      }),
  };
}
