# BUG — Katalog

## BUG-2 — 🔴 Critical — Hardcoded default `DASHBOARD_PASSWORD` & boot guard bolong

### 1. Deskripsi

`apps/backend/app/config.py:58` punya fallback `DASHBOARD_PASSWORD: str = "manhwascan"` yang ke-commit di repo public. Password ini adalah **single credential full admin** ( `POST /api/auth?action=login` → `ikiru_dashboard_session` JWT → bisa `whitelist`/`exclude`/`dispatch`/`settings`/`dispatch_history`/`admin` ). Kalau deploy lupa set env, produksi **silent wide open** dengan password yang bisa ditebak dari GitHub.

### 2. Reproduksi

1. `ENVIRONMENT=production` (default `config.py:96`) + `.env` tanpa `DASHBOARD_PASSWORD` → `Settings()` `config.py:58` pakai `"manhwascan"`.
2. `from app.config import _validate_settings, settings; _validate_settings(settings)` `config.py:138` tidak throw — cek `config.py:152-161`:
   ```python
   missing=[]
   if not s.CRON_SECRET: missing.append("CRON_SECRET") #152
   if not s.MONITOR_AUTH_TOKEN: ... #154
   if not s.AUTH_SECRET: ... #156
   if not s.DATABASE_URL: ... #158
   if not s.DISCORD_BOT_TOKEN: ... #160
   # DASHBOARD_PASSWORD tidak pernah dicek
   if missing: raise RuntimeError(...)
   ```
3. `curl -X POST https://scanner.aldifhr.fun/api/auth?action=login -H 'Content-Type: application/json' -d '{"password":"manhwascan"}'` → `200` + `set-cookie: ikiru_dashboard_session` `apps/backend/app/api/auth.py:95,117` (`_password_ok()` `auth.py:90` `candidates=[DASHBOARD_PASSWORD, MONITOR_AUTH_TOKEN]` `hmac.compare_digest`).

### 3. Root Cause

| Komponen              | Kode                                                                                                                                | Perilaku                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Default insecure**  | `config.py:58`                                                                                                                      | Hanya `DASHBOARD_PASSWORD` yang default non-kosong (`"manhwascan"`), 5 secret lain default `""` (`CRON_SECRET:53`, `MONITOR_AUTH_TOKEN:56`, `AUTH_SECRET:62`, `DATABASE_URL:22`, `DISCORD_BOT_TOKEN:10`). |
| **Boot guard bolong** | `config.py:138` `_validate_settings()`                                                                                              | Cek 5 secret di atas, tapi tidak cek `DASHBOARD_PASSWORD`. Karena default `truthy`, `if not s.DASHBOARD_PASSWORD` tidak pernah trigger walau password masih bawaan repo.                                  |
| **Auth fallback**     | `auth.py:90` `candidates = [DASHBOARD_PASSWORD, MONITOR_AUTH_TOKEN]` + `apps/backend/app/utils/auth.py:14` `_dashboard_passwords()` | Kalau `DASHBOARD_PASSWORD` default, `MONITOR_AUTH_TOKEN` yang sudah di-guard tetap bisa jadi alias, tapi `"manhwascan"` tetap valid sebagai password pertama.                                             |
| **Docs**              | `apps/backend/.env.example:1`                                                                                                       | Tidak mendokumentasikan `DASHBOARD_PASSWORD` sama sekali, makin mudah ke-skip.                                                                                                                            |
| **Test**              | `apps/backend/tests/test_utils_auth.py:25,33...`                                                                                    | Test mock `DASHBOARD_PASSWORD="manhwascan"` — kalau default diubah ke `""`, test perlu update.                                                                                                            |

### 4. Dampak

- **Confidentiality/Integrity full admin** — siapa pun yang baca repo bisa login `admin` di `https://scanner.aldifhr.fun` / `komik.aldifhr.fun` kalau env lupa set.
- **Silent failure** — boot guard yang dimaksudkan untuk cegah `auth disabled because .env not loaded` `config.py:142` justru tidak menangkap kasus ini.

### 5. Solusi (tanpa patch sekarang — sesuai instruksi)

**Opsi A — ubah default ke kosong + guard (paling aman, sama seperti 5 secret lain):**

```python
# config.py:58
DASHBOARD_PASSWORD: str = ""  # was "manhwascan"
# config.py:152 (di _validate_settings, sebelum if missing:)
if not s.DASHBOARD_PASSWORD:
    missing.append("DASHBOARD_PASSWORD")
```

**Opsi B — guard cek nilai default (kompatibel dev, tetap aman di prod):**

```python
if not s.DASHBOARD_PASSWORD or s.DASHBOARD_PASSWORD == "manhwascan":
    missing.append("DASHBOARD_PASSWORD")
```

Untuk dev, set `ENVIRONMENT=development` (guard bypass `config.py:149`) atau set `DASHBOARD_PASSWORD=devpass` di `.env`.

Tambahan:

- Tambah `DASHBOARD_PASSWORD=change-me` ke `apps/backend/.env.example` dengan komentar `MUST be set in production`.
- Update `tests/test_utils_auth.py` mock tetap `"manhwascan"` untuk test, tapi boot guard test baru untuk `DASHBOARD_PASSWORD` missing.

### 6. Verifikasi (rencana)

```bash
ENVIRONMENT=production DASHBOARD_PASSWORD="" python -c "from app.config import settings, _validate_settings; _validate_settings(settings)"
# → RuntimeError: BOOT GUARD: ... DASHBOARD_PASSWORD

ENVIRONMENT=production DASHBOARD_PASSWORD="manhwascan" python -c "..."
# → RuntimeError (opsi B)

ENVIRONMENT=production DASHBOARD_PASSWORD="s3cr3t-32-chars" CRON_SECRET=x MONITOR_AUTH_TOKEN=x AUTH_SECRET=x DATABASE_URL=postgres://... DISCORD_BOT_TOKEN=x python -c "..."
# → OK

curl -X POST http://localhost:8000/api/auth?action=login -d '{"password":"manhwascan"}'
# → 401 setelah fix (sebelum fix 200)
```

### 7. File terkait

- `apps/backend/app/config.py:58,96,138,152,170`
- `apps/backend/app/api/auth.py:3,90,95`
- `apps/backend/app/utils/auth.py:14`
- `apps/backend/.env.example:1`
- `apps/backend/tests/test_utils_auth.py:25`

### 8. Status

- Dicatat 2026-09-09 — **tidak di-patch** sesuai instruksi, hanya dokumentasi. Patch menunggu approval untuk ubah `config.py:58,152`.

---

## BUG-3 — 🟡 Medium — Dispatch dedup ledger retention `1` hari terlalu pendek

### 1. Deskripsi

`apps/backend/app/tasks/retention.py:7` `_DISPATCH_HISTORY_RETENTION_DAYS = 1` (dan `apps/backend/app/cron/pipeline.py:56` `prune_dispatch_history_older_than(24)` tiap cron) mem-prune `dispatch_history` tiap jam. `dispatch_history` adalah ledger dedup **permanen** sebelum kirim Discord (`dispatch_mod.py:42` FCFS `fcfs_key`, `app/storage/dispatch.py:49` `_claimed_titles`), jadi kalau `scraping/collection` telat >1 hari (VPS down, source outage), `gap_detector.py:67` akan re-proses chapter yang record-nya sudah ter-prune → duplikat notifikasi. Audit `be-ag-py` lalu sudah flag `2 hari vs docstring 90 hari`, sekarang makin ketat `1 hari`.

### 2. Reproduksi

1. `retention.py:7` + `pipeline.py:56` → `DELETE FROM dispatch_history WHERE sent_at < now()-1d` (`retention.py:23`, `recent_chapters.py:55`).
2. `dispatch_history` dicek di `dispatch_mod.py:125,142,153,169`, `rss_service.py:82,135` (`NOT EXISTS dispatch_history`, `dh_sent gte cutoff`), `claim.py:117,122`, `queue_dashboard.py:263`.
3. Downtime 36 jam → `recent_chapters` masih ada (retain `7d` `retention.py:10`), tapi `dispatch_history` untuk `chapter X` sudah hilang → `_claimed_titles([])` kosong → `dispatch()` kirim ulang.

### 3. Root Cause

| Komponen                  | Kode                                                                                                                                   | Perilaku                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Prune harian**          | `retention.py:7,23`, `pipeline.py:54-56`                                                                                               | `cutoff = now-1d` tiap jam + tiap cron start (`user: "jangan 2 hari"`). |
| **Ekspektasi arsitektur** | `ARCHITECTURE.md:356` `dispatch_history 90 days, 922 rows`                                                                             | Seharusnya ledger 90 hari, bukan 1 hari.                                |
| **Feed vs ledger campur** | `recent_chapters.py:15` `prune_older_than 24h` benar untuk feed window, tapi `dispatch_history` ikut 24h padahal ledger harus panjang. |

### 4. Dampak

- Duplikat Discord kalau `gap >1d` (prior bug class sama, sekarang `1d` < `2d` lalu).
- `ARCHITECTURE.md` vs kode tidak sinkron.

### 5. Solusi — `2` hari (sesuai instruksi)

```python
# retention.py:7
_DISPATCH_HISTORY_RETENTION_DAYS = 2  # was 1
# pipeline.py:56
recent_chapters.prune_dispatch_history_older_than(48)  # was 24 — sync dengan retensi 2d
```

Alternatif deliberate `7`/`30`/`90` hari untuk ledger (jaga `500` per-series `retention.py:11` + index `sent_at` `migrations/034:28`), `recent_chapters` tetap `24h` untuk RSS. Untuk sekarang pakai `2` hari sebagai kompromi user.

### 6. Verifikasi (rencana)

```bash
grep _DISPATCH_HISTORY_RETENTION_DAYS apps/backend/app/tasks/retention.py # → 2
grep prune_dispatch_history_older_than apps/backend/app/cron/pipeline.py # → 48
# Simulasi: insert dispatch_history sent_at=now-36h, tunggu hourly prune → row tetap ada (sebelum fix terhapus), gap resync tidak duplikat.
```

### 7. File terkait

- `apps/backend/app/tasks/retention.py:7,23`
- `apps/backend/app/cron/pipeline.py:54,56`
- `apps/backend/app/storage/recent_chapters.py:46,55`
- `apps/backend/app/cron/dispatch_mod.py:42,120`, `apps/backend/app/services/rss_service.py:82,135`, `apps/backend/app/cron/gap_detector.py:67`
- `ARCHITECTURE.md:356`

### 8. Status

- Dicatat 2026-09-09 — solusi `2` hari, patch menunggu eksekusi `retention.py:7` + `pipeline.py:56`.

---

# BUG — Cron Jobs FIFO tidak pernah berkurang (358 jobs)

## 1. Deskripsi

`GET /cron` → `GET /api/v1/queue/cron` menampilkan `Total jobs 358` (`update 204`, `rss-fetch 126`, `enrich 8`, `enrich-missing 8`, …) dengan tabel `# Action / Source / Title / Attempts` 358 baris. Seharusnya tiap `process` (`blpop`) job hilang dari Redis, tapi counter terus naik ke 300+ dan tidak pernah turun.

Payload contoh:

```json
{"action":"update","title":"dispatch chapters"}
{"action":"rss-fetch:ikiru","source":"ikiru"}
{"action":"rss-fetch:shinigami","source":"shinigami"}
{"action":"rss-fetch:voratoon","source":"voratoon"}
{"action":"enrich","title":"whitelist enrichment"}
```

## 2. Reproduksi

1. `GET /api/v1/queue/cron` (via `apps/frontend/app/cron/page.tsx:10-16`) → `r.lrange(CRON_QUEUE_KEY,0,-1)` `apps/backend/app/api/queue_dashboard.py:24`
2. Total `204 update` + `126 rss-fetch` = persis `7 jam` tanpa `blpop`:
   - `update` tiap `120s` `apps/backend/app/tasks/scheduler.py:59` → `204×120s ≈ 6.8h`
   - `rss-fetch:ikiru/shinigami/voratoon` tiap `600s` `scheduler.py:63` → `126/3=42 batch ×600s = 7h`

## 3. Root Cause — FIFO tanpa consumer

| Komponen    | Kode                                                                                                                       | Perilaku                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enqueue** | `apps/backend/app/api/system.py:210` → `enqueue_cron()` `apps/backend/app/tasks/queue.py:39` `rpush(CRON_QUEUE_KEY, json)` | Tiap `POST /api/cron?action=update` (FastCron / manual / `scheduler.py:59` ) langsung `rpush` ke tail. Tidak ada dedup — `update` yang sama bisa `rpush` 204×.                                                                           |
| **Queue**   | `apps/backend/app/tasks/queue.py:12` `CRON_QUEUE_KEY="beag:cron"` `Redis LIST`                                             | FIFO `rpush` (tail) + `blpop` (head). Tidak ada TTL, tidak ada `maxlen`.                                                                                                                                                                 |
| **Dequeue** | `apps/backend/app/tasks/lifecycle.py:110` `blpop(CRON_QUEUE_KEY,5)` → `run_cron_inline()`                                  | Hanya dijalankan kalau `ROLE=cron` `apps/backend/app/main.py:28-31` (`threading.Thread(run_cron_worker)` + `start_cron_scheduler`). `ROLE=api` (default PM2) hanya `start_worker()` untuk `QUEUE_KEY`, tidak pernah `blpop` `beag:cron`. |
| **Inspect** | `apps/backend/app/api/queue_dashboard.py:24` `lrange 0 -1`, `apps/frontend/app/cron/page.tsx:80`                           | Hanya read, tidak pop. Jadi kalau worker mati 7 jam, queue = 358 dan `isLoading` `page.tsx:38` terus menampilkan jumlah naik.                                                                                                            |
| **Guard**   | `apps/backend/app/tasks/scheduler.py:107` `if qlen>50 log.error`                                                           | Log saja, tetap `enqueue`.                                                                                                                                                                                                               |

Verifikasi: `main.py:28` `_role = os.environ.get("ROLE")` → `pm2 list` di host hanya `api`, tidak ada `cron`. `redis-cli LLEN beag:cron` → 358, `LRANGE beag:cron 0 5` → duplikat `update` berurutan.

## 4. Dampak

- Memory Redis tumbuh tanpa batas; `update` duplikat membuang `run_pipeline(action=update)` 204× berurutan padahal cukup 1.
- `rss-fetch` tiap source menumpuk → `is_excluded`/`whitelist` tidak ter-refresh tepat waktu.
- `/cron` (protected) terlihat “menggila” 300+ jobs.

## 5. Solusi (diimplementasikan)

### 5.1 Immediate — flush stale

```bash
redis-cli DEL beag:cron
# atau via API baru DELETE /api/v1/queue/cron (queue_dashboard.py)
```

### 5.2 Consumer harus selalu jalan

`ecosystem.config.js` / `pm2` → 2 process:

```
apps/frontend  : ROLE=api   (HTTP, tidak cron)
apps/backend   : ROLE=cron  (run_cron_worker + start_cron_scheduler)
```

Healthcheck: `GET /api/v1/queue/status` `queue_dashboard.py:53` `queue_depth` harus `< 10`.

### 5.3 Dedup `enqueue_cron` `queue.py:31`

```python
def enqueue_cron(action, source="", title=""):
    r = _get_redis()
    # coalesce: kalau action sama sudah di queue, skip
    if r.lrange(CRON_QUEUE_KEY, 0, -1):
        if any(json.loads(x).get("action")==action for x in r.lrange(CRON_QUEUE_KEY,0,-1)):
            logger.info("enqueue_cron dedup skip", action=action); return
    r.rpush(CRON_QUEUE_KEY, json.dumps(payload))
```

Alternatif: pakai `SET` (`SADD`) untuk cron (idempotent) atau `LTRIM` + `maxlen`.

### 5.4 Guard scheduler `scheduler.py:107`

```python
qlen = _get_redis().llen(CRON_QUEUE_KEY)
if qlen > 50:
    logger.warn("cron queue full, skip enqueue", qlen=qlen); continue
```

### 5.5 UI + API clear

- `DELETE /api/v1/queue/cron` `queue_dashboard.py` → `r.delete(CRON_QUEUE_KEY)` (mirip `clear_dlq` `queue_dashboard.py:269`)
- Tombol **Clear 358 jobs** di `apps/frontend/app/cron/page.tsx:60` + auto-refresh 10s sudah ada.

### 5.6 Verifikasi

- `npm --prefix apps/frontend run build` OK
- `redis-cli LLEN beag:cron` → 0 setelah `DEL`, lalu `POST /api/cron?action=update` → `LLEN` 1, `pm2 logs cron-worker` → `cron pipeline done action=update` dan `LLEN` kembali 0 (FIFO benar).
- `GET /api/v1/queue/cron` → `{"total":0,"jobs":[]}`

## 6. File terkait

- BE: `apps/backend/app/tasks/queue.py:12,31,39`, `apps/backend/app/tasks/lifecycle.py:105,110`, `apps/backend/app/tasks/scheduler.py:59,63,107`, `apps/backend/app/api/system.py:186,210`, `apps/backend/app/api/queue_dashboard.py:14,24`, `apps/backend/app/main.py:28`
- FE: `apps/frontend/app/cron/page.tsx:10,32,60`, `apps/frontend/app/api/cron/route.ts:92`
- Env: `CRON_SECRET`, `ROLE`, `REDIS_URL`

## 7. Status

- BUG dicatat 2026-09-09
- Solusi 5.1–5.3 siap di-push; 5.5 butuh persetujuan untuk ubah `queue.py` + `queue_dashboard.py` + `cron/page.tsx`.

---

## BUG-4 — 🔴 High — CSRF bypass `SameSite=None` + whitelist `csrf.py:5`

### 1. Deskripsi

`_CSRF_WHITELIST = {"/api/v1/auth", "/api/v1/interactive", "/api/v1/cron", "/api/v1/reader/whitelist", "/api/v1/whitelist"}` `apps/backend/app/middleware/csrf.py:5` membebaskan `POST /api/v1/whitelist` (`WhitelistCreate` `dashboard/whitelist.py:22`) dan `POST /api/v1/cron` (`enqueue_cron` `app/api/system.py:210` `system.py:181` `cron_trigger`). Kedua route mutasi state (whitelist/dispatch queue) dan cek auth via `ikiru_dashboard_session` cookie `utils/request_auth.py:11` + `auth.py:66` (`_get_session_cookie` cookie/Bearer). Cookie di-set `SameSite=None; Secure; domain=.aldifhr.fun` `app/api/auth.py:68,79`, jadi browser **akan kirim cookie cross-site**. Tanpa `x-csrf-token` (whitelist), `fetch` cross-site dengan `credentials:include` sukses → whitelist poisoning / cron spam.

### 2. Reproduksi

1. Login `POST /api/auth?action=login {"password": DASHBOARD_PASSWORD}` → `set-cookie: ikiru_dashboard_session=JWT; SameSite=None`.
2. Dari `https://evil.com`:
   ```html
   <form action="https://scanner.aldifhr.fun/api/v1/whitelist" method="POST">
     <input name='{"title":"pwn","source":"ikiru"}' />
   </form>
   <script>
     fetch("https://scanner.aldifhr.fun/api/v1/whitelist", {
       method: "POST",
       credentials: "include",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ title: "pwn", source: "ikiru" }),
     });
   </script>
   ```
   Request lewat `csrf_middleware` `csrf.py:13` `if _path in _CSRF_WHITELIST: return call_next` → `200` tanpa `x-csrf-token`, padahal route lain butuh `cookie_token==header_token` `csrf.py:17`.
3. Sama untuk `POST https://scanner.aldifhr.fun/api/cron?action=update` (hanya butuh cookie `monitor` via `require_monitor_auth`, tapi CSRF di-bypass).

### 3. Root Cause

- `SameSite=None` `auth.py:68,79` memang dibutuhkan untuk cross-subdomain `scanner↔komik` `.aldifhr.fun`, tapi tanpa CSRF jadi CSRF-prone.
- Whitelist seharusnya hanya untuk `auth`/`interactive` (login tidak butuh CSRF), tapi ditambah `whitelist`/`cron` yang state-changing. `Bearer` bypass `csrf.py:10` benar, tapi cookie path tetap lolos.

### 4. Dampak

- Cross-site whitelist injection → RSS/dispatch kirim chapter attacker-chosen. Cron `update` spam → `beag:cron` 358 → DoS (sudah terlihat).

### 5. Solusi (tanpa patch sekarang)

```python
# csrf.py:5
_CSRF_WHITELIST = {"/api/v1/auth", "/api/v1/interactive"}  # hapus /api/v1/cron, /api/v1/whitelist, /api/v1/reader/whitelist
```

- FE sudah kirim `x-csrf-token` via `withCsrf()` `apps/frontend/lib/csrf.ts` + `reader/transport.ts`, jadi tidak break.
- Alternatif: ubah `SameSite=None` → `Lax` untuk `ikiru_dashboard_session` + tambah `Origin` check di `security_headers_middleware`.

### 6. File terkait

- `apps/backend/app/middleware/csrf.py:5,13,17`
- `apps/backend/app/api/auth.py:66,68`
- `apps/backend/app/api/system.py:181,210`
- `apps/backend/app/api/dashboard/whitelist.py:22`
- `apps/backend/app/utils/request_auth.py:11`

### 7. Status

- Dicatat 2026-09-09 — valid, solusi hapus dari whitelist, patch menunggu approval.

---

## BUG-5 — 🔴 High — Duplicate `DASHBOARD_PASSWORD` (sudah BUG-2)

Sama dengan `BUG-2` `config.py:58` `DASHBOARD_PASSWORD="manhwascan"` + guard `config.py:152` tidak cek. Lihat `BUG-2` untuk detail & solusi `if not s.DASHBOARD_PASSWORD or s.DASHBOARD_PASSWORD=="manhwascan"`. Tidak ditambah duplikat.

---

## BUG-6 — 🔴 High — `autocommit=True` pecah transaksi `FOR UPDATE SKIP LOCKED` dispatch claims

### 1. Deskripsi

`apps/backend/app/db_adapter.py:125` `conn.autocommit = True` di `get_conn()` `db_adapter.py:91` agar `READ COMMITTED` tidak stale (`comment 118-123` “frozen snapshot … The Villain Of Destiny”). Tapi `claim_recent_chapters_for_dispatch()` `apps/backend/app/services/claim.py:82` `SELECT ... FOR UPDATE SKIP LOCKED` + `INSERT dispatch_claims` `claim.py:202` (dan `app/storage/dispatch.py:193` `claim_and_record` `get_conn` + `SELECT dispatch_history/claim` + `INSERT`) mengandalkan **satu transaksi**: lock harus di-hold sampai claim tertulis. Dengan `autocommit=True` tiap `cur.execute` langsung `commit`, lock `FOR UPDATE` dilepas segera → dua worker concurrent bisa `claim` chapter sama → double Discord.

### 2. Reproduksi

1. `psycopg2` default `autocommit=False` → `BEGIN` implisit sampai `commit()`. `db_adapter:get_conn` paksa `True` → tiap `cur.execute(...)` auto-commit.
2. `claim.py:82` `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 500` → lock rows, tapi `autocommit` → `commit` langsung → lock release.
3. Worker A & B `blpop` `beag:cron` hampir bersamaan (cron `update` tiap `120s`), keduanya `SELECT ... FOR UPDATE SKIP LOCKED` dapat row sama sebelum `INSERT dispatch_claims` `claim.py:202`, keduanya `INSERT ON CONFLICT fcfs_key DO UPDATE` sukses → `dispatch()` kirim duplikat.
4. Log `dispatch_claims insert failed` `claim.py:210` + `dispatch_history_uq` race `dispatch.py:397` adalah symptom, bukan guard.

### 3. Root Cause

- Fix stale snapshot `db_adapter.py:119` pakai `autocommit=True` global, tapi claim butuh `autocommit=False` transaksi.
- `put_conn` `db_adapter.py:159` tidak `commit/rollback` eksplisit karena `autocommit`, jadi transaksi tidak pernah di-hold.

### 4. Dampak

- Duplikat notifikasi Discord untuk `shinigami/ikiru` rotate URL (yang di-dedup via `fcfs_key`).

### 5. Solusi (tanpa patch sekarang)

```python
# claim.py:79 — setelah get_conn(), matikan autocommit untuk transaksi claim
conn = get_conn()
conn.autocommit = False
cur = conn.cursor()
try:
    cur.execute("SELECT ... FOR UPDATE SKIP LOCKED", ...)
    # ... dedup checks ...
    cur.execute("INSERT INTO dispatch_claims ...", ...)
    conn.commit()
except Exception:
    conn.rollback(); raise
finally:
    conn.autocommit = True; put_conn(conn)
```

Sama untuk `app/storage/dispatch.py:197` `claim_and_record`. Alternatif: pakai `with conn:` + `conn.autocommit=False` atau `SELECT ... FOR UPDATE` di `SERIALIZABLE` + `ON CONFLICT DO NOTHING` sebagai guard (sudah ada).

### 6. File terkait

- `apps/backend/app/db_adapter.py:91,125,118`
- `apps/backend/app/services/claim.py:82,202,84`
- `apps/backend/app/storage/dispatch.py:193,269`
- `apps/backend/app/tasks/lifecycle.py:105` (cron worker concurrency)

### 7. Status

- Dicatat 2026-09-09 — valid, solusi transaksi, patch menunggu approval.

---

## BUG-7 — 🟡 Medium — Voratoon aktif padahal kontrak `2 source` (ikiru+shinigami)

### 1. Deskripsi

`config.py:44` `SOURCE_KEYS: list[str] = ["ikiru", "shinigami", "voratoon"]` + comment `config.py:43` `# Only ikiru + shinigami are active sources (user: "cukup 2 sumber aja")`. `collect_recent_chapters()` `apps/backend/app/cron/collect.py:109` loop `for _src in ("ikiru","shinigami","voratoon")` tanpa cek `DISABLED_SOURCES` default `""` `config.py:47`, jadi voratoon tetap di-scrape (`rss-fetch:voratoon` terlihat di `/cron` `voratoon 2` ), `sourceHealth` `voratoon` `pipeline.py:277`, `enrich_whitelist.py:306` `cover voratoon`.

### 2. Dampak

- 3 source load padahal user minta 2 → `rss-fetch:voratoon` overhead + `cvr.voratoon.id` presigned expire handling.

### 3. Solusi

- Opsi A — update kontrak: `config.py:43` comment → `3 sources (ikiru, shinigami, voratoon)` (kalau voratoon memang mau aktif).
- Opsi B — hormati kontrak 2: `SOURCE_KEYS = ["ikiru","shinigami"]` atau default `DISABLED_SOURCES="voratoon"` `config.py:47`.

### 4. File terkait

- `apps/backend/app/config.py:43,44`
- `apps/backend/app/cron/collect.py:109,118`
- `apps/backend/app/cron/enrich_whitelist.py:306`

### 5. Status

- Dicatat 2026-09-09 — valid, solusi ubah `SOURCE_KEYS` atau `DISABLED_SOURCES`, patch menunggu approval.

---

## BUG-8 — 🟡 Medium — Whitelist API tolak `JP` padahal backend support `JP`

### 1. Deskripsi

`WhitelistCreate` `apps/backend/app/api/dashboard/whitelist.py:30` `origin: Optional[Literal["KR","CN"]]`, `WhitelistPatch` `whitelist.py:50` sama — hanya `KR`/`CN`. BE `normalize_origin` support `JP` (manga), `rss_service.py:118` `origin`, `recent_chapters` `origin JP`. Valid entry Jepang → `422 validation_error`.

### 2. Reproduksi

```bash
curl -X POST /api/v1/whitelist -H "Authorization: Bearer $TOKEN" -d '{"title":"One Piece","source":"ikiru","origin":"JP"}'
# → 422 {"error":"validation_error","details":[{"loc":["body","origin"],"msg":"Input should be 'KR' or 'CN'"}]}
```

### 3. Solusi

```python
# dashboard/whitelist.py:30,50
origin: Optional[Literal["KR","CN","JP"]] = None
```

- Migas: `whitelist` `origin` column sudah `TEXT` tanpa check, tidak butuh migrasi.

### 4. File terkait

- `apps/backend/app/api/dashboard/whitelist.py:30,50`

### 5. Status

- Dicatat 2026-09-09 — valid, patch `Literal` menunggu approval.

---

## BUG-9 — 🟡 Medium — Default RSS filter buang `NULL` origin (bertentangan Python)

### 1. Deskripsi

`apps/backend/app/api/rss.py:111` default `if not origin_f and not exclude_origin: exclude_origin="JP"` (maksudnya sembunyikan JP). SQL `apps/backend/app/services/rss_service.py:70,84` (`exclude_notified` path) + Python fallback `rss.py` → `SELECT ... WHERE origin <> 'JP'` / `origin != 'JP'` `rss_service.py:72` `WHERE rc.origin != %s` dan `recent_chapters` `origin IS NULL` rows → di SQL `NULL <> 'JP'` = `UNKNOWN` → baris ter-filter (hilang). Python `build_filter` `apps/backend/app/services/rss_query.py:109` `if exclude_origin and o in [...]` dengan `o=(it.get("origin") or "").upper()` → `""` `not in ["JP"]` → **ditampilkan**. Jadi `NULL` origin (unknown) muncul di Python path tapi hilang di SQL path → `/rss` dan `/rss/custom` tidak konsisten.

### 2. Reproduksi

Insert `recent_chapters` dengan `origin=NULL` → `GET /api/v1/rss` (default `exclude_origin=JP`, SQL path `exclude_notified=false` → `rss_service.py:50` `neq`) → row hilang. `GET /api/v1/rss?exclude_notified=true` (SQL `rss_service.py:72`) juga hilang. Bandingkan `build_filter` langsung → row kept.

### 3. Root Cause

- Komentar `rss.py:110` `ponytail: NULL/unknown origin not excluded — "" not in ["JP"]` benar untuk Python, tapi SQL `<>` tidak handle `NULL`.
- `rss_service.py:72` comment juga `was mis-labeling CN manhua as KR` tapi tidak fix `NULL`.

### 4. Solusi

```sql
-- rss_service.py:72 (dan rss.py via builder neq)
WHERE (rc.origin <> %s OR rc.origin IS NULL)
-- atau
WHERE COALESCE(rc.origin,'') <> %s
-- atau SQL standard
WHERE rc.origin IS DISTINCT FROM %s  -- NULL-safe <>
```

Untuk builder `db_adapter.py:210` `neq` bisa tambah `OR IS NULL` atau `COALESCE`. Python sudah benar.

### 5. File terkait

- `apps/backend/app/api/rss.py:108,110`
- `apps/backend/app/services/rss_service.py:51,70,72`
- `apps/backend/app/services/rss_query.py:109`
- `apps/backend/app/db_adapter.py:210` `neq`

### 6. Status

- Dicatat 2026-09-09 — valid, solusi `IS DISTINCT FROM`/`OR IS NULL`, patch menunggu approval.

---

## BUG-10 — 🟡 Health/observability — `/health/detailed` public leak — FIXED 2026-09-09

- **Deskripsi:** `app/api/health.py:119` `GET /health/detailed` tanpa `require_monitor_auth` bocorkan `errorRate/consecutiveFailures/lastError/disabledUntil/circuit_breakers/db_pool/voratoon_covers/overall` (`health.py:134-203`) — `GET /health:17` & `POST /health/refresh-voratoon:106` sudah gated, `detailed` tertinggal.
- **Fix:** `health.py:121` `if not require_monitor_auth: 401`, `proxy.ts:32` hapus `"/api/v1/health/detailed"` dari `PUBLIC_PREFIX` (middleware 401 anon). `GET /healthz:12` tetap public liveness.
- **File:** `apps/backend/app/api/health.py:119`, `apps/frontend/proxy.ts:20`

## BUG-11 — 🟠 Queue — duplicate/race/worker crash/double dispatch — FIXED 2026-09-09

- **Deskripsi:** `enqueue_cron:39` `lrange O(n)` race, `blpop→_process` tanpa `BRPOPLPUSH` hilang saat crash, `claim autocommit True` pecah `FOR UPDATE SKIP LOCKED` (`BUG-6`), double dispatch via FCFS.
- **Fix:** `app/tasks/queue.py:12` `CRON_QUEUE_SET="beag:cron:set"` `SADD` atomic dedup `sort_keys` + `SREM` on pop + rollback, `lifecycle.py:105` `BRPOPLPUSH` → `beag:cron:processing`/`beag:tasks:processing` + `_recover_processing()` `rpoplpush`, `claim.py:84` `autocommit=False` transaksi. Test `tests/test_queue_hardening.py:32` `32 passed`.
- **File:** `apps/backend/app/tasks/queue.py`, `apps/backend/app/tasks/lifecycle.py`, `apps/backend/app/api/queue_dashboard.py:271`

## BUG-12 — 🟡 API design — raw `await request.json()` manual extraction — FIXED 2026-09-09

- **Deskripsi:** `auth.py:111`, `dispatches.py:117/201`, `whitelist.py:170/267`, `excluded_titles.py:175/221/260`, `continue_reading.py:102/222`, `settings.py:69` manual `body.get` tanpa `extra="forbid"`/`max_length` — inkonsisten dengan `WhitelistCreate:22` `extra="forbid" title≤200 cover≤2000 url≤500 description≤5000`.
- **Fix:** `Pydantic extra="forbid"` DTO → `model_validate` → `422 validation_error` → `service → DB`: `LoginRequest:13`, `FailedDispatchRetryBody:14`, `WhitelistDeleteRequest:56`, `ExcludedAdd/Delete/Bulk:22`, `ContinueReadingEntry:11/MarkReadRequest:28`, `GuildSettingsPutRequest:19`. Semua mutasi kini `DTO→service`.
- **File:** `apps/backend/app/api/auth.py`, `dispatches.py`, `dashboard/whitelist.py`, `dashboard/excluded_titles.py`, `continue_reading.py`, `settings.py`

## BUG-13 — 🟠 Technical debt — config alias `IKIRU_*`/`SECONDARY_*`/`SHINIGAMI_*` — FIXED 2026-09-09 (migration)

- **Deskripsi:** `app/config.py:36` `IKIRU_BASE_URL` vs `IKIRU_PUBLIC_URL`, `38` `SECONDARY_SOURCE_URL` vs `SHINIGAMI_API_URL`, `40` `SECONDARY_PUBLIC_BASE` vs `SHINIGAMI_PUBLIC_URL` — dua nama satu value, `Variable mana yang dipakai?`
- **Fix:** Kanonik `IKIRU_PUBLIC_URL / SHINIGAMI_API_URL / SHINIGAMI_PUBLIC_URL` (`config.py:98`), alias `IKIRU_BASE_URL/SECONDARY_*` sync + `logger.warn DEPRECATED ... → use ... (removal 2026-12-09)`, normalisasi `/` mirror. `90d` warn period lalu hapus cabang `elif OLD`.
- **File:** `apps/backend/app/config.py:98`

## BUG-14 — 🔴 P1 — CI `pytest | tail` sembunyikan failure — FIXED 2026-09-09

- **CI:** `python -m pytest tests/ -v --tb=short 2>&1 | tail -40` tanpa `set -o pipefail` → `pytest:1|tail:0` → Actions lihat `0`.
- **Fix:** `.github/workflows/ci.yml:53` `run: python -m pytest tests/ -v --tb=short` tanpa pipe.
- **File:** `.github/workflows/ci.yml:52`

## BUG-15 — 🟠 P1 — CI frontend `pnpm` vs `bun` mismatch — FIXED 2026-09-09

- **Repo:** `package.json:5` `packageManager pnpm@11.22.0` + `pnpm-lock.yaml` tapi CI `oven-sh/setup-bun@v2` + `bun install --frozen-lockfile` → lock drift.
- **Fix:** `ci.yml:21` `pnpm/action-setup@v4:11.22.0` + `actions/setup-node@v4 cache: pnpm` → `pnpm install --frozen-lockfile` + `pnpm run typecheck/lint/test/build`.
- **File:** `.github/workflows/ci.yml:16`

## BUG-16 — 🔴 P1 — Auth `?token=` lewat query string — FIXED 2026-09-09 (deprecate)

- **Deskripsi:** `utils/request_auth.py:8` `query_params.get("token")` + `utils/auth.py:53` diterima untuk `monitor`/`cron` → bocor di `access log / proxy log / history / analytics / copied URLs`.
- **Fix:** Kanonik `Authorization: Bearer` atau `ikiru_dashboard_session` cookie. `check_monitor_auth:54` & `check_cron_auth:83` tetap terima `?token=`/`?key=` tapi `logger.warn DEPRECATED ?token= → use Bearer` (removal `2026-12-09`). `require_cron_auth:15` kini cek `Authorization` header dulu, support `?key=` FastCron sebagai alias deprecated. Efektif 3 secret kanonik: `DASHBOARD_PASSWORD` (human), `CRON_SECRET` (cron), `AUTH_SECRET` (JWT); `MONITOR_AUTH_TOKEN`/`FASTCRON_API_KEY` alias.
- **File:** `apps/backend/app/utils/auth.py:42,83`, `apps/backend/app/utils/request_auth.py:15`

## BUG-17 — 🔴 P1 — Audit log dimatikan — FIXED 2026-09-09

- **Deskripsi:** `whitelist.py:159` `# Audit log disabled` untuk `ADD/DELETE/PATCH` — tidak ada forensic trail.
- **Fix:** `app/db/migrations/064_audit_log.sql:4` `audit_log(id, actor, action, resource, resource_id, ip, user_agent, timestamp, metadata)` + index `action/timestamp/resource`. `app/services/audit.py:22` `log_action()` `q INSERT … ::jsonb` fallback builder, never raise. Wiring: `whitelist.py:12` `WHITELIST_ADD/DELETE/UPDATE/NORMALIZE`, `excluded_titles.py:12` `EXCLUDED_*`, `dispatches.py:12` `DISPATCH_RETRY/RETRY_ALL`, `dispatch_mod.py:386` `DISPATCH`, `system.py:12` `CRON_TRIGGER`, `queue_dashboard.py:8` `QUEUE_RETRY/CLEAR`. Read `GET /api/v1/audit-log` `app/api/audit_log.py:8` `require_monitor_auth` `order timestamp desc`.
- **File:** `apps/backend/app/db/migrations/064_audit_log.sql`, `apps/backend/app/services/audit.py`, `apps/backend/app/routers/core.py:14`, `apps/backend/app/api/audit_log.py`

## BUG-18 — 🔴 P1 — Debug API public — FIXED 2026-09-09

- **Deskripsi:** `proxy.ts:32` `PUBLIC_PREFIX ["/api/v1/debug","/debug"]` → anon akses `POST /api/debug/login-direct` (`route.ts:9` terima `password` → forward `backendUrl()/api/v1/auth?action=login` → `backendUrl/target/status/Set-Cookie/hasSession/hasCsrf/setCookieHeaders[ikiru_dashboard_session]/bodyText` bocor) + `GET /api/debug/auth-check` (`route.ts:4` → `backendUrl/BACKEND_URL_raw/NODE_ENV/health`).
- **Fix:** `proxy.ts:32` hapus `"/api/v1/debug"` & `"/debug"` dari `PUBLIC_PREFIX` (butuh JWT), `login-direct/route.ts:14` & `auth-check/route.ts:5` `if (NODE_ENV!=="development") return 404`. Prod tidak expose `backendUrl/Set-Cookie`.
- **File:** `apps/frontend/proxy.ts:20`, `apps/frontend/app/api/debug/login-direct/route.ts:14`, `apps/frontend/app/api/debug/auth-check/route.ts:5`
