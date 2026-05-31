# Error & Optimization Log

## P0 — Langsung pengaruh ke Discord 3 detik window

### 1. Permission check jalan setelah provider init (add.ts:290 vs 302)
`initializeAllProviders()` jalan duluan sebelum `isAddAllowedUser()`. User unauthorized nunggu 8+ detik provider init baru ditolak.
**Fix:** Swap urutan — cek permission dulu.

### 2. Redis client dibuat di module load (api/interactive.ts:4)
`import { redis } from "../lib/redis.js"` — `createRedisClient()` jalan pas import, bukan pas handler. Tiap cold start bayar init HTTP ke Upstash sebelum request diproses.
**Fix:** Lazy getter instead of top-level export.

### 3. 6-8 Redis round-trip per /add (add.ts + whitelist.ts)
- `SMEMBERS whitelist:allowed_users` (permission)
- `SET NX` lock (1-3 RTT dengan retry loop)
- `HSET` + `addHexpireToPipeline` (addHexpireToPipeline DISABLED)
- `GET` whitelist data
- `SET` + `DEL` for persist + invalidate cache
**Fix:** Pipeline permission check + whitelist load; ganti lock pake Lua script.

### 4. Follow toggle zero cache (notifications.ts:17-49)
`getUserNotifyMode()`, `isUserFollowing()`, `getMangaSubscribers()` — semua langsung query Supabase tanpa Redis cache. Tiap tap button follow bayar DB round-trip.
**Fix:** Add Redis caching layer, reuse `notifications-batch.ts` pattern.

---

## P1 — Potensi bug / silent error

### 5. Nesting bug catch blok (remove.ts:136)
Catch di line 136 ada di dalem try blok line 57 karena brace placement salah. Error dari `editInteractionResponse` di line 84 bisa lepas sebagai uncaught promise rejection ke waitUntil.
**Fix:** Restructure try/catch nesting.

### 6. Enrichment promise rejection silent (add.ts:183-185)
`waitUntil(result.enrichmentPromise)` — kalo enrichmentPromise reject, error ga di-log sama sekali.
**Fix:** Add `.catch()` before `waitUntil`.

### 7. JSON parse error silent (add.ts:311-317)
`catch (e) { // ignore parse error }` — parse error Discord option JSON ditelan tanpa log.
**Fix:** Minimal warn log.

### 8. notifications.ts .then() tanpa catch (notifications.ts:60,72)
`supabase.rpc("increment_popularity").then(...)` — no `.catch()`. Gagal RPC silent.
**Fix:** Add `.catch()`.

---

## P2 — Dead weight & cleanup

### 9. ~250KB kode mati
File/services ga dipake production code:
- `lib/services/batch-integration.ts`
- `lib/services/batch-scraper.ts`
- `lib/services/chapter-tracker.ts`
- `lib/services/priority-queue.ts`
- `lib/services/url-normalizer.ts`
- `lib/services/whitelist-cache.ts`
- `lib/services/deduplication.ts` (beda sama dispatch/deduplication.ts)
- `lib/services/dispatch-history.ts` (beda sama dispatch/history.ts)
- `lib/utils/safe-cache.ts`
- `lib/utils/parallel-processor.ts`
- `lib/http-optimized.ts`

### 10. lodash-es overkill
Cuma dipake `chunk` + `compact`. Bisa ganti 4 baris native.
~70KB tree-shaken bisa di-cut.

### 11. Dua HTTP client
`lib/httpClient.ts` (dipakai) vs `lib/http-optimized.ts` (mati). Duplicate logic.

### 12. lru-cache dependency mati
Cuma dipake `safe-cache.ts` yang juga mati. Bisa hapus dependency + file.

### 13. compression dependency ga perlu di serverless
Cuma dipake `index.ts` (dev server). Vercel handle compression di edge.

### 14. Unused exports
- `lib/config.ts`: `STATUS_CACHE_SEC`, `QSTASH_*` vars, `LOGS_CACHE_SEC`, `RECENT_CACHE_SEC`, `HEALTH_CACHE_TTL_MS`, `INCIDENT_CACHE_TTL`, `DISCORD_EMBED_*_LIMIT`
- `lib/errors.ts`: `ExternalError` class (50-76)
- `lib/permissions.ts`: `ensureAddAllowedResponse()` (83-92)
- `lib/redis.ts`: `dedupedRequest()` (256-281)
- `lib/services/notifications.ts`: `NOTIFY_MODES` constant, `muteManga()`, `unmuteManga()`
- `lib/utils.ts`: `retryAsync()`, `isApproachingTimeout()`

---

## P3 — Cold start & bundle

### 15. express import di api/*.ts cuma buat type
Banyak file import `{ Request, Response } from "express"` tapi cuma buat type annotation.
**Fix:** `import type { Request, Response } from "express"`.

### 16. zod import di interactive.ts cuma buat type
`import { z } from "zod"` di `api/interactive.ts` line 11 — cuma buat `z.infer<typeof discordInteractionSchema>`.
**Fix:** `import type { z } from "zod"`.

### 17. pino logger berat
Pino ~30KB + dependency chain. Bisa ganti pino-lite buat edge runtime.
