#!/bin/bash
# Health-check: hit /health every 60s, alert Telegram on 3 consecutive failures
# Runs as a PM2 service (auto-restart, logs, no cron dependency)

HEALTH_URL="http://127.0.0.1:3000/health"
INTERVAL=60
RETRY=3

# Read from .env (same dir as ecosystem)
ENV_FILE="$(dirname "$0")/../apps/backend/.env"
[ -f "$ENV_FILE" ] && export $(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_ALERT_CHAT_ID)=' "$ENV_FILE" | xargs)

if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_ALERT_CHAT_ID" ]; then
  echo "[health-check] TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID not set — alert disabled"
fi

alert() {
  [ -z "$TELEGRAM_BOT_TOKEN" ] && return
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TELEGRAM_ALERT_CHAT_ID" \
    -d text="$1" >/dev/null 2>&1
}

echo "[health-check] starting (url=$HEALTH_URL, interval=${INTERVAL}s)"
while true; do
  ok=0
  for i in $(seq 1 $RETRY); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null)
    if [ "$code" = "200" ]; then
      ok=1
      break
    fi
    [ "$i" -lt "$RETRY" ] && sleep 5
  done
  if [ "$ok" -eq 0 ]; then
    echo "[health-check] FAIL after ${RETRY} retries — alerting"
    alert "⚠️ manhwa-api DOWN — /health returned non-200 after ${RETRY} retries ($(date '+%Y-%m-%d %H:%M:%S %Z'))"
  fi
  sleep "$INTERVAL"
done
