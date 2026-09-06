# QUERY.md — Hotfix queries

> Full admin only, `psql $DATABASE_URL -f QUERY.md` atau Supabase SQL editor. Idempotent.

## Status: All green (2026-09-06)

- Mojibake `�/0x92` → `’`: 0 rows remaining
- Origin `CN/manhwa` → `CN/manhua`: 0 rows
- Whitelist `series_url` null: 0 rows (33 shinigami UUID fixed)
- Voratoon slug `%20` → `-`: 0 rows
- Dispatch `description �`: 0 rows

Code fix live: `32e124e` `0c9cddd` `ffdcf4f` `435d901`. Tidak ada query pending.

## Verifikasi (should be 0)

```sql
SELECT COUNT(*) FROM recent_chapters WHERE title LIKE '%�%' OR description LIKE '%�%';
SELECT COUNT(*) FROM whitelist WHERE series_url IS NULL OR series_url='';
SELECT origin, type, COUNT(*) FROM recent_chapters WHERE source='shinigami' GROUP BY origin,type;
SELECT COUNT(*) FROM whitelist WHERE source='voratoon' AND (series_url LIKE '% %' OR series_url LIKE '%\%20%');
```
