# ikiru-bot 🤖

Discord bot for manga update notifications. Tracks releases from multiple manga sources, notifies subscribed users via Discord slash commands and embed messages.

## Tech Stack

- **Runtime**: Vercel (serverless)
- **Bot**: discord.js v14
- **Cache/Queue**: Upstash Redis
- **Scraping**: Custom scraper with selector-based selectors
- **Dashboard**: Public web dashboard (HTML + vanilla JS)
- **Testing**: Vitest

## Features

- **Slash Commands** — `/manga add`, `/manga list`, `/manga remove`, `/manga check`
- **Auto-updates** — Cron-based scraping every 30s, notifies Discord on new chapter
- **Multi-source** — Selector-based scraper supporting different manga sites
- **Whitelist** — Admin-managed whitelist of allowed manga/sources
- **Dashboard** — Public HTML dashboard showing tracked manga + last update times
- **Auth** — Admin-only endpoints protected by `AUTH_TOKEN`
- **Rate Limiting** — Upstash Redis for per-user/request rate limiting
- **Health Checks** — Cron runtime + source health monitoring

## Project Structure

```
ikiru-bot/
├── api/                    # Vercel serverless API routes
│   ├── cron.js            # Triggered by Vercel Cron (inc. health check)
│   ├── history.js         # API for recent updates and logs
│   ├── interactive.js     # Discord interaction handler
│   ├── status.js          # Bot/source health status
│   └── whitelist.js       # Whitelist management
├── lib/                   # Core business logic
│   ├── auth.js            # Admin authentication
│   ├── cacheKeys.js       # Redis key schemas
│   ├── commands/          # Discord slash commands
│   ├── config.js         # Unified Configuration
│   ├── cookie.js          # Cookie management for scraping
│   ├── cronLogs.js       # Cron execution logging
│   ├── cronRuntime.js    # Cron health tracking
│   ├── discord.js         # Discord API client wrapper
│   ├── domain.js         # Unified Domain Models
│   ├── httpClient.js     # HTTP client with retry
│   ├── logger.js         # Structured logging (inc. API logging)
│   ├── monitorStore.js   # Manga monitor state
│   ├── permissions.js     # Admin permission checks
│   ├── redis.js          # Upstash Redis client
│   ├── scraper.js        # Main scraper
│   ├── scrapers/         # Source-specific scrapers
│   ├── services/         # Business services
│   └── statusCache.js    # Health status cache
├── public/               # Dashboard (no build step)
│   ├── dashboard-render.js
│   ├── dashboard-utils.js
│   ├── index.html
│   ├── script.js
│   └── styles.css
├── tests/                # Vitest unit + integration tests
├── whitelist.json        # Default whitelist
├── vercel.json           # Vercel config (cron: every 30s)
├── scripts/              # Utility scripts
│   └── sync-commands.js  # Discord bot command registration
├── whitelist.json        # Default whitelist
├── vercel.json           # Vercel config (cron: every 30s)
├── flush.js             # Manual cache flush
└── package.json
```

## Setup

```bash
npm install

# Environment variables
cp .env.example .env
# Fill in:
#   DISCORD_BOT_TOKEN
#   REDIS_REST_URL
#   REDIS_REST_TOKEN
#   AUTH_TOKEN
#   ADMIN_IDS (comma-separated Discord user IDs)
#   WHITELIST_FILE (path to whitelist.json)

# Run locally (requires ngrok for Discord webhooks)
node scripts/sync-commands.js

# Run tests
npm test
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token (from Discord Developer Portal) |
| `REDIS_REST_URL` | Upstash Redis REST URL |
| `REDIS_REST_TOKEN` | Upstash Redis REST token |
| `AUTH_TOKEN` | Admin auth token for dashboard |
| `ADMIN_IDS` | Comma-separated Discord user IDs with admin access |
| `WHITELIST_FILE` | Path to `whitelist.json` |
| `BASE_URL` | Public URL (for Vercel deployment) |

## Discord Slash Commands

| Command | Description |
|---------|-------------|
| `/manga add <url>` | Subscribe to a manga |
| `/manga list` | List all subscribed manga |
| `/manga remove <url>` | Unsubscribe from a manga |
| `/manga check <url>` | Force check for new chapters |

Admin-only: `/manga flush`, `/manga reload`

## Dashboard

Public dashboard at `BASE_URL` shows:
- All tracked manga
- Last checked time per manga
- Source health status
- Recent update logs

Admin login at `BASE_URL/admin` (requires `AUTH_TOKEN`).

## Deployment

```bash
# Vercel (recommended)
vercel --prod

# Discord bot must be online 24/7
# Vercel serverless functions handle API + cron
```

## License

MIT
