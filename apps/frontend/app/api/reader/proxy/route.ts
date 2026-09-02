import { NextRequest, NextResponse } from "next/server";
import { authHeaders, backendUrl, TIMEOUT } from "@/lib/server-api";
import {
  type ResolvedResult,
  getFresh,
  getStale,
  setCache,
  coalesceFetch,
  cacheHitResponse,
  imageResponse,
} from "@/lib/image-cache";

// ── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get("url");
    if (!url) {
      return NextResponse.json({ error: "Missing url param" }, { status: 400 });
    }

    // 1. Fresh cache hit → serve immediately
    const cached = getFresh(url);
    if (cached) return cacheHitResponse(cached, { "X-Cache": "HIT" });

    // NOTE: the backend mounts the image proxy at /api/reader/proxy
    // (app/api/compat_extra.py:469 @router.get("/reader/proxy")).
    // There is NO /api/proxy route on the backend. Hitting /api/proxy
    // returns 404, which is exactly the error we were seeing.
    // The `url` query param is ALREADY URL-decoded by the browser when
    // we read it via searchParams.get(). rewriteCoverUrl() emits
    // `/api/reader/proxy?url=<encoded>` where <encoded> is the raw
    // upstream URL single-encoded. The browser decodes that back to the
    // raw `https://...` by the time we read it here. So we forward it
    // RAW — do NOT encodeURIComponent again, or the backend receives a
    // double/triple-encoded URL that urlparse() can't parse (→ 403/502).

    // 2. Request coalescing — only one concurrent fetch per URL
    let result: ResolvedResult;
    const inflight = coalesceFetch(url, async () => {
      // Build the upstream query with URLSearchParams so the user-supplied URL
      // (already decoded by the browser) is single-encoded as ONE `url` param —
      // a raw interpolation here would let `&`/`#`/`?` inside the value smuggle
      // extra query params to the backend proxy.
      const target = new URL(`${backendUrl()}/api/v1/reader/proxy`);
      target.searchParams.set("url", url);
      const res = await fetch(target.toString(), {
        headers: authHeaders(request),
        signal: AbortSignal.timeout(TIMEOUT.COVER),
      });

      // Backend proxy succeeded → cache and return
      if (res.ok) {
        const data = await res.arrayBuffer();
        const contentType = res.headers.get("content-type") || "image/webp";
        setCache(url, data, contentType);
        return { ok: true, data, contentType };
      }

      // Backend proxy failed (5xx from upstream, common for ikiru.wtf).
      // Do NOT fall back to a direct fetch — that bypasses the backend
      // SSRF allowlist and turns this route into an open proxy.
      return { ok: false, status: res.status };
    });
    result = await inflight;

    // 3. Error → serve stale cache if available. Cap the HTTP freshness at 60s
    // so the browser revalidates as soon as the upstream recovers — a stale
    // cover must NOT be pinned for the full fresh max-age.
    if (!result.ok) {
      const stale = getStale(url);
      if (stale) {
        console.warn(
          `[img-proxy] ${result.status} for ${url.slice(0, 80)} — serving stale`
        );
        return cacheHitResponse(stale, {
          "X-Cache": "STALE",
          "Cache-Control": "public, max-age=60",
        });
      }
      // No stale → return SVG placeholder as image (not JSON) so <img> doesn't log 403
      const svg = `<svg width="200" height="280" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#444" font-size="12" font-family="sans-serif">No cover</text></svg>`;
      return new NextResponse(svg, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=60",
          "X-Cache": "MISS-PLACEHOLDER",
        },
      });
    }

    // 4. Success
    return imageResponse(result.data!, result.contentType!);
  } catch (err) {
    // Network / timeout → try stale cache as last resort
    const url = request.nextUrl.searchParams.get("url") ?? "";
    const stale = getStale(url);
    if (stale) {
      console.warn(
        `[img-proxy] Fetch error — serving stale for ${url.slice(0, 80)}`
      );
      return cacheHitResponse(stale, {
        "X-Cache": "STALE",
        "Cache-Control": "public, max-age=60",
      });
    }
    if (err instanceof Error && err.name !== "AbortError") {
      console.error(`[img-proxy] Fetch failed:`, err);
    }
    const svg = `<svg width="200" height="280" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#444" font-size="12" font-family="sans-serif">No cover</text></svg>`;
    return new NextResponse(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=60",
        "X-Cache": "ERROR-PLACEHOLDER",
      },
    });
  }
}
