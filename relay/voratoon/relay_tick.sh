#!/usr/bin/env bash
# Voratoon relay tick — no LLM involved.
#
# api.voratoon.com is blocked at Cloudflare's EDGE for this VPS's IP. The block
# is per-IP, not per-TLS-fingerprint: curl, curl_cffi (chrome/124/131) and
# tls-client (chrome_120/124/131, safari_16_0, firefox_120, chrome_133) all
# return the same 403 with NO cf-ray header. The catalogue therefore has to be
# fetched from an egress that is not blocked.
#
# PRIMARY: a Cloudflare Worker the operator owns
# (voratoon-proxy.monsterdrop7.workers.dev). It runs on Cloudflare's own
# network, so its subrequest reaches voratoon without touching the blocked IP.
# It answers with the upstream JSON verbatim — no wrapper to strip — and it is
# ours, so it cannot be rate-limited or shut down by a third party.
#
# FALLBACK: r.jina.ai, kept as a second egress so a Worker outage does not
# silently stop voratoon. Jina prefixes a short "Title:/URL Source:/Markdown
# Content:" header; build_updates.py already tolerates that wrapper (it
# regex-extracts the outermost {...} and requires "lastPage" to accept a page).
#
# Either way a page is only accepted when it contains "lastPage" — a challenge
# page or a truncated body would otherwise poison the relay silently.
#
# This replaced an agent job that spent an LLM call per tick and broke outright
# when its configured model disappeared ("No active credentials for provider"),
# leaving the relay 4+ hours stale while voratoon silently collected zero
# chapters. Fetching three URLs is not a reasoning task.
set -uo pipefail

BE=/root/projects/manhwa-scanner/apps/backend
CACHE=/root/.hermes/cache/web
WORKER="${VORATOON_WORKER:-https://voratoon-proxy.monsterdrop7.workers.dev}"
JINA="https://r.jina.ai/"

mkdir -p "$CACHE"

# take=10 keeps each payload inside the size build_updates.py expects.
fetched=0
worker_ok=0
last_code=000
for page in 1 2 3; do
  url="https://api.voratoon.com/series?take=10&page=${page}&sort=latest&sortOrder=desc&includeMeta=true&takeChapter=4"
  out="$CACHE/api.voratoon.com-relay-p${page}.md"
  tmp="${out}.tmp"

  # ── primary: our Worker ──
  enc=$(printf '%s' "$url" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')
  code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 45 "${WORKER}/?url=${enc}" 2>/dev/null) || code=000
  last_code=$code
  if [ "$code" = "200" ] && grep -q '"lastPage"' "$tmp" 2>/dev/null; then
    mv "$tmp" "$out"
    fetched=$((fetched + 1))
    worker_ok=$((worker_ok + 1))
    continue
  fi

  # ── fallback: jina ──
  code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 60 "${JINA}${url}" 2>/dev/null) || code=000
  last_code=$code
  if [ "$code" = "200" ] && grep -q '"lastPage"' "$tmp" 2>/dev/null; then
    mv "$tmp" "$out"
    fetched=$((fetched + 1))
  else
    rm -f "$tmp"
  fi
done

if [ "$fetched" -eq 0 ]; then
  echo "ERROR: relay fetch failed (0/3 pages, last http=$last_code)"
  exit 1
fi

# Surface which egress carried the tick, so a Worker outage is visible in the
# cron log rather than only inferable from latency.
if [ "$worker_ok" -eq 0 ]; then
  echo "WARN: worker egress failed, all ${fetched} page(s) came from the jina fallback"
fi

cd "$BE" || { echo "ERROR: backend dir missing"; exit 1; }
out=$(.venv/bin/python relay/voratoon/build_updates.py 2>&1)
rc=$?
echo "$out"
exit $rc
