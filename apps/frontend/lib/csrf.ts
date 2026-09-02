/**
 * CSRF protection helper — reads the `ikiru_csrf_token` cookie set by the
 * backend on login and attaches it as an `X-CSRF-Token` header on every
 * mutating request (POST / PUT / DELETE / PATCH).
 *
 * Safe methods (GET / HEAD / OPTIONS) are NOT affected.
 */

const CSRF_COOKIE = "ikiru_csrf_token";
const CSRF_HEADER = "X-CSRF-Token";

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  try {
    const escaped = CSRF_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(^| )${escaped}=([^;]+)`));
    return match ? decodeURIComponent(match[2]) : "";
  } catch {
    return "";
  }
}

/**
 * Attach CSRF header to a fetch RequestInit.
 * Only adds the header for mutating methods — safe methods are left untouched.
 */
export function withCsrf(init: RequestInit = {}): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return init;

  const token = getCsrfToken();
  // merge headers handling Headers instance / array
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (token) headers.set(CSRF_HEADER, token);
  return { ...init, headers };
}
