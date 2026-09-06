# QUERY.md — Hotfix queries (temporary, before code deploy fixes existing rows)

> Full admin only, `psql $DATABASE_URL -f QUERY.md` atau paste di Supabase SQL editor. Idempotent (`WHERE LIKE`).

## 1. Title mojibake � → ’ (shinigami 0x92 Windows-1252 mis-decoded)

```sql
UPDATE recent_chapters SET title = REPLACE(REPLACE(title, '�', '’'), E'\x92', '’') WHERE title LIKE '%�%' OR title LIKE E'%\x92%';
UPDATE whitelist SET title = REPLACE(REPLACE(title, '�', '’'), E'\x92', '’') WHERE title LIKE '%�%' OR title LIKE E'%\x92%';
UPDATE dispatch_history SET chapter_title = REPLACE(chapter_title, '�', '’') WHERE chapter_title LIKE '%�%';
UPDATE series_meta SET title_key = REPLACE(title_key, '�', '') WHERE title_key LIKE '%�%';
UPDATE chapter_bookmarks SET title = REPLACE(title, '�', '’') WHERE title LIKE '%�%';
UPDATE excluded_titles SET title = REPLACE(title, '�', '’') WHERE title LIKE '%�%' OR title LIKE E'%\x92%';
```

## 2. Origin CN=manhua KR=manhwa sync (janggal 1 row CN/manhwa shinigami)

```sql
UPDATE recent_chapters SET type='manhua' WHERE origin='CN' AND type='manhwa';
UPDATE recent_chapters SET type='manhwa' WHERE origin='KR' AND type='manhua';
UPDATE whitelist SET type='manhua' WHERE origin='CN' AND type='manhwa';
UPDATE whitelist SET type='manhwa' WHERE origin='KR' AND type='manhua';
UPDATE series_meta SET type='manhua' WHERE origin='CN' AND type='manhwa';
UPDATE series_meta SET type='manhwa' WHERE origin='KR' AND type='manhua';
```

## 3. Whitelist series_url fallback (79 null merge=false)

```sql
-- backfill from url column where present
UPDATE whitelist SET series_url = url WHERE (series_url IS NULL OR series_url='') AND url LIKE 'http%';
-- construct for ikiru/voratoon from title_key when still null
UPDATE whitelist SET series_url = 'https://07.ikiru.wtf/manga/' || title_key || '/' WHERE source='ikiru' AND (series_url IS NULL OR series_url='');
UPDATE whitelist SET series_url = 'https://v1.voratoon.com/series/' || title_key WHERE source='voratoon' AND (series_url IS NULL OR series_url='');
-- shinigami: pull from recent_chapters if available
UPDATE whitelist w SET series_url = rc.series_url FROM (SELECT DISTINCT title_key, series_url FROM recent_chapters WHERE source='shinigami' AND series_url LIKE 'http%') rc WHERE w.source='shinigami' AND (w.series_url IS NULL OR w.series_url='') AND w.title_key = rc.title_key;

-- verifikasi
SELECT COUNT(*) FROM whitelist WHERE series_url IS NULL OR series_url='';
-- expect: 0
```

## 4. Voratoon slug spaces %20 → dash (a painter..., chronicles..., i became...)

```sql
-- generic: ganti spasi/%20 di slug voratoon jadi -
UPDATE whitelist SET series_url = REGEXP_REPLACE(series_url, '(%20| )+', '-', 'g') WHERE source='voratoon' AND series_url LIKE '%voratoon.com/series/%' AND (series_url LIKE '% %' OR series_url LIKE '%\%20%');
-- lower + collapse -- (optional, idempotent)
UPDATE whitelist SET series_url = LOWER(REGEXP_REPLACE(series_url, '-+', '-', 'g')) WHERE source='voratoon' AND series_url LIKE '%voratoon.com/series/%';
-- 3 row spesifik (idempotent)
UPDATE whitelist SET series_url = 'https://v1.voratoon.com/series/a-painter-who-draws-dungeons' WHERE source='voratoon' AND title='A Painter Who Draws Dungeons';
UPDATE whitelist SET series_url = 'https://v1.voratoon.com/series/chronicles-of-the-lazy-sovereign' WHERE source='voratoon' AND title='Chronicles of the Lazy Sovereign';
UPDATE whitelist SET series_url = 'https://v1.voratoon.com/series/i-became-the-master-of-the-weakest-demon-king' WHERE source='voratoon' AND title ILIKE 'I Became the Master of the Weakest Demon King%';
-- recent_chapters juga kalau ada
UPDATE recent_chapters SET series_url = REGEXP_REPLACE(series_url, '(%20| )+', '-', 'g') WHERE source='voratoon' AND series_url LIKE '%voratoon.com/series/%' AND (series_url LIKE '% %' OR series_url LIKE '%\%20%');
```

## 5. Dispatch/whitelist description � + shinigami 33 null (435d901)

```sql
-- dispatch_history / recent_chapters description mojibake (300�sebuah)
UPDATE recent_chapters SET description = REPLACE(REPLACE(description, '�', '’'), E'\x92', '’') WHERE description LIKE '%�%' OR description LIKE E'%\x92%';
UPDATE whitelist SET description = REPLACE(REPLACE(description, '�', '’'), E'\x92', '’') WHERE description LIKE '%�%' OR description LIKE E'%\x92%';
UPDATE dispatch_history SET chapter_title = REPLACE(REPLACE(chapter_title, '�', '’'), E'\x92', '’') WHERE chapter_title LIKE '%�%' OR chapter_title LIKE E'%\x92%';
-- shinigami whitelist 33 null series_url -> construct dari UUID
UPDATE whitelist SET series_url = 'https://11.shinigami.asia/series/' || title_key WHERE source='shinigami' AND (series_url IS NULL OR series_url='') AND title_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-';
```

## 6. Verifikasi

```sql
SELECT origin, type, COUNT(*) FROM recent_chapters WHERE source='shinigami' GROUP BY origin,type;
-- expect: (KR,manhwa) 99, (CN,manhua) 29, no (CN,manhwa)
SELECT title FROM recent_chapters WHERE title LIKE '%�%' LIMIT 5;
-- expect: 0 rows
SELECT description FROM dispatch_history WHERE description LIKE '%�%' LIMIT 5;
-- expect: 0 rows
SELECT COUNT(*) FROM whitelist WHERE series_url IS NULL OR series_url='';
-- expect: 0 rows
SELECT title, series_url FROM whitelist WHERE source='voratoon' AND series_url LIKE '%\%20%' OR series_url LIKE '% %' LIMIT 5;
-- expect: 0 rows
SELECT COUNT(*) FROM whitelist WHERE source='shinigami' AND (series_url IS NULL OR series_url='');
-- expect: 0 rows (435d901 fallback)
```

Code fix sudah di `32e124e` (`lib/utils.ts:112` `FFFD→’` + `shinigami.py:14,50,123` origin sync) + `0c9cddd` (`whitelist_service.py:567` fallback) + `ffdcf4f` (`whitelist_service.py:579` slug %20→-) + `435d901` (`dispatch_history fcfsKey` + description + shinigami UUID), query ini cuma bersihkan row lama sebelum deploy.
