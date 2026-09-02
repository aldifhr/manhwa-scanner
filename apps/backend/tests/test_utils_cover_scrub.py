"""Tests for app/utils/cover_scrub.py."""
import pytest
from unittest.mock import MagicMock, patch
from app.utils.cover_scrub import scrub_cover, cover_ref


class TestScrubCover:
    """Test scrub_cover() — normalizes cover URLs."""

    def test_empty_input(self):
        assert scrub_cover("") == ""
        assert scrub_cover(None) == ""

    def test_direct_url_unchanged(self):
        url = "https://example.com/cover.jpg"
        assert scrub_cover(url) == url

    def test_voratoon_presigned_proxied(self):
        url = "https://cvr.voratoon.id/prod/series/test/cover.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=Zgozh0pCiplFv4J3%252F20260828%252Fap-northeast-1%252Fs3%252Faws4_request&X-Amz-Date=20260828T031644Z&X-Amz-Expires=518400&X-Amz-Signature=abc123&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject"
        result = scrub_cover(url)
        assert "/api/v1/reader/proxy?url=" in result
        assert "cvr.voratoon.id" in result

    def test_public_url_strips_aws_params(self):
        url = "https://example.com/cover.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=KEY&X-Amz-Signature=SIG&X-Amz-Expires=3600&X-Amz-Date=20260828T031644Z&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject"
        result = scrub_cover(url)
        assert "X-Amz" not in result
        assert "https://example.com/cover.jpg" in result

    def test_non_http_url_unchanged(self):
        assert scrub_cover("/local/path.jpg") == "/local/path.jpg"

    def test_url_with_no_aws_params(self):
        url = "https://example.com/cover.jpg?w=300&h=400"
        result = scrub_cover(url)
        assert "w=300" in result
        assert "h=400" in result

    def test_malformed_url_fallback(self):
        # Should not raise, returns original on parse failure
        url = "https://[invalid"
        result = scrub_cover(url)
        assert result == url


class TestCoverRef:
    """Test cover_ref() — DB lookup with caching."""

    def test_empty_title_key(self):
        assert cover_ref("") == ""
        assert cover_ref(None) == ""
