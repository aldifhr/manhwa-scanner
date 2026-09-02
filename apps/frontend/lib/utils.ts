import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names (clsx) and de-duplicate Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Return `url` only if it is a safe http(s) href, else `null`.
 * Guards against `javascript:`/`data:`/`vbscript:` scheme injection from
 * backend-supplied values (React does not sanitize `href` schemes).
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Resolve the numeric/display part of a chapter label using a fallback chain:
 * chapterLabel (stripped of prefix) → chapterNumber → chapter → url → "?".
 * Callers should prepend their own "Ch." prefix to avoid duplication
 * (e.g. "Ch. 182" from backend + "Ch." in UI = "Ch. Ch. 182").
 * "?" is treated as missing (BE sometimes sends literal "?").
 */
export function getChapterLabel(item: {
  chapterLabel?: string | null;
  chapterNumber?: number | string | null;
  chapter?: string | null;
  url?: string | null;
  chapterUrl?: string | null;
}): string {
  const clean = (v: string) => v.replace(/^(?:Chapter|Ch\.?)\s*/i, "").trim();
  if (item.chapterLabel) {
    const c = clean(item.chapterLabel);
    if (c && c !== "?") return c;
  }
  if (
    item.chapterNumber !== undefined &&
    item.chapterNumber !== null &&
    String(item.chapterNumber).trim() !== "" &&
    String(item.chapterNumber) !== "?"
  ) {
    return String(item.chapterNumber).trim();
  }
  if (item.chapter) {
    const c = clean(item.chapter);
    if (c && c !== "?") return c;
  }
  // Fallback: try extract number from url/chapterUrl (e.g. /manga/.../chapter-123/ → 123)
  const url =
    (item as { chapterUrl?: string | null; url?: string | null }).chapterUrl ||
    (item as { url?: string | null }).url ||
    "";
  if (url) {
    try {
      const m =
        url.match(/chapter[^\d]*(\d+(?:\.\d+)?)/i) ||
        url.match(/\/(\d+(?:\.\d+)?)\/?(?:$|\?|#)/);
      if (m?.[1] && m[1] !== "?") return m[1];
    } catch {}
  }
  return "?";
}

/** Decode HTML entities (numeric &#8217; and named &amp;) in API responses */
export function decodeHtml(text: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&rsquo;": "\u2019",
    "&lsquo;": "\u2018",
    "&rdquo;": "\u201D",
    "&ldquo;": "\u201C",
    "&ndash;": "\u2013",
    "&mdash;": "\u2014",
    "&hellip;": "\u2026",
    "&nbsp;": " ",
  };
  let out = text;
  for (const [entity, char] of Object.entries(named)) {
    out = out.replaceAll(entity, char);
  }
  out = out.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code))
  );
  // Hex HTML entities, e.g. &#x20; (space), &#x2019; (right single quote)
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
  // Strip any remaining HTML tags (source APIs return <p>/<br> in descriptions)
  out = out.replace(/<[^>]+>/g, " ");
  // Collapse whitespace left by stripped tags
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

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

/**
 * Rewrite cover URLs to route through same-origin /api/v1/reader/proxy.
 * Backend proxy returns cross-origin-resource-policy: same-origin which blocks
 * cross-site <img> rendering. The frontend proxy forwards to the backend's
 * public proxy endpoint, keeping everything same-origin for the browser.
 *
 * Handles both raw source URLs and backend proxy wrapper URLs.
 * Cached (LRU 200) — Home + Recent re-render same cover 3-4x via rewrite.
 */
export function rewriteCoverUrl(
  cover: string | null | undefined
): string | null {
  if (!cover) return null;
  const cached = COVER_CACHE.get(cover);
  if (cached !== undefined) return cached;
  // Legacy alias: old payloads / cached JS emit /api/reader/cover-img?url=
  // which 404s — rewrite to canonical /api/reader/proxy?url= (and keep
  // ?series= variant for cover-by-slug). Handles both same-origin and
  // absolute scanner/manhwa hosts.
  const COVER_IMG_PREFIX = "/api/v1/reader/cover-img?url=";
  if (cover.startsWith(COVER_IMG_PREFIX)) {
    const inner = decodeURIComponent(cover.slice(COVER_IMG_PREFIX.length));
    // Voratoon presigned URLs: keep as-is (cover-img proxy handles them)
    if (inner.includes("cvr.voratoon.id")) {
      return putCover(cover, cover);
    }
    return putCover(
      cover,
      `/api/v1/reader/proxy?url=${encodeURIComponent(inner)}`
    );
  }
  if (cover.includes("/api/v1/reader/cover-img?")) {
    try {
      const u = new URL(cover, "https://manhwa.aldifhr.fun");
      const inner = u.searchParams.get("url") || u.searchParams.get("series");
      if (inner) {
        const param = u.searchParams.has("url") ? "url" : "series";
        // Voratoon presigned URLs: keep as-is
        if (inner.includes("cvr.voratoon.id")) {
          return putCover(cover, cover);
        }
        const canonical =
          param === "url" ? "/api/v1/reader/proxy" : "/api/v1/reader/cover";
        return putCover(
          cover,
          `${canonical}?${param}=${encodeURIComponent(inner)}`
        );
      }
    } catch {
      /* fall through */
    }
  }
  // Internal same-origin cover ref (backend BE-3c): /api/v1/reader/cover?series=<slug>
  // Already same-origin on the FE domain — use as-is (browser loads it directly,
  // and the FE /api/v1/reader/cover route forwards auth to the backend).
  if (cover.startsWith("/api/v1/reader/cover")) return putCover(cover, cover);
  // Generic backend host handling — supports BACKEND_URL override (scanner, manhwa,
  // or custom domain) without hardcoding. Any https host that serves /api/reader/*
  // is normalized to same-origin path.
  const backendHosts = ["scanner.aldifhr.fun", "manhwa.aldifhr.fun"];
  // Also respect runtime env if available (client: NEXT_PUBLIC, server: BACKEND_URL)
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
          const inner =
            u.searchParams.get("url") || u.searchParams.get("series");
          if (inner) {
            const param = u.searchParams.has("url") ? "url" : "series";
            const canonical =
              param === "url" ? "/api/v1/reader/proxy" : "/api/v1/reader/cover";
            return putCover(
              cover,
              `${canonical}?${param}=${encodeURIComponent(inner)}`
            );
          }
        } catch {
          /* fall through */
        }
      }
      return putCover(cover, path);
    }
    const httpPrefix = `http://${host}/api/v1/reader/`;
    if (cover.startsWith(httpPrefix))
      return putCover(cover, cover.slice(`http://${host}`.length));
  }
  // Fallback: any absolute URL that contains /api/v1/reader/cover or /proxy — extract path
  if (cover.includes("/api/v1/reader/")) {
    try {
      const u = new URL(cover);
      if (u.pathname.startsWith("/api/v1/reader/")) {
        const path = u.pathname + u.search;
        if (path.startsWith("/api/v1/reader/cover-img?")) {
          const inner =
            u.searchParams.get("url") || u.searchParams.get("series");
          if (inner) {
            const param = u.searchParams.has("url") ? "url" : "series";
            const canonical =
              param === "url" ? "/api/v1/reader/proxy" : "/api/v1/reader/cover";
            return putCover(
              cover,
              `${canonical}?${param}=${encodeURIComponent(inner)}`
            );
          }
        }
        return putCover(cover, path);
      }
    } catch {
      /* not a valid URL, fall through */
    }
  }
  // Edge case: cover is ALREADY a proxy URL that got double-encoded
  // (e.g. recent_chapters stored `/api/v1/reader/proxy?url=https%3A%2F%2F...`
  // because the source cover was already a proxy URL). Decode the inner
  // URL once, then re-encode cleanly so the backend proxy gets a
  // valid http(s) URL instead of `https%3A%2F%2F` (which 403s).
  const PROXY_PREFIX = "/api/v1/reader/proxy?url=";
  if (cover.startsWith(PROXY_PREFIX)) {
    const inner = decodeURIComponent(cover.slice(PROXY_PREFIX.length));
    // inner may itself be encoded (double-encoding) → decode again
    let raw = inner;
    try {
      if (/%[0-9A-Fa-f]{2}/.test(inner) && !inner.startsWith("http")) {
        raw = decodeURIComponent(inner);
      }
    } catch {
      /* keep as-is */
    }
    return putCover(cover, `${PROXY_PREFIX}${encodeURIComponent(raw)}`);
  }
  // Reject obviously invalid covers (e.g. "x", "undefined", non-URL)
  if (!/^https?:\/\//.test(cover)) return putCover(cover, null);

  let rawUrl = cover;

  // Extract source URL from backend proxy wrapper (any host): /api/v1/reader/proxy?url=<encoded>
  // Use URL parser to be host-agnostic instead of hardcoding scanner.
  if (cover.includes("/api/v1/reader/proxy?")) {
    try {
      const u = new URL(cover, "https://example.com");
      const inner = u.searchParams.get("url");
      if (
        inner &&
        (cover.startsWith("http://") || cover.startsWith("https://"))
      ) {
        rawUrl = inner; // already decoded by URLSearchParams
      } else if (inner) {
        // shouldn't happen, but keep
        rawUrl = decodeURIComponent(inner);
      }
    } catch {
      /* keep cover as rawUrl */
    }
  }

  // Final guard: rawUrl must be a valid http(s) URL
  if (!/^https?:\/\//.test(rawUrl)) return putCover(cover, null);

  let host = "";
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    /* fall through to proxy */
  }
  // Presigned S3 covers (voratoon, MinIO) — direct fetch works (already signed, no hotlink block).
  // Proxying them via BE would require allowlisting the host; S3 presigned URLs are CORS-open and
  // short-lived (518400s = 6d for voratoon), so serving them direct avoids an extra hop and 403.
  // shinigami covers (assets.shngm.id) also load fine direct (200 image/jpeg) but the BE proxy
  // returns 502 for that host, so route them direct too.
  if (
    host === "cvr.voratoon.id" ||
    host === "minio.imgkc1.my.id" ||
    host === "imgkc1.my.id" ||
    host === "assets.shngm.id"
  ) {
    return putCover(cover, rawUrl);
  }

  // Everything else (ikiru 06.ikiru.wtf returns 403 on direct hotlink, so it
  // MUST go through the backend proxy which sends a browser UA) → proxy.
  return putCover(
    cover,
    `/api/v1/reader/proxy?url=${encodeURIComponent(rawUrl)}`
  );
}
