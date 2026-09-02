"""Shared HTTP client for Discord cover fetching.

Reuse a single httpx.Client per process instead of one per chapter to cut
connection overhead and socket churn when many chapters send in one run.
"""
from __future__ import annotations

import httpx


class _CoverClient:
    """Lazy-initialized, process-wide httpx client for cover images."""

    _instance: httpx.Client | None = None

    @classmethod
    def get(cls) -> httpx.Client:
        if cls._instance is None:
            cls._instance = httpx.Client(
                timeout=15,
                headers={"User-Agent": "Discordbot"},
                follow_redirects=True,
            )
        return cls._instance

    @classmethod
    def close(cls) -> None:
        if cls._instance is not None:
            cls._instance.close()
            cls._instance = None


def _is_cover_allowed(url: str) -> bool:
    """Allowlist check — reuse PROXY_ALLOWED_HOSTS. Prevent SSRF to internal/metadata."""
    try:
        from urllib.parse import urlparse

        from app.config import settings

        p = urlparse(url)
        host = (p.hostname or "").strip().lower()
        port = p.port or (443 if p.scheme == "https" else 80)
        allowed = getattr(settings, "PROXY_ALLOWED_HOSTS", [])
        return p.scheme in ("http", "https") and f"{host}:{port}" in allowed
    except Exception:
        return False


def fetch_cover(url: str) -> tuple[bytes, str] | None:
    """Fetch cover image bytes + content-type. Returns None on any error or SSRF.

    Security: follow_redirects=False — validate each hop manually to prevent
    redirect-based SSRF bypass (e.g., upstream returns 302 → 169.254.169.254).
    """
    if not url or not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return None
    if not _is_cover_allowed(url):
        return None
    try:
        # Do NOT follow redirects — validate each hop manually
        r = _CoverClient.get().get(url, follow_redirects=False)
        # Check for redirect and validate the Location header
        if r.status_code in (301, 302, 303, 307, 308):
            location = r.headers.get("location", "")
            if not location or not _is_cover_allowed(location):
                return None
            # Follow manually only if allowed
            r = _CoverClient.get().get(location, follow_redirects=False)
        if r.status_code == 200 and r.content:
            # cap 10MB
            data = r.content[: 10 * 1024 * 1024]
            return (data, r.headers.get("content-type", "image/jpeg"))
    except Exception:
        pass
    return None
