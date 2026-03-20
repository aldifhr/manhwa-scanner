# Ikiru Bot

Discord manga update bot berbasis Vercel + Upstash Redis.

Bot ini memantau update chapter dari:
- `ikiru`
- `shinigami_project`
- `shinigami_mirror`

Lalu bot akan:
- mencocokkan hasil scrape dengan whitelist per source
- menghindari notifikasi duplikat untuk judul exact sama + chapter yang sama
- mengirim embed ke channel Discord yang sudah diset per guild

## Fitur

- Slash command Discord untuk tambah, hapus, list, mark, cek manual, dan set channel
- Cron endpoint untuk scrape dan dispatch notifikasi
- Whitelist tersimpan di Redis
- Status runtime, recent chapters, raw cron logs, dan daily cron stats tersedia via endpoint API
- Source health tracking dengan cooldown saat source sering gagal
- Anti-spam notifikasi lintas source untuk `judul exact sama + chapter sama`
- Optimasi scrape supaya source yang tidak dipakai whitelist tidak ikut discrape

## Arsitektur Singkat

- [api/interactive.js](/d:/ikiru-bot/api/interactive.js)
  Endpoint Discord interactions.
- [api/cron.js](/d:/ikiru-bot/api/cron.js)
  Endpoint cron untuk scrape, match whitelist, lalu dispatch.
- [lib/cronRuntime.js](/d:/ikiru-bot/lib/cronRuntime.js)
  Runtime utama cron.
- [lib/scraper.js](/d:/ikiru-bot/lib/scraper.js)
  Entry point scraping.
- [lib/scrapers/ikiru.js](/d:/ikiru-bot/lib/scrapers/ikiru.js)
  Scraper `ikiru`.
- [lib/scrapers/secondary.js](/d:/ikiru-bot/lib/scrapers/secondary.js)
  Scraper `shinigami_project` dan `shinigami_mirror`.
- [lib/services/dispatch.js](/d:/ikiru-bot/lib/services/dispatch.js)
  Queueing, dedupe, locking, dan kirim ke Discord.
- [lib/redis.js](/d:/ikiru-bot/lib/redis.js)
  Akses Redis dan storage whitelist/channel.

## Flow Cron

1. Load whitelist, guild channels, dan source health dari Redis.
2. Skip source yang whitelist-nya kosong.
3. Scrape update dari source aktif.
4. Untuk `Ikiru`, scan `latest-update` sampai maksimal 7 page, lalu stop saat feed sudah stale.
5. Filter hasil scrape dengan whitelist.
6. Dedupe exact-title lintas source untuk chapter yang sama.
7. Kirim embed ke semua channel guild aktif.
8. Simpan status cron, recent chapters, logs, dan source health.

## Anti-Spam

Bot hanya dedupe untuk kasus:
- judul sama persis setelah normalisasi
- chapter sama

Contoh:
- `Overlord Of Sichuan Chapter 50` dari `ikiru` terkirim duluan
- `Overlord Of Sichuan Chapter 50` dari `shinigami_project` yang datang belakangan akan diskip

Kalau chapter berbeda, notifikasi tetap jalan.

## Endpoint

- `POST /api/interactive`
  Endpoint Discord interactions.
- `GET|POST /api/cron`
  Menjalankan cron. Perlu otorisasi cron.
- `GET /api/status`
  Status runtime terakhir.
- `GET /api/recent`
  Recent chapters yang terkirim.
- `GET /api/logs`
  Raw recent cron logs + daily summary stats 30 hari.
- `GET /api/whitelist`
  Whitelist aktif.

## Slash Commands

Command registration ada di [discord.js](/d:/ikiru-bot/discord.js).

Perintah utama:
- `/ping`
- `/check`
- `/add`
- `/remove`
- `/list`
- `/mark`
- `/status`
- `/setchannel`
- `/clear`
- `/resync24h`

## Environment Variables

Minimal yang perlu:

```env
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=
DISCORD_PUBLIC_KEY=
CRON_SECRET=
```

Yang umum dipakai untuk tuning:

```env
SECONDARY_SOURCE_URL=
SECONDARY_PUBLIC_BASE=
SECONDARY_DETAIL_WINDOW_HOURS=2
SECONDARY_DETAIL_MAX_MANGA=6
SECONDARY_DETAIL_THROTTLE_MS=200
SECONDARY_CHAPTER_LIST_MAX_PAGES=2

IKIRU_LATEST_MAX_PAGES=7
IKIRU_EMPTY_PAGE_BREAK_STREAK=1
IKIRU_CHAPTER_LIST_MAX_PAGES=4

SOURCE_FAIL_THRESHOLD=3
SOURCE_COOLDOWN_SECONDS=1800
CHANNEL_VALIDATION_REFRESH_SECONDS=21600
CHANNEL_VALIDATION_CACHE_SEC=21600
CHANNEL_VALIDATION_CONCURRENCY=8

STATUS_CACHE_SEC=60
RECENT_CACHE_SEC=180
LOGS_CACHE_SEC=300
WHITELIST_CACHE_SEC=300
CRON_LOG_LIST_LIMIT=300
CRON_LOG_LIST_TTL=1209600
CRON_DAILY_STATS_TTL=3888000
CRON_INFO_LOG_THROTTLE_SEC=1800
RECENT_LIST_TTL_SEC=
```

Catatan:
- `CRON_SECRET` dipakai oleh [api/cron.js](/d:/ikiru-bot/api/cron.js) untuk otorisasi request cron
- `IKIRU_LATEST_MAX_PAGES` default sekarang `7`

## Redis Keys Penting

- `whitelist:manga`
- `channels:guild-map`
- `cron:last_run`
- `cron:logs`
- `cron:stats:<yyyy-mm-dd>`
- `recent:chapters`
- `source:health:<source>`
- `chapter:<chapter-url>`
- `chapter:dedupe:<normalized-title>:<chapter-identity>`

## Local Development

Install dependency:

```bash
npm install
```

Lint:

```bash
npm run lint
```

Test:

```bash
npm test
```

Jalankan local Vercel dev:

```bash
npm run dev:vercel
```

Register slash commands:

```bash
node discord.js
```

## Deploy

Project ini ditujukan untuk Vercel. Batas function penting:

- [vercel.json](/d:/ikiru-bot/vercel.json)
  `api/cron.js` dan `api/interactive.js` diberi `maxDuration`.

Setelah deploy:
- pastikan env vars sudah lengkap
- register slash commands
- set notification channel per guild
- panggil endpoint cron dari scheduler dengan header/secret yang benar

## Testing

Test ada di folder [tests](/d:/ikiru-bot/tests).

Coverage yang sudah ada mencakup:
- dispatch dan dedupe
- cron logs
- source health
- Ikiru scraper helper
- scraper orchestration
- status cache

## Catatan Operasional

- Runtime produksi membaca whitelist dari Redis, bukan dari `whitelist.json`
- `whitelist.json` hanya berguna sebagai snapshot/manual reference
- Dedupe lintas source sengaja hanya exact-title agar tidak menimbulkan false positive
- Raw `cron:logs` sekarang hanya untuk event penting; ringkasan bulanan disimpan di `cron:stats:<yyyy-mm-dd>` agar Redis tidak bengkak
- Optimasi CPU utama saat ini datang dari source gating dan pembatasan scope scrape, bukan dari fuzzy matching
