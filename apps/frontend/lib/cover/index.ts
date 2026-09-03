/**
 * Deep module Cover — single seam for cover URL resolution.
 * Handles: same-origin proxy, presigned S3 direct, legacy alias rewrites,
 * double-encode fixing, and LRU caching. Import via `@/lib/cover`.
 */

const COVER_CACHE = new Map<string, string | null>();
const COVER_CACHE_MAX = 200;

function putCover(key: string, val: string | null): string | null {
  COVER_CACHE.set(key, val);
  if (COVER_CACHE.size > COVER_CACHE_MAX) {
    const first = COVER_CACHE.keys().next().value as string | undefined;
    if (first !== undefined) COVER_CACHE.delete(first);
  }
  return val;
}

// Hosts that must be served direct (presigned S3 / CORS-open, proxy would 403/502)
const DIRECT_HOSTS = new Set([
  "cvr.voratoon.id",
  "cdn.voratoon.com",
  "minio.imgkc1.my.id",
  "imgkc1.my.id",
  "assets.shngm.id",
]);

export function isDirectAllowed(hostname: string): boolean {
  return DIRECT_HOSTS.has(hostname);
}

export function toProxy(url: string): string {
  return `/api/v1/reader/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * Rewrite cover URLs to route through same-origin /api/v1/reader/proxy.
 * See original implementation in lib/utils.ts for full rationale.
 */
export function resolveCoverUrl(
  cover: string | null | undefined
): string | null {
  if (!cover) return null;
  const cached = COVER_CACHE.get(cover);
  if (cached !== undefined) return cached;

  const COVER_IMG_PREFIX = "/api/v1/reader/cover-img?url=";
  if (cover.startsWith(COVER_IMG_PREFIX)) {
    const inner = decodeURIComponent(cover.slice(COVER_IMG_PREFIX.length));
    if (inner.includes("cvr.voratoon.id")) {
      return putCover(cover, cover);
    }
    return putCover(cover, `/api/v1/reader/proxy?url=${encodeURIComponent(inner)}`);
  }
  if (cover.includes("/api/v1/reader/cover-img?")) {
    try {
      const u = new URL(cover, "https://manhwa.aldifhr.fun");
      const inner = u.searchParams.get("url") || u.searchParams.get("series");
      if (inner) {
        const param = u.searchParams.has("url") ? "url" : "series";
        if (inner.includes("cvr.voratoon.id")) {
          return putCover(cover, cover);
        }
        const canonical = param === "url" ? "/api/v1/reader/proxy" : "/api/v1/reader/cover";
        return putCover(cover, `${canonical}?${param}=${encodeURIComponent(inner)}`);
      }
    } catch {
      /* fall through */
    }
  }
  if (cover.startsWith("/api/v1/reader/cover")) return putCover(cover, cover);

  const backendHosts = ["scanner.aldifhr.fun", "manhwa.aldifhr.fun"];
  try {
    const envHost = (
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_API_BASE || process.env.BACKEND_URL || ""
        : ""
    ) as string;
    if (envHost) {
      const h = new URL(envHost).hostname;
      if (h && !backendHosts.includes(h)) backendHosts.push(h);
    }
  } catch {
    /* ignore */
  }
  for (const host of backendHosts) {
    const prefix = `https://${host}/api/v1/reader/`;
    if (cover.startsWith(prefix)) {
      const path = cover.slice(`https://${host}`.length);
      if (path.startsWith("/api/v1/reader/cover-img?")) {
        try {
          const u = new URL(cover);
          const inner = u.searchParams.get("url") || u.searchParams.get("series");
          if (inner) {
            const param = u.searchParams.has("url") ? "url" : "series";
            const canonical = param === "url" ? "/api/v1/reader/proxy" : "/api/v1/reader/cover";
            return putCover(cover, `${canonical}?${param}=${encodeURIComponent(inner)}`);
          }
        } catch {
          /* fall through */
        }
      }
      return putCover(cover, path);
    }
    const httpPrefix = `http://${host}/api/v1/reader/`;
    if (cover.startsWith(httpPrefix)) return putCover(cover, cover.slice(`http://${host}`.length));
  }
  if (cover.includes("/api/v1/reader/")) {
    try {
      const u = new URL(cover);
      if (u.pathname.startsWith("/api/v1/reader/")) {
        const path = u.pathname + u.search;
        if (path.startsWith("/api/v1/reader/cover-img?")) {
          const inner = u.searchParams.get("url") || u.searchParams.get("series");
          if (inner) {
            const param = u.searchParams.has("url") ? "url" : "series";
            const canonical = param === "url" ? "/api/v1/reader/proxy" : "/api/v1/reader/cover";
            return putCover(cover, `${canonical}?${param}=${encodeURIComponent(inner)}`);
          }
        }
        return putCover(cover, path);
      }
    } catch {
      /* not a valid URL, fall through */
    }
  }
  const PROXY_PREFIX = "/api/v1/reader/proxy?url=";
  if (cover.startsWith(PROXY_PREFIX)) {
    const inner = decodeURIComponent(cover.slice(PROXY_PREFIX.length));
    let raw = inner;
    try {
      if (/%[0-9A-Fa-f]{2}/.test(inner) && !inner.startsWith("http")) {
        raw = decodeURIComponent(inner);
      }
    } catch {
      /* keep as-is */
    }
    try {
      const h = new URL(raw).hostname;
      if (h === "cvr.voratoon.id" || h === "cdn.voratoon.com" || h === "assets.shngm.id") {
        return putCover(cover, raw);
      }
    } catch {}
    return putCover(cover, `${PROXY_PREFIX}${encodeURIComponent(raw)}`);
  }
  if (!/^https?:\/\//.test(cover)) return putCover(cover, null);

  let rawUrl = cover;
  if (cover.includes("/api/v1/reader/proxy?")) {
    try {
      const u = new URL(cover, "https://example.com");
      const inner = u.searchParams.get("url");
      if (inner && (cover.startsWith("http://") || cover.startsWith("https://"))) {
        rawUrl = inner;
      } else if (inner) {
        rawUrl = decodeURIComponent(inner);
      }
    } catch {
      /* keep cover as rawUrl */
    }
  }
  if (!/^https?:\/\//.test(rawUrl)) return putCover(cover, null);

  let host = "";
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    /* fall through to proxy */
  }
  if (isDirectAllowed(host)) {
    return putCover(cover, rawUrl);
  }
  return putCover(cover, toProxy(rawUrl));
}

// Backward compat alias — utils still re-exports this name
export const rewriteCoverUrl = resolveCoverUrl;

// Test seam: clear cache
export function _clearCoverCache(): void {
  COVER_CACHE.clear();
}
