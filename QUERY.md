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

## 3. Verifikasi

```sql
SELECT origin, type, COUNT(*) FROM recent_chapters WHERE source='shinigami' GROUP BY origin,type;
-- expect: (KR,manhwa) 99, (CN,manhua) 29, no (CN,manhwa)
SELECT title FROM recent_chapters WHERE title LIKE '%�%' LIMIT 5;
-- expect: 0 rows
```

Code fix sudah di `32e124e` (`lib/utils.ts:112` `FFFD→’` + `shinigami.py:14,50,123` origin sync), query ini cuma bersihkan row lama sebelum deploy.
