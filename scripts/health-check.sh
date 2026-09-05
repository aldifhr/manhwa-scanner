#!/bin/bash
# Health-check: hit /health every 60s, log failures locally
# Runs as a PM2 service (auto-restart, logs, no external dependencies)

HEALTH_URL="http://127.0.0.1:3000/health"
INTERVAL=60
RETRY=3

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
    echo "[health-check] FAIL after ${RETRY} retries — $(date '+%Y-%m-%d %H:%M:%S %Z')"
  fi
  sleep "$INTERVAL"
done
