# Sources — manhwa-scanner

> Source details, fallback chains, and type mapping. For scraper implementation, see `apps/backend/app/scrapers/`.

## Active sources

| Source | Type | Auth | Base URL |
|--------|------|------|----------|
| `ikiru` | HTML scraper (Cloudflare) | — | `https://07.ikiru.wtf/` |
| `shinigami` | Public REST API | — | `https://api.shngm.io` |
| `voratoon` | API + HTML fallback | — | `https://api.voratoon.com` |

## Fallback chains

### ikiru
1. Direct HTTP request (curl-cffi with browser impersonation)
2. Jina reader fallback (`https://r.jina.ai/<url>`)
3. Mark source as degraded in `source_health`

### shinigami
1. REST API call
2. Mark source as degraded

### voratoon
1. REST API call
2. HTML fallback (`https://be.komikcast.cc`)
3. Mark source as degraded

## Source roles

- **shinigami** — primary source, public REST API, most reliable
- **voratoon** — secondary source, API + HTML fallback
- **ikiru** — gap-fill scanner: only fetches titles **not already present** in shinigami or voratoon. HTML behind Cloudflare, least reliable.

The whitelist only contains shinigami and voratoon entries. ikiru operates in gap-fill mode to catch titles the other two miss.

## Type mapping

| Source | Type values | Origin values |
|--------|-------------|---------------|
| ikiru | `manhwa`, `manga`, `manhua` | `KR`, `JP`, `CN` |
| shinigami | `manhwa`, `manga`, `manhua` | `KR`, `JP`, `CN` |
| voratoon | `manhwa`, `manga`, `manhua` | `KR`, `JP`, `CN` |

All sources normalize:
- **Rating**: 1–10 float scale via `app/services/rating_utils.py`
- **Title key**: `normalize_title_key()` (lowercase, alnum→space)
- **Origin**: `KR` / `JP` / `CN` via `normalize_origin()`
- **Chapter number**: float (e.g., `12.5`, `160.2`)

## Scraper guards

| Guard | Source | Implementation |
|-------|--------|----------------|
| 24h cutoff | all | Skip items older than `RSS_LOOKBACK_HOURS` (24h) |
| Early-stop pagination | voratoon | Stop when oldest chapter on page > 24h |
| Monotonic chapter guard | all | Skip chapters below `whitelist.latest_sent_chapter` |
| Composite-key dedup | all | `UNIQUE(title_key, source, chapter_num)` prevents URL-rotate re-insert |
| Re-touch suppression | ikiru | ikiru renews `<time>` on old chapters — 24h window + monotonic guard prevents flood |

## Source health tracking

`source_health` table tracks per-source:
- `status`: `healthy` / `degraded`
- `response_time_ms`, `consecutive_failures`, `failures_today`
- `disabled_until`: cooldown expiry after repeated failures

Health is exposed via `GET /api/sources/health` and the `Operational`/`Stale` dot in the frontend nav.

## Configuration

Source URLs and behavior are configured in `app/config.py`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKIRU_BASE_URL` | `https://07.ikiru.wtf/` | ikiru site root |
| `SECONDARY_SOURCE_URL` | `https://api.shnigami.io` | shinigami API base |
| `SECONDARY_PUBLIC_BASE` | — | shinigami public site base |
| `VORATOON_API_URL` | `https://api.voratoon.com` | voratoon API base |
| `VORATOON_FALLBACK_URL` | `https://be.komikcast.cc` | voratoon HTML fallback |
| `RSS_LOOKBACK_HOURS` | `24` | Feed window |
| `SOURCE_KEYS` | `["ikiru", "shinigami", "voratoon"]` | Active sources |
