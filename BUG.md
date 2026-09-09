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
| Komponen | Kode | Perilaku |
|---|---|---|
| **Default insecure** | `config.py:58` | Hanya `DASHBOARD_PASSWORD` yang default non-kosong (`"manhwascan"`), 5 secret lain default `""` (`CRON_SECRET:53`, `MONITOR_AUTH_TOKEN:56`, `AUTH_SECRET:62`, `DATABASE_URL:22`, `DISCORD_BOT_TOKEN:10`). |
| **Boot guard bolong** | `config.py:138` `_validate_settings()` | Cek 5 secret di atas, tapi tidak cek `DASHBOARD_PASSWORD`. Karena default `truthy`, `if not s.DASHBOARD_PASSWORD` tidak pernah trigger walau password masih bawaan repo. |
| **Auth fallback** | `auth.py:90` `candidates = [DASHBOARD_PASSWORD, MONITOR_AUTH_TOKEN]` + `apps/backend/app/utils/auth.py:14` `_dashboard_passwords()` | Kalau `DASHBOARD_PASSWORD` default, `MONITOR_AUTH_TOKEN` yang sudah di-guard tetap bisa jadi alias, tapi `"manhwascan"` tetap valid sebagai password pertama. |
| **Docs** | `apps/backend/.env.example:1` | Tidak mendokumentasikan `DASHBOARD_PASSWORD` sama sekali, makin mudah ke-skip. |
| **Test** | `apps/backend/tests/test_utils_auth.py:25,33...` | Test mock `DASHBOARD_PASSWORD="manhwascan"` — kalau default diubah ke `""`, test perlu update. |

### 4. Dampak
* **Confidentiality/Integrity full admin** — siapa pun yang baca repo bisa login `admin` di `https://scanner.aldifhr.fun` / `komik.aldifhr.fun` kalau env lupa set.
* **Silent failure** — boot guard yang dimaksudkan untuk cegah `auth disabled because .env not loaded` `config.py:142` justru tidak menangkap kasus ini.

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
* Tambah `DASHBOARD_PASSWORD=change-me` ke `apps/backend/.env.example` dengan komentar `MUST be set in production`.
* Update `tests/test_utils_auth.py` mock tetap `"manhwascan"` untuk test, tapi boot guard test baru untuk `DASHBOARD_PASSWORD` missing.

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
* `apps/backend/app/config.py:58,96,138,152,170`
* `apps/backend/app/api/auth.py:3,90,95`
* `apps/backend/app/utils/auth.py:14`
* `apps/backend/.env.example:1`
* `apps/backend/tests/test_utils_auth.py:25`

### 8. Status
* Dicatat 2026-09-09 — **tidak di-patch** sesuai instruksi, hanya dokumentasi. Patch menunggu approval untuk ubah `config.py:58,152`.

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
   * `update` tiap `120s` `apps/backend/app/tasks/scheduler.py:59` → `204×120s ≈ 6.8h`
   * `rss-fetch:ikiru/shinigami/voratoon` tiap `600s` `scheduler.py:63` → `126/3=42 batch ×600s = 7h`

## 3. Root Cause — FIFO tanpa consumer

| Komponen | Kode | Perilaku |
|---|---|---|
| **Enqueue** | `apps/backend/app/api/system.py:210` → `enqueue_cron()` `apps/backend/app/tasks/queue.py:39` `rpush(CRON_QUEUE_KEY, json)` | Tiap `POST /api/cron?action=update` (FastCron / manual / `scheduler.py:59` ) langsung `rpush` ke tail. Tidak ada dedup — `update` yang sama bisa `rpush` 204×. |
| **Queue** | `apps/backend/app/tasks/queue.py:12` `CRON_QUEUE_KEY="beag:cron"` `Redis LIST` | FIFO `rpush` (tail) + `blpop` (head). Tidak ada TTL, tidak ada `maxlen`. |
| **Dequeue** | `apps/backend/app/tasks/lifecycle.py:110` `blpop(CRON_QUEUE_KEY,5)` → `run_cron_inline()` | Hanya dijalankan kalau `ROLE=cron` `apps/backend/app/main.py:28-31` (`threading.Thread(run_cron_worker)` + `start_cron_scheduler`). `ROLE=api` (default PM2) hanya `start_worker()` untuk `QUEUE_KEY`, tidak pernah `blpop` `beag:cron`. |
| **Inspect** | `apps/backend/app/api/queue_dashboard.py:24` `lrange 0 -1`, `apps/frontend/app/cron/page.tsx:80` | Hanya read, tidak pop. Jadi kalau worker mati 7 jam, queue = 358 dan `isLoading` `page.tsx:38` terus menampilkan jumlah naik. |
| **Guard** | `apps/backend/app/tasks/scheduler.py:107` `if qlen>50 log.error` | Log saja, tetap `enqueue`. |

Verifikasi: `main.py:28` `_role = os.environ.get("ROLE")` → `pm2 list` di host hanya `api`, tidak ada `cron`. `redis-cli LLEN beag:cron` → 358, `LRANGE beag:cron 0 5` → duplikat `update` berurutan.

## 4. Dampak
* Memory Redis tumbuh tanpa batas; `update` duplikat membuang `run_pipeline(action=update)` 204× berurutan padahal cukup 1.
* `rss-fetch` tiap source menumpuk → `is_excluded`/`whitelist` tidak ter-refresh tepat waktu.
* `/cron` (protected) terlihat “menggila” 300+ jobs.

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
* `DELETE /api/v1/queue/cron` `queue_dashboard.py` → `r.delete(CRON_QUEUE_KEY)` (mirip `clear_dlq` `queue_dashboard.py:269`)
* Tombol **Clear 358 jobs** di `apps/frontend/app/cron/page.tsx:60` + auto-refresh 10s sudah ada.

### 5.6 Verifikasi
* `npm --prefix apps/frontend run build` OK
* `redis-cli LLEN beag:cron` → 0 setelah `DEL`, lalu `POST /api/cron?action=update` → `LLEN` 1, `pm2 logs cron-worker` → `cron pipeline done action=update` dan `LLEN` kembali 0 (FIFO benar).
* `GET /api/v1/queue/cron` → `{"total":0,"jobs":[]}`

## 6. File terkait
* BE: `apps/backend/app/tasks/queue.py:12,31,39`, `apps/backend/app/tasks/lifecycle.py:105,110`, `apps/backend/app/tasks/scheduler.py:59,63,107`, `apps/backend/app/api/system.py:186,210`, `apps/backend/app/api/queue_dashboard.py:14,24`, `apps/backend/app/main.py:28`
* FE: `apps/frontend/app/cron/page.tsx:10,32,60`, `apps/frontend/app/api/cron/route.ts:92`
* Env: `CRON_SECRET`, `ROLE`, `REDIS_URL`

## 7. Status
* BUG dicatat 2026-09-09
* Solusi 5.1–5.3 siap di-push; 5.5 butuh persetujuan untuk ubah `queue.py` + `queue_dashboard.py` + `cron/page.tsx`.
