"""Tests for app/api/cover.py reader_cover — no FE fallback."""
import asyncio
import pytest
from unittest.mock import MagicMock, patch


def test_reader_cover_finds_shinigami_via_slug_and_series_meta():
    # DB has title_key="dao of the bizarre immortal" (space) in series_meta,
    # request is dash slug "dao-of-the-bizarre-immortal"
    from fastapi.responses import Response
    from app.api.cover import reader_cover

    proxy_cover = "https://assets.shngm.id/thumbnail/image/8c44cded-5e58-4272-aa8a-3b174bd614c1.jpg"

    def table_side(name):
        m = MagicMock()
        sel = m.select.return_value
        # in_ chain
        in_mock = MagicMock()
        # for series_meta return cover, others empty
        if name == "series_meta":
            in_mock.limit.return_value.execute.return_value.data = [
                {"cover": proxy_cover, "title_key": "dao of the bizarre immortal"}
            ]
        else:
            in_mock.limit.return_value.execute.return_value.data = []
        sel.in_.return_value = in_mock
        # ilike fallback
        ilike_mock = MagicMock()
        ilike_mock.limit.return_value.execute.return_value.data = []
        sel.ilike.return_value = ilike_mock
        return m

    mock_sb = MagicMock()
    mock_sb.table.side_effect = table_side

    with patch("app.db.get_supabase", return_value=mock_sb):
        with patch("app.api.cover._fetch_image", new_callable=lambda: MagicMock()) as mock_fetch:
            async def fake_fetch(url, cache_control="public, max-age=3600"):
                return Response(content=b"jpegdata", media_type="image/jpeg", headers={"X-Cache": "MISS"})
            mock_fetch.side_effect = fake_fetch

            req = MagicMock()
            req.query_params.get.side_effect = lambda k, d="": "dao-of-the-bizarre-immortal" if k == "series" else d
            req.url.query = "series=dao-of-the-bizarre-immortal"

            result = asyncio.run(reader_cover(req))
            # should be jpeg, not svg
            assert result.media_type == "image/jpeg"
            assert result.body == b"jpegdata"


def test_reader_cover_unwraps_voratoon_proxy():
    from unittest.mock import MagicMock, patch
    from app.api.cover import reader_cover

    proxy_cover = "/api/v1/reader/proxy?url=https%3A%2F%2Fcvr.voratoon.id%2Fprod%2Fseries%2Fdao-of-the-bizarre-immortal%2Fcover%2Fdao.webp%3FX-Amz-Algorithm%3DAWS4-HMAC-SHA256%26X-Amz-Signature%3D322a"

    def table_side(name):
        m = MagicMock()
        sel = m.select.return_value
        in_mock = MagicMock()
        if name == "recent_chapters":
            in_mock.limit.return_value.execute.return_value.data = [
                {"cover": proxy_cover, "title_key": "dao-of-the-bizzare-immortal"}
            ]
        else:
            in_mock.limit.return_value.execute.return_value.data = []
        sel.in_.return_value = in_mock
        ilike_mock = MagicMock()
        ilike_mock.limit.return_value.execute.return_value.data = []
        sel.ilike.return_value = ilike_mock
        return m

    mock_sb = MagicMock()
    mock_sb.table.side_effect = table_side

    with patch("app.db.get_supabase", return_value=mock_sb):
        with patch("app.api.cover._fetch_image") as mock_fetch:
            from fastapi.responses import Response

            async def fake_fetch(url, cache_control="public, max-age=3600"):
                # assert called with unwrapped https url
                assert url.startswith("https://cvr.voratoon.id"), f"got {url}"
                assert "X-Amz-" in url
                return Response(content=b"webpdata", media_type="image/webp")

            mock_fetch.side_effect = fake_fetch

            req = MagicMock()
            req.query_params.get.side_effect = lambda k, d="": "dao-of-the-bizzare-immortal" if k == "series" else d
            req.url.query = "series=dao-of-the-bizzare-immortal"

            result = asyncio.run(reader_cover(req))
            assert result.media_type == "image/webp"
