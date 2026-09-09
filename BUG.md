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
