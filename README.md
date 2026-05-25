# Manhwa Scanner

A Discord bot for manga/manhwa update notifications. Scrape updates from Indonesian manga sources and send notifications to subscribed Discord channels.

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM)
- **Framework**: Express.js (dev) / Vercel Functions (production)
- **Storage**: Upstash Redis
- **Discord**: Discord Interactions API

## Features

- Slash commands for manga subscription management
- Automatic scraping from multiple manga sources (Ikiru, Shinigami)
- Discord channel notifications for new chapters
- Rate limiting and retry mechanisms
- Health monitoring and observability
- Dashboard with real-time stats
- Source health tracking with circuit breaker
- Adaptive rate limiting

## Quick Start

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create new application
3. Go to Bot → Reset Token → Copy token
4. Enable Message Content Intent in Bot → Privileged Gateway Intents
5. Go to OAuth2 → URL Generator:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Manage Channels`, `Embed Links`
6. Copy generated URL and invite bot to server

### 2. Set Up Redis (Upstash)

1. Go to [Upstash](https://upstash.com)
2. Create new Redis database
3. Copy REST URL and REST Token

### 3. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Discord (required)
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=

# Redis (required)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Security (required)
DASHBOARD_PASSWORD=      # Password for dashboard access
DASHBOARD_SESSION_SECRET=  # Generate random string
CRON_SECRET=             # Generate random string

# Optional
DISCORD_OWNER_ID=        # Your Discord user ID for owner commands
ALLOW_DASHBOARD_CRON=true
```

### 4. Run Locally

```bash
npm install
npm run dev
```

- Dashboard: http://localhost:3000
- Status page: http://localhost:3000/status/

### 5. Deploy to Vercel

```bash
npm install -g vercel
vercel deploy --prod
```

## Project Structure

```
ikiru-bot/
├── api/                    # Vercel API routes
├── docs/                   # Documentation (architecture & audit reports)
├── lib/                    # Core business logic
│   ├── auth/              # Authentication modules
│   ├── commands/          # Discord slash commands
│   ├── config/            # System configuration & environment values
│   ├── cron/              # Cron job modules & execution
│   ├── discord/           # Discord API utilities
│   ├── providers/         # Manga scrapers providers
│   ├── scrapers/          # Scraper engines (Ikiru, Shinigami)
│   ├── services/          # Whitelist, storage, tracker & dispatch services
│   ├── types/             # TypeScript types
│   └── utils/             # Helper utilities
├── public/                 # Static assets for dashboard & status page
├── scripts/                # Utility & admin CLI scripts
└── README.md               # This file
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_PUBLIC_KEY` | Discord application public key |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_APPLICATION_ID` | Discord application ID |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |

### Security

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHBOARD_PASSWORD` | Password for dashboard access | - |
| `DASHBOARD_SESSION_SECRET` | Random string for session signing | - |
| `CRON_SECRET` | Secret for cron API authorization | - |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_OWNER_ID` | Your Discord user ID | - |
| `ALLOW_DASHBOARD_CRON` | Allow manual cron from dashboard | `false` |
| `SESSION_TTL_SECONDS` | Session duration (seconds) | 43200 (12h) |
| `CHAPTER_TTL_SECONDS` | Chapter cache duration | 604800 (7 days) |

## Commands

### Discord Slash Commands

| Command | Description |
|---------|-------------|
| `/add url <link>` | Add a manga to the whitelist from a URL (supports Ikiru and Shinigami) |
| `/remove <query>` | Remove a manga/source from the whitelist by title, URL, or list index |
| `/setchannel <channel>` | Set the Discord channel for update notifications |
| `/follow list [page]` | View the list of mangas you are personally following |
| `/follow unfollow <title>` | Unfollow a manga to stop receiving personal mentions |
| `/list [page] [search]` | View the full list of whitelisted mangas (allows searching) |
| `/status` | View the current whitelist status, last checks, and provider health |
| `/permission <add/remove/list>` | Manage user permissions for adding/removing mangas |
| `/sync` | Force a manual sync to check for updates (Admin only) |

### Dashboard

| Action | URL | Method |
|--------|-----|--------|
| Dashboard | `/` | GET (password protected) |
| Status | `/status/` | GET |
| Health | `/api/health-status` | GET |
| Whitelist | `/api/whitelist` | GET/POST/DELETE/PATCH |
| Cron | `/api/cron` | POST |
| Admin Actions | `/api/admin-actions` | POST |

## API Endpoints

### Public Endpoints

| Endpoint | Description |
|---------|-------------|
| `/api/health-status` | Service health status |
| `/api/incidents` | Incident logs |
| `/api/interactive` | Discord slash interaction handler |

### Protected Endpoints (Requires `CRON_SECRET` or session cookie)

| Endpoint | Description | Auth |
|----------|-------------|------|
| `/api/dashboard-snapshot` | Complete dashboard stats and snapshot | Bearer `CRON_SECRET` or `DASHBOARD_PASSWORD` |
| `/api/whitelist` | GET/POST/DELETE/PATCH whitelist management | Bearer token |
| `/api/cron` | Trigger sync/scan | Bearer token |
| `/api/cron-task` | Background cron runner task | Bearer token |
| `/api/history` | Dispatch/notification history | Bearer token |
| `/api/admin-actions` | Admin operations (clear whitelist/caches) | Bearer token |
| `/api/qstash-worker` | Upstash QStash worker endpoint | Bearer token |

### Using API

```bash
# With CRON_SECRET
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-app.vercel.app/api/dashboard-snapshot

# With DASHBOARD_PASSWORD  
curl -H "Authorization: Bearer YOUR_PASSWORD" https://your-app.vercel.app/api/dashboard-snapshot
```

## Development

```bash
npm run dev          # Start local dev server with tsx watch
npm run dev:vercel  # Start with Vercel dev server locally
npm run lint        # Run ESLint check
npm run type-check  # Run TypeScript type check
```

## Production

```bash
npm run check        # Run ESLint linting and type-checking
vercel deploy        # Deploy to Vercel
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `dev` | Start development server |
| `dev:vercel` | Start with Vercel dev server locally |
| `check` | Run lint and type check |
| `lint` | Run ESLint check |
| `lint:fix` | Fix automatically fixable ESLint issues |
| `type-check` | TypeScript type checking (no emit) |
| `track:fresh24h` | Track freshness of whitelisted mangas over 24 hours |
| `cleanup:health` | Clean up old health monitoring metrics from database |
| `test:hexpire` | Test Redis hash field expiry operations |
| `test:daily` | Test daily stats calculation |

## Troubleshooting

### Bot not responding

1. Check Discord developer portal → Application → Bot → Public Key is set in env
2. Verify Interactions Endpoint URL is set (for Vercel: `https://<app>.vercel.app/api/interactive`)
3. Check bot has correct permissions in server

### Dashboard not loading

1. Check `DASHBOARD_PASSWORD` is set
2. Check `DASHBOARD_SESSION_SECRET` is set (minimum 32 characters)
3. Clear browser localStorage and try again

### No chapters being sent

1. Check source URLs in whitelist are valid
2. Check Discord channel ID is correct format (18 digits)
3. Check bot has permission to send messages in channel
4. Check `/api/cron` returns data

### Redis errors

1. Verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are correct
2. Check Upstash console for rate limits
3. Verify Redis database is active

### Health check failures

1. Source may be temporarily down
2. Check circuit breaker status in dashboard
3. Circuit breaker auto-resets after cooldown period

## License

ISC