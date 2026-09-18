# Bug Files — manhwa-scanner (audit 2026-09-10, branch main@6c4d366)

> Hanya file dengan temuan aktif / design debt yang belum/bisa diperketat. Prioritas 🔴/🟡 sesuai severity.

| # | File | Severity | Temuan | Rekomendasi |
|---|------|----------|--------|-------------|
| 1 | `apps/backend/app/api/system.py:191` `if not (require_cron_auth or require_monitor_auth)` | 🟡 Medium | `POST /api/v1/cron` menerima **fallback** `DASHBOARD_PASSWORD` JWT selain `CRON_SECRET`. Dengan `SameSite=None` + CSRF, fallback ini meningkatkan surface walau sudah mitigated `csrf.py:5` (kini `403` tanpa token). Trust boundary `cron` vs `admin` tercampur. | Opsi: ketat `require_cron_auth` only untuk `POST /cron` (dashboard trigger via `Bearer CRON_SECRET` atau buat `POST /api/v1/admin/cron` terpisah). Kalau keep fallback, pertahankan CSRF `forbid` + dokumentasikan sebagai intentional. |
| 2 | `apps/backend/app/db_adapter.py` pool init | 🟡 Low | `ThreadedConnectionPool` tanpa `connect_timeout=5` / `statement_timeout=10s` — query hang bisa block worker `BRPOPLPUSH` 5s. | Tambah `?connect_timeout=5` ke `DATABASE_URL` + `SET statement_timeout` di `get_conn`. |
| 3 | `apps/backend/app/tasks/queue.py:29` `socket_timeout=None` | 🟡 Low | Redis main `socket_timeout=None` (infinite) — `BLPOP` mengandalkan command timeout `5s`, tapi socket hang tetap block. | Set `socket_timeout=5` + `socket_keepalive=True` (health probe sudah `1s`). |
| 4 | `apps/backend/app/cron/collectors/voratoon.py` `TIMEOUT=60` | 🟡 Low | Voratoon 60s paling lama, mendominasi `collect 120s`. | Turun `30s` + parallel sudah, monitor p95. |
| 5 | `apps/backend/app/storage/recent_chapters.py:117` `_load_existing_rc` cutoff `24h` | 🟡 Low | Cache 60s key SHA256, tapi `_cutoff 24h` hardcode — tidak pakai `_RECENT_CHAPTERS_RETENTION_DAYS`. Minor drift. | Ganti ke `settings` constant. |
| 6 | `apps/frontend/lib/security/headers.ts` (CSP) | 🟡 Low | CSP `connect-src` masih include `fe.aldifhr.fun` walau CORS sudah hapus — tidak berbahaya tapi stale. | Sync hapus `fe.` dari CSP. |
| 7 | `BUG.md:381` BUG-7 | 🟡 Docs | Sudah marked `INVALID/WONTFIX` tapi `RULES.md:10` masih sebut `2 source` era lama. | Update `RULES.md` sync `3 sources`. |

> Catatan: **Tidak ada 🔴 open** — semua 🔴 (BUG-2/4/6, CSRF whitelist, queue RPOP race, retention 2d→30d, CORS regex, rate limiter) sudah FIXED di `0b13bfe`–`6c4d366`. Daftar di atas hanya 🟡 debt / hardening lanjutan, aman untuk `single VPS` deployment saat ini.
