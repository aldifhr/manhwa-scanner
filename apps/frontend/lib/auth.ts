const COOKIE_NAME = "ikiru_dashboard_session";

function b64UrlDecode(input: string): string {
  // Edge-safe: no Buffer. Convert base64url -> base64 -> decode.
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  // atob is available in both Node (>=16) and Edge/Web workers
  try {
    // Use globalThis.atob if present, else Buffer fallback for older Node tests
    if (typeof atob === "function") return atob(b64);
  } catch {
    /* fall through to Buffer */
  }
  try {
    const buf = (
      globalThis as {
        Buffer?: {
          from: (str: string, enc: string) => { toString: () => string };
        };
      }
    ).Buffer;
    if (buf) return buf.from(b64, "base64").toString();
  } catch {
    /* ignore */
  }
  // Last resort: manual (Node without atob/Buffer shouldn't happen)
  return "";
}

function decodeJwtPayload<T>(token: string): T | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = b64UrlDecode(payload);
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return false;
  const payload = decodeJwtPayload<{ exp?: number }>(token);
  if (!payload || !payload.exp) return false;
  return Date.now() < payload.exp * 1000;
}

export function getRole(token: string): "admin" | "member" | null {
  const p = decodeJwtPayload<{ role?: string }>(token);
  if (p?.role === "admin" || p?.role === "member") return p.role;
  return null;
}

export { COOKIE_NAME };
