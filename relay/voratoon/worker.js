/**
 * Voratoon egress proxy.
 *
 * Why this exists: api.voratoon.com is blocked at Cloudflare's edge for the
 * manhwa-scanner VPS's IP. curl, curl_cffi and tls-client all get 403 with no
 * cf-ray header (a per-IP block, not a TLS-fingerprint one), so the catalogue
 * has to be fetched from a different egress.
 *
 * A Worker runs on Cloudflare's own network, so a subrequest from here reaches
 * voratoon without touching the blocked IP. That removes the third-party
 * dependency the r.jina.ai relay had.
 *
 * Contract: GET /?url=<encoded absolute https URL>  ->  upstream body verbatim.
 * Only the voratoon API hosts are allowed, so this cannot be used as an open
 * proxy.
 */

const ALLOWED_HOSTS = new Set([
  "api.voratoon.com",
  "v4.voratoon.com",
  "v7.voratoon.com",
]);

// Only these paths carry catalogue data; anything else is refused so the
// Worker cannot be pointed at arbitrary endpoints on those hosts.
const ALLOWED_PATH_PREFIXES = ["/series", "/genres", "/chapter"];

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return json({ error: "missing_url" }, 400);

    let u;
    try {
      u = new URL(target);
    } catch {
      return json({ error: "invalid_url" }, 400);
    }

    if (u.protocol !== "https:") return json({ error: "https_required" }, 400);
    if (!ALLOWED_HOSTS.has(u.hostname)) return json({ error: "host_not_allowed" }, 403);
    if (!ALLOWED_PATH_PREFIXES.some((p) => u.pathname.startsWith(p))) {
      return json({ error: "path_not_allowed" }, 403);
    }

    const upstream = await fetch(u.toString(), {
      headers: {
        Accept: "application/json",
        // The API 404s on some paths when the UA looks like a bot, so present
        // a normal browser UA.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      // Never let the client's headers/cookies leak upstream.
      redirect: "follow",
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        // The relay polls every 10 min; a short cache absorbs duplicate ticks
        // without serving stale catalogue data.
        "cache-control": "public, max-age=60",
      },
    });
  },
};
