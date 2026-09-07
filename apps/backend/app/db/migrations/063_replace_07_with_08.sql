-- 062_replace_07_with_08.sql — 07.ikiru.wtf 301 -> 08.ikiru.wtf
-- ponytail: 07 cover 301 to 08, REPLACE to avoid redirect hop per image load

UPDATE recent_chapters SET cover = REPLACE(cover, '07.ikiru.wtf', '08.ikiru.wtf') WHERE cover LIKE '%07.ikiru.wtf%';
UPDATE series_meta SET cover = REPLACE(cover, '07.ikiru.wtf', '08.ikiru.wtf') WHERE cover LIKE '%07.ikiru.wtf%';
UPDATE whitelist SET cover = REPLACE(cover, '07.ikiru.wtf', '08.ikiru.wtf') WHERE cover LIKE '%07.ikiru.wtf%';
UPDATE whitelist SET series_url = REPLACE(series_url, '07.ikiru.wtf', '08.ikiru.wtf') WHERE series_url LIKE '%07.ikiru.wtf%';
UPDATE recent_chapters SET series_url = REPLACE(series_url, '07.ikiru.wtf', '08.ikiru.wtf') WHERE series_url LIKE '%07.ikiru.wtf%';
UPDATE recent_chapters SET chapter_url = REPLACE(chapter_url, '07.ikiru.wtf', '08.ikiru.wtf') WHERE chapter_url LIKE '%07.ikiru.wtf%';
