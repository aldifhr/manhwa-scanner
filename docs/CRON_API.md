# Enhanced Cron API

## Overview

API cron yang lebih aman dengan fitur audit logging, rate limiting, dan dry-run mode.

## Endpoint

```
GET/POST /api/cron?action=<action>&<params>
```

## Authentication

Bearer token auth dengan `CRON_SECRET` atau dashboard session (jika `ALLOW_DASHBOARD_CRON=true`).

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-bot.vercel.app/api/cron?action=status"
```

## Security Features

### 1. IP Allowlist (Optional)

Set environment variable:
```env
CRON_ALLOWED_IPS=1.2.3.4,5.6.7.8
```

### 2. Rate Limiting

- Maximum 144 runs per day (1 per 10 minutes average)
- Automatic tracking with Redis
- Returns `429` if exceeded

### 3. Audit Logging

Semua request dicatat dengan:
- Timestamp
- IP address
- Action performed
- Result (success/failure/blocked)
- Correlation ID

Access audit log via `action=status`.

## Actions

### 1. Status Check

```bash
GET /api/cron?action=status
```

Response:
```json
{
  "ok": true,
  "data": {
    "lastRun": { ... },
    "dailyRunsUsed": 45,
    "dailyRunsRemaining": 99,
    "dailyRunsMax": 144,
    "lockActive": false,
    "lockExpiresIn": 0,
    "timestamp": "2026-04-19T20:45:00.000Z",
    "recentActivity": [ ...audit log entries... ]
  }
}
```

### 2. Run Cron (Normal Mode)

```bash
POST /api/cron?action=update&mode=normal
```

### 3. Dry Run (Test Mode)

Tidak mengirim notifikasi, hanya test scraping:

```bash
POST /api/cron?action=update&mode=normal&dryrun=true
```

Response akan memiliki `_meta.dryRun: true`.

### 4. Force Full Refresh

```bash
POST /api/cron?action=update&mode=full
```

### 5. Fast Mode (Limited Secondary)

```bash
POST /api/cron?action=update&mode=fast&fastLimit=4
```

### 6. Force Unlock

Jika cron stuck (lock tidak release):

```bash
POST /api/cron?action=update&forceUnlock=1
```

### 7. Health Check

```bash
GET /api/cron?action=health
```

### 8. Dead Links

```bash
GET /api/cron?action=links
```

## Response Format

Semua response mengandung `_meta`:

```json
{
  "ok": true,
  "sent": 5,
  "skipped": 10,
  "failed": 0,
  ...
  "_meta": {
    "correlationId": "abc123",
    "dryRun": false,
    "dailyRunsRemaining": 99,
    "mode": "normal",
    "timestamp": "2026-04-19T20:45:00.000Z"
  }
}
```

## Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `UNAUTHORIZED` | 401 | Invalid or missing auth token |
| `IP_NOT_ALLOWED` | 403 | IP not in allowlist |
| `INVALID_QUERY` | 400 | Invalid query parameters |
| `INVALID_ACTION` | 400 | Unknown action |
| `CRON_LOCKED` | 409 | Cron already running |
| `DAILY_LIMIT_EXCEEDED` | 429 | Max 144 runs/day exceeded |
| `CRON_FAILED` | 500 | Internal error |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CRON_SECRET` | Bearer token untuk auth | "" |
| `CRON_ALLOWED_IPS` | Comma-separated IP allowlist | "" (disabled) |
| `CRON_MAX_DAILY_RUNS` | Max runs per day | 144 |
| `ALLOW_DASHBOARD_CRON` | Allow dashboard session auth | false |

## Metrics

Cron events otomatis record metrics:
- `cron_request_count` - Request count by mode
- `cron_duration_ms` - Execution duration
- `cron_chapters_sent` - Chapters sent
- `cron_chapters_failed` - Chapters failed

Access via `/api/metrics` endpoint.

## Example Scripts

### Daily Cron (Vercel Cron)

```json
{
  "crons": [
    {
      "path": "/api/cron?action=update&mode=normal",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

### Manual Trigger with cURL

```bash
#!/bin/bash
set -e

CRON_SECRET="your-secret-here"
ENDPOINT="https://your-bot.vercel.app/api/cron"

echo "Checking status..."
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "$ENDPOINT?action=status" | jq .

echo "Running dry-run..."
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "$ENDPOINT?action=update&mode=normal&dryrun=true" | jq .

echo "Running actual cron..."
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "$ENDPOINT?action=update&mode=normal" | jq .
```

### Health Monitoring

```bash
#!/bin/bash

HEALTH=$(curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "$ENDPOINT?action=health")

BROKEN=$(echo $HEALTH | jq '.data.count')

if [ "$BROKEN" -gt 0 ]; then
  echo "WARNING: $BROKEN broken links detected!"
  echo $HEALTH | jq '.data.brokenLinks'
fi
```
