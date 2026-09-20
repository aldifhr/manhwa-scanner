import os
os.environ['ENVIRONMENT']='development'

def test_series_meta_redis_hit():
    from unittest.mock import MagicMock, patch
    from app.storage.series_meta import SeriesMeta
    fresh = {"title_key":"t","source":"ikiru","rating":8.5,"genres":["A"],"description":"d","cover":"","type":"","origin":"KR","updated_at": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
    mock_db = MagicMock()
    sm = SeriesMeta(db=mock_db, fetcher=lambda s, sid: {})
    with patch("app.storage.series_meta._redis_get_meta", return_value=fresh) as mock_get:
        with patch("app.storage.series_meta._redis_set_meta") as mock_set:
            r = sm.get("ikiru","t")
            assert r.get("rating")==8.5
            assert r == fresh
            mock_db.table.assert_not_called()
            mock_get.assert_called_once_with("ikiru","t")
            # second call should hit in-mem, not Redis or DB
            r2 = sm.get("ikiru","t")
            assert r2 == fresh
            mock_db.table.assert_not_called()
            # redis get still only once (second hit served from in-mem)
            assert mock_get.call_count == 1

def test_series_meta_stale_fallback():
    from unittest.mock import MagicMock, patch
    from app.storage.series_meta import SeriesMeta
    stale = {"title_key":"t","source":"ikiru","rating":7.0,"genres":["A"],"description":"old","cover":"","type":"","origin":"KR","updated_at":"2020-01-01T00:00:00+00:00"}
    fresh_upstream = {"rating":9.0,"genres":["A"],"description":"d2","cover":"c","type":"manhwa","origin":"KR","updated_at": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
    mock_db = MagicMock()
    mock_table = MagicMock()
    mock_db.table.return_value = mock_table
    mock_table.select.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.execute.return_value = MagicMock(data=[stale])
    mock_table.upsert.return_value = mock_table
    sm = SeriesMeta(db=mock_db, fetcher=lambda s, sid: fresh_upstream)
    with patch("app.storage.series_meta._redis_get_meta", return_value=None):
        with patch("app.storage.series_meta._redis_set_meta") as mock_set:
            r = sm.get("ikiru","t")
            assert r.get("rating")==9.0
            # should have attempted upsert with fresh data
            assert mock_table.upsert.called
            upsert_arg = mock_table.upsert.call_args[0][0]
            assert upsert_arg.get("rating")==9.0
            assert upsert_arg.get("title_key")=="t"
            # redis set called with fresh
            assert mock_set.called

def test_series_meta_hit_and_stale():
    from unittest.mock import MagicMock, patch
    from app.storage.series_meta import SeriesMeta
    fresh = {"title_key":"t","source":"ikiru","rating":8.5,"genres":["A"],"description":"d","cover":"","type":"","origin":"KR","updated_at": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
    mock_db = MagicMock()
    mock_table = MagicMock()
    mock_db.table.return_value = mock_table
    mock_table.select.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.execute.return_value = MagicMock(data=[fresh])
    sm = SeriesMeta(db=mock_db, fetcher=lambda s, sid: {})
    with patch("app.storage.series_meta._redis_get_meta", return_value=None):
        r1 = sm.get("ikiru","t")
        assert r1.get("rating")==8.5
        # second hit should not call DB again
        r2 = sm.get("ikiru","t")
        assert mock_db.table.call_count == 1  # select*eq*limit*execute once (corrected: MagicMock table called once per DB hit, plan's 4 was miscount)

def test_get_bulk_and_invalidate():
    from unittest.mock import MagicMock, patch
    from app.storage.series_meta import SeriesMeta
    fresh_base = {"rating":8.5,"genres":["A"],"description":"d","cover":"","type":"","origin":"KR","updated_at": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
    mock_db = MagicMock()
    mock_table = MagicMock()
    mock_db.table.return_value = mock_table
    mock_table.select.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.execute.return_value = MagicMock(data=[])
    mock_table.upsert.return_value = mock_table
    sm = SeriesMeta(db=mock_db, fetcher=lambda s, sid: {**fresh_base, "title_key": sid, "source": s})
    with patch("app.storage.series_meta._redis_get_meta", return_value=None):
        with patch("app.storage.series_meta._redis_set_meta"):
            with patch("app.storage.series_meta._redis") as mock_redis_factory:
                mock_redis = MagicMock()
                mock_redis_factory.return_value = mock_redis
                result = sm.get_bulk([("t1","ikiru"),("t2","shinigami")])
                assert len(sm._cache) >= 2
                assert ("t1","ikiru") in result
                assert ("t2","shinigami") in result
                assert result[("t1","ikiru")].get("rating") == 8.5
                assert result[("t2","shinigami")].get("rating") == 8.5
                # common.py re-exports removed — series_meta is canonical
                sm.invalidate("ikiru","t1")
                assert "ikiru:t1" not in sm._cache
                assert "t1" not in sm._cache
                mock_redis.delete.assert_called_with("series_meta:ikiru:t1")
                # t2 still cached
                assert "shinigami:t2" in sm._cache
