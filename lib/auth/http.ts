/**
 * HTTP header and cookie utilities
 */

export interface RequestLike {
  headers?: Record<string, string | string[] | undefined> | Headers;
}

/**
 * Get header value from request (works with both Express and Fetch API)
 */
export function getHeader(req: RequestLike | null | undefined, name: string): string {
  if (!req) return "";

  // Fetch API Headers
  if (req.headers instanceof Headers) {
    return req.headers.get(name) || "";
  }

  // Express-style headers object
  if (req.headers && typeof req.headers === "object") {
    const lowerName = name.toLowerCase();
    const value = req.headers[lowerName] || req.headers[name];
    return Array.isArray(value) ? value[0] || "" : String(value || "");
  }

  return "";
}

/**
 * Parse cookie header into a Map
 */
export function getCookieMap(req: RequestLike | null | undefined): Map<string, string> {
  const raw = getHeader(req, "cookie");
  const map = new Map<string, string>();

  if (!raw) return map;

  for (const pair of raw.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) continue;
    map.set(key, decodeURIComponent(rest.join("=") || ""));
  }

  return map;
}

/**
 * Get specific cookie value
 */
export function getCookie(req: RequestLike | null | undefined, name: string): string | undefined {
  return getCookieMap(req).get(name);
}
