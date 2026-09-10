# Deployment — manhwa-scanner

> Production deployment via PM2 + Caddy. Frontend on Vercel. For backend-specific deploy notes, see [apps/backend/README.md](../apps/backend/README.md).

## Production processes (PM2)

Two backend processes defined in `ecosystem.config.js`:

| Process | ROLE | Port | Memory | Purpose |
|---------|------|------|--------|---------|
| `manhwa-api` | `api` | 3000 | 512M | HTTP API (FastAPI) |
| `manhwa-cron` | `cron` | 3001 | 768M | Cron scheduler + worker |
| `health-check` | — | — | 32M | Health poll script |

```bash
# Start
pm2 start ecosystem.config.js

# Status
pm2 list
pm2 logs manhwa-api
pm2 logs manhwa-cron

# Restart
pm2 restart manhwa-api
pm2 restart manhwa-cron
```

**Critical:** `manhwa-cron` must be running for the cron queue to drain. Without it, the Redis `beag:cron` list grows unbounded.

## Caddy reverse proxy

`/etc/caddy/Caddyfile`:

```
scanner.aldifhr.fun {
    reverse_proxy /api/v1/interactive localhost:3000
    reverse_proxy /api/v1/reader/cover-img localhost:3000
    reverse_proxy /api/v1/reader/proxy localhost:3000
    reverse_proxy localhost:3000 {
        transport http {
            read_timeout 900s
            write_timeout 900s
        }
    }
}

komik.aldifhr.fun {
    reverse_proxy /api/* localhost:3000
    reverse_proxy localhost:5175 {
        transport http {
            read_timeout 900s
            write_timeout 900s
        }
    }
}
```

```bash
# Reload Caddy after changes
sudo systemctl reload caddy
```

## Automated deploy

- `/root/deploy.sh` — polling `*/5m` for GitHub changes (legacy, currently no-op)
- `/root/deploy-webhook.py` — systemd listener on port 9876, HMAC-SHA256 verified

## Frontend (Vercel)

`vercel.json`:

```json
{
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm --filter manhwa-reader build",
  "framework": "nextjs"
}
```

Frontend deploys automatically on push to `main`. Backend is NOT on Vercel — it runs on the VPS via PM2.

## Health checks

- `GET /healthz` — liveness probe (`{"status":"ok"}`), public
- `GET /api/health` — per-source status, last scrape, error rate (monitor auth)
- `GET /api/v1/queue/status` — queue depth (should be < 10)

## Environment secrets

All secrets are set via PM2 `env` in `ecosystem.config.js` or system environment. Never commit `.env` files.

| Secret | Used by |
|--------|---------|
| `DASHBOARD_PASSWORD` | Admin login |
| `AUTH_SECRET` | JWT signing |
| `CRON_SECRET` | Cron trigger auth |
| `MONITOR_AUTH_TOKEN` | Monitor/health auth |
| `DISCORD_BOT_TOKEN` | Discord dispatch |
| `DATABASE_URL` | PostgreSQL |
| `REDIS_URL` | Redis queue |
