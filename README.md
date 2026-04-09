# ikiru-bot

Discord bot untuk notifikasi update manga berbasis Discord Interactions + Vercel serverless.

## Stack Aktual

- Runtime: Node.js (ESM), Vercel Functions
- Discord: `discord-interactions` (bukan `discord.js`)
- Storage/Cache: Upstash Redis
- Scraping: scraper internal (`lib/scrapers/*`)
- Dashboard: static HTML/CSS/JS di `public/`
- Testing: `node --test` (`tests/*.test.js`)

## Struktur Utama

- `api/`: endpoint serverless (`interactive`, `cron`, `history`, `status`, dll)
- `lib/`: core logic (commands, services, redis, discord wrapper, auth, rate limiter)
- `public/`: dashboard frontend
- `scripts/sync-commands.js`: registrasi slash command ke Discord
- `tests/`: unit + integration tests

## Setup Lokal

```bash
npm install
cp .env.example .env
```

Env minimal yang umum dipakai:
- `DISCORD_BOT_TOKEN` (atau `DISCORD_TOKEN`)
- `DISCORD_APPLICATION_ID` (atau `DISCORD_APP_ID`)
- `DISCORD_PUBLIC_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `CRON_SECRET` / kredensial auth dashboard sesuai kebutuhan deployment

## Menjalankan

```bash
# Dev server lokal
npm run dev

# Vercel local runtime
npm run dev:vercel

# Sinkronisasi slash commands ke Discord
node scripts/sync-commands.js

# Quality gate
npm run lint
npm test
npm run check
```

## Slash Commands (Aktual)

Sumber kebenaran: `scripts/sync-commands.js`

- `/status`
- `/add query:<judul|url>`
- `/remove query:<judul|url|nomor>`
- `/setchannel channel:<#channel>`
- `/follow list [page:<n>]`
- `/follow unfollow title:<judul>`

## Catatan

- Jangan commit `.env` atau token lokal (`.vercel/.env.preview.local`).
- Setelah ubah definisi command, jalankan ulang `node scripts/sync-commands.js`.
