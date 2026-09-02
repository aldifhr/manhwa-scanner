"""Cover-URL scrubbing to stop leaking MinIO/S3 presigned URLs.

Scrapers store source cover URLs (some of which are MinIO presigned URLs
carrying `X-Amz-Credential` / `X-Amz-Signature` / `X-Amz-Expires` query
params). Those params leak the access-key ID + a time-limited read token and
are usable directly from the internet. We MUST NOT return them in any API
response. This module strips the AWS query string and returns the bare
host/path so the client can re-request the cover through our authed proxy
(`/api/v1/reader/cover?series=<slug>`) instead.
"""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


# AWS presign param names we strip (case-insensitive).
# Includes the full set MinIO/S3 can emit, not just the signature-bearing
# ones — e.g. X-Amz-Content-Sha256=UNSIGNED-PAYLOAD, x-amz-checksum-mode,
# x-id are non-credential noise that still makes MinIO 403 a bare fetch and
# clutters the stored URL.
_AMZ_PARAMS = (
    "x-amz-credential",
    "x-amz-signature",
    "x-amz-expires",
    "x-amz-date",
    "x-amz-algorithm",
    "x-amz-signedheaders",
    "x-amz-content-sha256",
    "x-amz-checksum-mode",
    "awsaccesskeyid",
    "signature",
    "expires",
    "x-id",
)


def scrub_cover(url: str | None) -> str:
    """Return a safe cover URL for the client.

    - voratoon covers live on a PRIVATE S3 bucket (cvr.voratoon.id). Stripping
      the presigned query yields a 403, so we MUST proxy the FULL original URL
      (presigned params intact) through /api/v1/reader/proxy?url=<encoded>.
    - ikiru/shinigami covers are PUBLIC, so we strip the AWS presign noise and
      return the bare host/path (client can fetch directly or via proxy).
    """
    if not url or not isinstance(url, str):
        return url or ""
    if not (url.startswith("http://") or url.startswith("https://")):
        return url
    from urllib.parse import quote

    # Voratoon: private bucket -> serve presigned URL directly.
    # S3 presigned URLs are CORS-open and short-lived (6 days), so serving them
    # direct avoids an extra hop and 403 (signature mismatch when re-encoded).
    if "cvr.voratoon.id" in url:
        from urllib.parse import quote
        return "/api/v1/reader/proxy?url=" + quote(url, safe="")

    try:
        parts = urlsplit(url)
        from urllib.parse import parse_qsl, urlencode
        kept = [
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if k.lower() not in _AMZ_PARAMS
        ]
        new_query = urlencode(kept)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, ""))
    except Exception:
        # On any parse failure, fall back to returning the original URL.
        return url


_cover_ref_cache: dict[str, tuple[float, str]] = {}
_cover_ref_ttl = 60.0  # cache IO to avoid N+1 when called in loops

def cover_ref(title_key: str | None) -> str:
    """Return the RAW cover URL for a title_key (from whitelist / recent_chapters).

    NOTE: This does synchronous DB IO. Prefer batch-lookup via
    ``storage.whitelist`` or passing ``cover`` directly when in a loop.
    Result is cached 60s to mitigate N+1.

    Previously this returned an internal proxy-ref (`/api/v1/reader/cover?series=...`)
    per BE-3c. Now returns the actual stored cover URL so the FE can route it
    through its own proxy or skip bare MinIO.
    """
    if not title_key:
        return ""
    import time as _t
    tk = str(title_key)
    cached = _cover_ref_cache.get(tk)
    if cached and (_t.monotonic() - cached[0]) < _cover_ref_ttl:
        return cached[1]
    # Bound cache
    if len(_cover_ref_cache) > 512:
        oldest = sorted(_cover_ref_cache.items(), key=lambda kv: kv[1][0])[:128]
        for k, _ in oldest:
            _cover_ref_cache.pop(k, None)
    try:
        from app.db import get_supabase
        sb = get_supabase()
        # Try whitelist first (richer metadata), then recent_chapters.
        for table in ("whitelist", "recent_chapters"):
            try:
                res = (
                    sb.table(table)
                    .select("cover")
                    .in_("title_key", [tk, tk.replace("-", " "), tk.replace(" ", "-")])
                    .limit(3)
                    .execute()
                )
                for r in (res.data or []):
                    raw = r.get("cover")
                    c = raw.strip() if isinstance(raw, str) else str(raw or "").strip()
                    if c:
                        _cover_ref_cache[tk] = (_t.monotonic(), c)
                        return c
            except Exception:
                continue
    except Exception:
        pass
    _cover_ref_cache[tk] = (_t.monotonic(), "")
    return ""
