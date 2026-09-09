"""SSRF protection tests — verify proxy/cover/img/catalog/resolve block private/internal IPs.

Covers: /api/v1/reader/proxy, /api/img, /api/v1/catalog/resolve, and the
shared _fetch_image seam that all image-proxy routes delegate to.
"""
import asyncio
import os
import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def _auth() -> dict:
    """Return auth headers if MONITOR_AUTH_TOKEN is set (auth enabled)."""
    token = os.getenv("MONITOR_AUTH_TOKEN", "")
    return {"Authorization": f"Bearer {token}"} if token else {}


# Internal/private URLs that must be blocked (SSRF targets)
_INTERNAL_URLS = [
    "http://127.0.0.1/cover.jpg",
    "http://127.0.0.1:8080/admin",
    "http://10.0.0.1/secret",
    "http://10.255.255.255/data",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.0.1/",
    "http://localhost/cover.jpg",
    "http://localhost:3000/admin",
]


class TestReaderProxySSRF:
    """GET /api/v1/reader/proxy?url=... must block internal/private IPs."""

    @pytest.mark.parametrize("url", _INTERNAL_URLS)
    def test_blocks_internal_ips(self, url):
        r = client.get(f"/api/v1/reader/proxy?url={url}", headers=_auth())
        assert r.status_code == 403, f"{url} should be blocked, got {r.status_code}"


class TestImgSSRF:
    """GET /api/img?url=... (public) must block internal/private IPs."""

    @pytest.mark.parametrize("url", _INTERNAL_URLS)
    def test_blocks_internal_ips(self, url):
        r = client.get(f"/api/img?url={url}")
        assert r.status_code == 403, f"{url} should be blocked, got {r.status_code}"


class TestCatalogResolveSSRF:
    """GET /api/v1/catalog/resolve?url=... must block internal/private IPs."""

    @pytest.mark.parametrize("url", _INTERNAL_URLS)
    def test_blocks_internal_ips(self, url):
        r = client.get(f"/api/v1/catalog/resolve?url={url}", headers=_auth())
        # Returns 400 for non-ikiru/shinigami hosts (no scraper to dispatch to)
        assert r.status_code in (400, 403), f"{url} should be blocked, got {r.status_code}"


class TestFetchImageSSRF:
    """_fetch_image (shared seam) must block internal/private IPs directly."""

    @pytest.mark.parametrize("url", _INTERNAL_URLS)
    def test_blocks_internal_ips(self, url):
        from app.api.observability import _fetch_image
        resp = asyncio.run(_fetch_image(url))
        assert resp.status_code == 403, f"{url} should be blocked, got {resp.status_code}"
