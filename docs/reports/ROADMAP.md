# Roadmap — Manhwa Scanner

> Discord bot untuk notifikasi chapter manga terbaru dari sumber Ikiru dan Shinigami.
> Dikelola di Vercel + Redis (Upstash) + QStash.

---

## Status Saat Ini

| Komponen | Status |
|---|---|
| Scraping Ikiru (HTML) | ✅ Berjalan — kadang timeout |
| Scraping Shinigami (Unified API) | ✅ Stabil |
| Discord dispatch langsung | ✅ Berjalan |
| QStash queue dispatch | ✅ Berjalan |
| Channel validation | ✅ Berjalan (cache 6 jam) |
| Source health & circuit breaker | ✅ Berjalan |
| Deduplication multi-layer | ✅ Berjalan |
| Incremental scraping | ✅ Berjalan |
| Hibernation detection | ✅ Berjalan |
| Adaptive rate limiter | ✅ Berjalan |
| Dashboard API | ✅ Berjalan |
| Slash commands | ✅ Berjalan |
| Whitelist management | ✅ Berjalan |

---

## ✅ Selesai (April 2026)

### Bug Fixes & Security
- [x] CORS bug — `"false"` tidak memblokir request, sekarang tidak set header sama sekali
- [x] Race condition Redis rate limiter — INCR + EXPIRE tidak atomic, diganti Lua script
- [x] `RateLimitError` plain object → class (stack trace preserved)
- [x] Custom Express type redefinition dihapus, pakai `import type` dari express
- [x] `req.connection.remoteAddress` deprecated → `req.socket?.remoteAddress`

### Code Quality
- [x] `globalErrorHandler` dead code dihapus dari `index.ts`
- [x] Double `isQStashEnabled()` call dihilangkan
- [x] Discord channel fallback logic — 3 copy-paste → 1 helper `sendChannelFallback`
- [x] `lint-staged` config difix supaya cover file `.ts`
- [x] `AdaptiveRateLimiter` dipindah dari `types.ts` ke `utils/adaptive-rate-limiter.ts`

### Refactor cronRuntime.ts (God File)
- [x] `cronRuntime.ts` dipecah: 1043 → 741 baris (−302 baris)
  - `lib/cron/helpers.ts` — utility functions
  - `lib/cron/validation.ts` — `loadValidatedGuilds`
  - `lib/cron/status.ts` — `readCronStatusWithHealth`
- [x] Dead code `validateChannel` + commented DEPRECATED functions dihapus
- [x] 12 unused imports dihapus

### Performance & Correctness
- [x] Double Redis load source health (−1 round-trip per cron)
- [x] Double Redis write source health (−1 write per cron)
- [x] Health thresholds konsisten — env config dipass ke orchestrator, tidak pakai function default
- [x] Lock TTL `cronRuntime.ts` 600s → 35s (cegah stuck lock jika crash)
- [x] `stopPaging` race condition di Ikiru AJAX pagination — `Promise.all` → sequential `for` loop

---

## 🔴 Prioritas Tinggi (Short-term)

### 1. Ikiru Source Stability
**Problem:** `ikiru` sering timeout (`lastError: "Page fetch timeout for page 1"`), `consecutiveFailures` naik pelan-pelan.
- [ ] Investigasi penyebab timeout — apakah rate limiting dari server, CDN, atau IP block
- [ ] Tambah fallback strategy: jika AJAX page 1 timeout, langsung coba `fetchIkiruRecentChaptersFromLatestPage`
- [ ] Rotate user-agent / headers lebih agresif jika terdeteksi block
- [ ] Pertimbangkan proxy atau request dari region berbeda

### 2. Hapus Widespread `any` (Type Safety)
**Problem:** Banyak penggunaan `as any` dan `: any` di seluruh codebase yang menyembunyikan bug potensial.
- [ ] Audit seluruh `any` — prioritaskan di `dispatch.ts`, `cronRuntime.ts`, `secondary.ts`
- [ ] Definisikan proper type untuk QStash task payload
- [ ] Type semua `onChannelError` callback di dispatch
- [ ] Replace `any[]` di `prepareDispatchQueue` dengan typed `DispatchQueueEntry`

### 3. Metadata Enrichment Sebelum Deduplication Check
**Problem:** Enrichment dilakukan untuk semua chapter whitelist, padahal sebagian besar sudah pernah di-dispatch. Buang HTTP request untuk data yang tidak akan dipakai.
- [ ] Lakukan cheap Redis dedup check (sudah ada di `prepareDispatchQueue`) **sebelum** enrichment
- [ ] Pass hasil pre-dedup ke orchestrator atau tambah pre-filter step di `cronRuntime.ts`

---

## 🟡 Prioritas Sedang (Medium-term)

### 4. Observability & Monitoring
- [ ] `timingMetrics.sourceHealthWriteMs` selalu 0 setelah refactor — hapus field ini dari `TimingMetrics` atau dokumentasikan
- [ ] Tambah alert otomatis (Discord DM ke admin) jika source degraded > N jam
- [ ] Tambah metric untuk enrichment hit rate (berapa % dari Redis cache vs HTTP fetch)
- [ ] Dashboard — tampilkan per-source scrape success rate over time

### 5. Test Coverage
- [ ] Unit test untuk `cron/helpers.ts` (terutama `buildShortCircuitStatus`, `finalizeTimingMetrics`)
- [ ] Unit test untuk `cron/validation.ts` (`loadValidatedGuilds` cached path vs full validation path)
- [ ] Integration test untuk flow scrape → dispatch (saat ini hanya test `runCronJob` top-level)
- [ ] Test untuk `stopPaging` behavior di sequential loop (baru diganti)

### 6. Rate Limiting & Throttling
- [ ] Shinigami: `detailSkippedNonPriority` sering tinggi (15-38 per run) — evaluasi apakah limit terlalu ketat
- [ ] Ikiru: Tambah per-domain rate limit yang terpisah dari global adaptive limiter
- [ ] Ekspos `DISCORD_SEND_MAX_CONCURRENT` dan `DISCORD_SEND_MIN_TIME_MS` ke `.env.example` dengan dokumentasi

### 7. Whitelist Management
- [ ] Bulk import whitelist via CSV atau paste list
- [ ] Tampilkan status per-title (aktif/hibernasi/error) di command `/status`
- [ ] Auto-suggest saat `/add` dengan judul yang mirip (fuzzy match)

---

## 🟢 Prioritas Rendah (Long-term)

### 8. Tambah Sumber Manga Baru
- [ ] Evaluasi sumber alternatif (MangaDex API, Bato.to, dll)
- [ ] Abstract scraper interface lebih kuat — saat ini `MangaProvider` sudah ada, tinggal implementasi
- [ ] Fallback otomatis ke source lain jika source utama degraded

### 9. User Subscription System
- [ ] Per-user follow (DM notifikasi) bukan hanya per-channel
- [ ] `@mention` otomatis untuk subscriber chapter tertentu
- [ ] Mute per-title per-user tanpa harus keluar dari whitelist server

### 10. Arsitektur & Infrastruktur
- [ ] Evaluasi migrasi dari polling cron ke event-driven (webhook dari source jika tersedia)
- [ ] Redis key cleanup strategy — beberapa key tidak ada TTL (risk memory leak di free tier)
- [ ] Multi-region support jika Vercel edge functions diaktifkan
- [ ] Backup & restore state Redis (whitelist, guild config)

### 11. Developer Experience
- [ ] CI/CD pipeline (GitHub Actions) — saat ini hanya ada `.github/` folder tanpa workflow
- [ ] Pre-commit type-check (`tsc --noEmit`) selain ESLint
- [ ] Seed script untuk local development (mock Redis data)
- [ ] Docker Compose untuk local dev tanpa Vercel

---

## Metrik Target

| Metrik | Saat Ini | Target |
|---|---|---|
| Cron duration | ~11-15s | < 10s |
| Source health ikiru | Sering degraded | 95%+ uptime |
| `any` count | ~80+ | < 10 |
| Test coverage | ~20% | > 60% |
| Redis reads/cron | ~8-10 | < 6 |
| Lines cronRuntime.ts | 741 | < 500 |

---

## Dependency Utama

| Package | Kegunaan |
|---|---|
| `ioredis` | Redis client |
| `@upstash/qstash` | Message queue untuk dispatch |
| `axios` | HTTP requests scraping |
| `cheerio` | HTML parsing (Ikiru) |
| `zod` | Schema validation |
| `pino` | Structured logging |
| `p-limit` | Concurrency control |
| `bottleneck` | Rate limiting Discord sends |

---

*Terakhir diupdate: April 2026*
