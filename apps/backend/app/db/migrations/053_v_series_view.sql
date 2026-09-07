-- 053_v_series_view.sql — v_series MATERIALIZED VIEW over series_meta (canonical static fields)
-- ponytail: MATERIALIZED + CONCURRENTLY — REFRESH handled by series_meta_sync.py after upsert; UNIQUE INDEX on (title_key, source) required for CONCURRENTLY
DROP VIEW IF EXISTS v_series;
DROP MATERIALIZED VIEW IF EXISTS v_series;
CREATE MATERIALIZED VIEW IF NOT EXISTS v_series AS
SELECT title_key, source, cover, rating, genres, description, type, origin
FROM series_meta;
CREATE UNIQUE INDEX IF NOT EXISTS v_series_pkey ON v_series (title_key, source);
