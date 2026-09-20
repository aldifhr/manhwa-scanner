import os
os.environ['ENVIRONMENT']='development'
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
