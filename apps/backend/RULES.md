# RULES — Wajib Dipatuhi manhwa-backend

> Aturan ini adalah source of truth. Code yang melanggar RULES dianggap bug, bukan fitur.

## 1. Fresh 24 Jam Doang — Rolling Window

**Semua yang masuk `recent_chapters` & `RSS` & `dispatch` HARUS dalam 24 jam terakhir. Tidak ada backlog.**

- `RSS_LOOKBACK_HOURS = 24` (`app/config.py:38`) — satu-satunya window. Jangan pakai `48h`, `7d`, atau `all`.
- **Prune di awal setiap cron:** `recent_chapters.prune_older_than(24)` (`app/cron/pipeline.py:66` → `app/storage/recent_chapters.py:11` `DELETE WHERE updated_time < now-24h`). Backlog tidak pernah menumpuk.
- **Collect filter:** `collect_recent_chapters` skip `updated_time < now-24h` untuk ikiru (`app/cron/collect.py:235`) dan `release_date < now-24h` untuk shinigami (`collect.py:310`). Termasuk `collect_whitelisted_*` (`collect.py:652`).
- **Scraper paging stop:** `shinigami.get_shinigami_latest_updates` stop paginasi saat item tertua `< cutoff` (`app/scrapers/shinigami.py:94`), `ikiru.get_ikiru_latest_updates` skip slug `modified_gmt < cutoff` (`ikiru.py:105`).
- **Read path:** `get_recent_chapters(hours=24)` (`app/storage/recent_chapters.py:335`), `GET /api/rss` hardcode `hours=24` (`app/api/rss.py:137` `cutoff = now-24h`), `dashboard-snapshot` pakai `rc_24h` (`app/api/dashboard/stats.py:104`).
- **Dilarang:** Menambah `html_backlog` ke RSS, menaikkan `limit` tanpa `cutoff`, atau menyimpan `updated_time` palsu untuk re-touch.

## 2. FCFS Antar Kedua Sumber — Judul Sama = Satu Notif

**Hanya sumber pertama yang publish `judul + chapter` yang notif ke Discord. Sumber kedua (URL beda, judul sama) di-skip permanen.**

- **Key stabil:** `fcfs_key = normalize_title(title) + "#" + _norm_chapter(chapter)` (`app/cron/dispatch_mod.py:70`):
  - `normalize_title`: `html.unescape → lower → [^a-z0-9]→" "` (`dispatch_mod.py:39`) — `"Academy's"` == `"Academy&#8217;s"`.
  - `_norm_chapter`: `12.50→12.5`, `160-2→160.2` (`dispatch_mod.py:45`) — cross-source `12.5` vs `12.50` tetap sama.
- **Permanent dedup:** `_claimed_titles(fcfs_keys)` cek `dispatch_history.fcfs_key` (`dispatch_mod.py:81` → `app/storage/dispatch.py:49`). `dispatch_history.fcfs_key` unique (`022_dispatch_fcfs_latest_sent.sql:1`) — sekali `complete_dispatch_claim` tulis `fcfs_key`, selamanya skip.
- **Short-TTL claim:** `claim_and_record(urls, ..., fcfs_keys)` (`app/storage/dispatch.py:187`) `upsert(dispatch_claims, on_conflict=fcfs_key)` `expires=now+48h`, dedup intra-batch `seen_fk`, & pre-check `_claimed_fcfs_keys` — cegah double-send saat ikiru & shinigami sama chapter di 1 run.
- **Ceiling:** `whitelist.latest_sent_chapter` (`022` + `collect.py:243` `if ch <= ceiling: continue`) — chapter lama yang di-re-touch (timestamp baru, URL baru) tetap di bawah ceiling → skip.
- **Composite DB:** `recent_chapters` `UNIQUE(title_key, source, chapter_num) WHERE chapter_num IS NOT NULL` (`025_recent_chapters_composite_unique.sql:1` + `app/storage/recent_chapters.py:38` `_composite_key`) — URL di-rotate tidak bikin row kedua.
- **Runtime:** `dispatch()` cek `claimed_keys` + `_claimed_urls` + `seen_key_run` per channel (`dispatch_mod.py:145-173`) sebelum `send_channel_message`.
- **Dilarang:** Mengirim notif hanya berdasar `chapter_url` (shinigami/ikiru rotate URL tiap scrape → dedup gagal), memakai `title` tanpa `normalize`, atau menghapus `fcfs_key` dari `dispatch_history`.

## 3. Sumber Aktif

- Hanya `ikiru` + `shinigami` (`app/config.py:36` `SOURCE_KEYS`). Jangan tambah sumber tanpa migrasi & `PROXY_ALLOWED_HOSTS`.
- `collect` & `dispatch` flat-per-source — chapter yang sama di dua sumber tetap 2 row di `recent_chapters` (untuk audit), tapi 1 notif via FCFS.

## 4. Whitelist & Exclude — Source-Aware

- `whitelist` PK `(title_key, source)` (`016_whitelist_unique_constraints.sql:1`), `excluded_titles` PK `(title_key, source)` (`013_excluded_titles.sql:20`). `title_key = normalize_title_key(title)` (`app/utils/text.py:10`) — `Mata-Mata` == `Mata Mata`.
- `filter_whitelisted` (`app/cron/collect.py:391`) match `normalize(title_key) + ":" + source` — jangan pakai `title` mentah.
- `is_excluded` cek `(tk, source)` or `(tk, "all")` (`app/storage/excluded_titles.py:79`).

## 5. No Rate Limit Inbound & No MinIO

- Inbound `rate limiting` dihapus (`app/main.py:123` dihapus, `app/config.py:81` `CRON_RATE_LIMIT_*` dihapus) — auth via `CRON_SECRET`/`MONITOR_AUTH_TOKEN` + `CORS` allowlist (`app/main.py:62`).
- `MinIO` dihapus (`app/config.py:64`, `app/utils/minio_presign.py` stub, `PROXY_ALLOWED_HOSTS` tanpa `minio`). Cover langsung `ikiru/shinigami/assets.shngm.id` via `/api/reader/proxy`.

## 6. Validasi

- `GET /api/rss?group=true` harus `titleKey` unik per series (group by `canonicalTitleKey` `app/api/rss.py:233`).
- Test: tambah 2 judul sama beda sumber + chapter sama → 1 Discord embed. Re-scrape chapter lama dengan `updated_time` baru → 0 embed baru.
- Migrasi `025`, `026`, `027` wajib ada di fresh DB lokal — jangan ubah VPS tanpa sync.
