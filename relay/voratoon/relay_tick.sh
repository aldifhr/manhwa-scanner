#!/usr/bin/env bash
# Voratoon relay tick — no LLM involved.
#
# api.voratoon.com is blocked at Cloudflare's EDGE for this VPS's IP. The block
# is per-IP, not per-TLS-fingerprint: curl, curl_cffi (chrome/124/131) and
# tls-client (chrome_120/124/131, safari_16_0, firefox_120, chrome_133) all
# return the same 403 with NO cf-ray header. The catalogue therefore has to be
# fetched from an egress that is not blocked.
#
# r.jina.ai is that egress. It returns the raw JSON prefixed with a short
# "Title:/URL Source:/Markdown Content:" header, and build_updates.py already
# tolerates that wrapper — it regex-extracts the outermost {...} and requires
# "lastPage" to accept a page.
#
# This replaced an agent job that spent an LLM call per tick and broke outright
# when its configured model disappeared ("No active credentials for provider"),
# leaving the relay 4+ hours stale while voratoon silently collected zero
# chapters. Fetching three URLs is not a reasoning task.
set -uo pipefail

BE=/root/projects/manhwa-scanner/apps/backend
CACHE=/root/.hermes/cache/web
PROXY="https://r.jina.ai/"

mkdir -p "$CACHE"

# take=10 keeps each payload inside the size build_updates.py expects.
fetched=0
last_code=000
for page in 1 2 3; do
  url="https://api.voratoon.com/series?take=10&page=${page}&sort=latest&sortOrder=desc&includeMeta=true&takeChapter=4"
  out="$CACHE/api.voratoon.com-relay-p${page}.md"
  tmp="${out}.tmp"
  code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 60 "$PROXY$url" 2>/dev/null) || code=000
  last_code=$code
  # Accept only a real catalogue page. A challenge or truncated body would
  # silently poison the relay otherwise.
  if [ "$code" = "200" ] && grep -q '"lastPage"' "$tmp" 2>/dev/null; then
    mv "$tmp" "$out"
    fetched=$((fetched + 1))
  else
    rm -f "$tmp"
  fi
done

if [ "$fetched" -eq 0 ]; then
  echo "ERROR: relay fetch failed (0/3 pages via proxy, last http=$last_code)"
  exit 1
fi

cd "$BE" || { echo "ERROR: backend dir missing"; exit 1; }
out=$(.venv/bin/python relay/voratoon/build_updates.py 2>&1)
rc=$?
echo "$out"
exit $rc
