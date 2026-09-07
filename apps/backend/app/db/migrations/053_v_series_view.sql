-- 053_v_series_view.sql — v_series VIEW over series_meta (canonical static fields)
-- ponytail: lazy VIEW not MATERIALIZED — no REFRESH/CONCURRENTLY bloat, always fresh; rss_service sm_map dict could be replaced by JOIN v_series (SELECT rc.*, v.cover, v.rating, v.genres, v.description, v.type, v.origin FROM recent_chapters rc LEFT JOIN v_series v ON v.title_key=rc.title_key AND v.source=rc.source) when extra query matters; upgrade to MATERIALIZED + REFRESH CONCURRENTLY only if JOIN proves slow
CREATE OR REPLACE VIEW v_series AS
SELECT title_key, source, cover, rating, genres, description, type, origin
FROM series_meta;
