import os
os.environ['ENVIRONMENT'] = 'development'

def test_shinigami_uses_series_meta_seam():
    from unittest.mock import patch, MagicMock
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    mock_manga = {
        "title": "Test Manga",
        "manga_id": "mid123",
        "country_id": "KR",
        "cover_image_url": "https://cover.example/c.jpg",
        "user_rate": 9.5,
        "description": "desc",
        "taxonomy": {"Genre": [{"name": "Action"}]},
        "chapters": [
            {"chapter_id": "cid1", "chapter_number": "1", "created_at": now, "release_date": now}
        ],
        "latest_chapter_time": now,
    }

    # verify shinigami.py directly imports series_meta seam (not via common shim)
    import pathlib
    src = pathlib.Path("apps/backend/app/cron/collectors/shinigami.py").read_text(encoding="utf-8")
    assert "from app.storage.series_meta import series_meta" in src, "shinigami.py must import series_meta directly from app.storage.series_meta"
    assert 'series_meta.get("shinigami"' in src or "series_meta.get('shinigami'" in src, "shinigami.py must call series_meta.get(\"shinigami\", tk)"
    # ensure shim not used
    assert "_cached_series_meta" not in src, "shinigami.py must not use _cached_series_meta shim after pilot"

    with patch("app.storage.series_meta.series_meta.get", return_value={"rating": 9.0, "description": "from meta", "genres": ["Action"], "type": "manhwa"}) as mock_get:
        with patch("app.scrapers.shinigami.get_shinigami_latest_updates", return_value=[mock_manga]):
            # ensure fresh import after patches - import after patch to capture seam usage
            import importlib
            import app.cron.collectors.shinigami as sh_mod
            importlib.reload(sh_mod)
            result = sh_mod._collect_shinigami_source(latest_sent={}, disabled=set(), fetch_meta=True)
            assert mock_get.called, "series_meta.get not called - shinigami still uses _cached_series_meta shim"
            # verify called with shinigami source and slugified title_key
            args, kwargs = mock_get.call_args
            assert args[0] == "shinigami"
            assert args[1] == "test-manga"
            # result should contain at least one item enriched from meta
            assert len(result) >= 1
