# Reader Cover No-FE-Fallback Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix live `GET /api/v1/reader/cover?series=<slug>` to return correct image for all series (shinigami `assets.shngm.id` and voratoon `cvr.voratoon.id` presigned) without any FE fallback, handling typo canonicalization `bizzare`↔`bizarre`.

**Architecture:** Keep single BE seam `app/api/cover.py:200-260`. Fix DB lookup to mirror `rss_query.map_result` + `rss_service.fetch_rss_data` behavior: use `normalize_title_key`/`slugify_title_key`/`canonical_of`, query `whitelist`+`recent_chapters`+`series_meta`, unwrap voratoon proxy URLs before `scrub_cover`/`_fetch_image`. Preserve `PROXY_ALLOWED_HOSTS` SSRF guard.

**Tech Stack:** FastAPI + psycopg2 `app/db_adapter.py` builder, `curl_cffi` image proxy, `app/utils/text.py`, `app/scrapers/_shared/cover.py:scrub_cover`, `app/storage/canonical.py`.

**Spec:** Bug report from live probe `https://scanner.aldifhr.fun` 2026-09-21: `RSS q=dao` returns 4 rows with covers (`shinigami https://assets.shngm.id/...` + `voratoon /api/v1/reader/proxy?url=https...cvr.voratoon.id...X-Amz...`), but `reader/cover?series=dao-of-the-bizzare-immortal` and `bizarre-immortal` and `idle-player-returns-as-a-god` all return `SVG No cover` 254B `image/svg+xml`. Direct `reader/proxy?url=https...assets.shngm.id...` works 177KB `image/jpeg`. No FE fallback allowed.

## Global Constraints

- No FE fallback — BE must return image, FE may only show `No cover` SVG + `Refresh` action, not silent RSS fallback.
- `PROXY_ALLOWED_HOSTS` allowlist must stay exact host:port, no wildcards — `app/config.py:99`.
- `VORATOON_COVER_BUCKET` presigned `X-Amz-` URLs must be fetched direct (bypass proxy re-encode) per `cover.py:54-57` and FE `lib/cover/index.ts:127`.
- Canonical: `normalize_title_key` is single source for `title_key` matching — `app/utils/text.py:9`.
- Verify: `py_compile + pytest + curl` live before claim complete — `AGENTS.md` verification-before-completion.

---

### Task 1: Fix title_key canonicalization and series_meta fallback in reader/cover DB lookup

**Files:**
- Modify: `apps/backend/app/api/cover.py:200-260`
- Modify: `apps/backend/app/scrapers/_shared/cover.py:78-125` (optional, add helper if needed)
- Test: `apps/backend/tests/test_api_cover.py` (create)

**Interfaces:**
- Consumes: `app.utils.text.normalize_title_key(title: str) -> str`, `slugify_title_key(title: str) -> str`, `app.storage.canonical.canonical_of(tk: str) -> str`, `app.db.get_supabase().table(...).select(...).in_(...)`, `app.db_adapter.q`
- Produces: `reader_cover(request: Request) -> FastResponse` now finds cover via normalized+slug+canonical candidates across 3 tables.

- [ ] **Step 1: Write failing test for canonical lookup**

```python
# apps/backend/tests/test_api_cover.py
from unittest.mock import MagicMock, patch

def test_reader_cover_finds_shinigami_via_slug_and_series_meta():
    # DB has title_key="dao of the bizarre immortal" (space) in series_meta,
    # request is dash slug "dao-of-the-bizarre-immortal"
    mock_sb = MagicMock()
    # whitelist empty
    mock_sb.table.return_value.select.return_value.in_.return_value.limit.return_value.execute.return_value.data = []
    # recent_chapters empty
    # series_meta has cover
    def table_side(name):
        m = MagicMock()
        sel = m.select.return_value
        sel.in_.return_value.limit.return_value.execute.return_value.data = (
            [{"cover": "https://assets.shngm.id/thumbnail/image/8c44cded-5e58-4272-aa8a-3b174bd614c1.jpg", "title_key": "dao of the bizarre immortal"}]
            if name == "series_meta" else []
        )
        # ilike fallback also
        sel.ilike.return_value.limit.return_value.execute.return_value.data = []
        return m
    mock_sb.table.side_effect = table_side
    with patch("app.api.cover.get_supabase", return_value=mock_sb):
        with patch("app.api.cover._fetch_image") as mock_fetch:
            from fastapi.responses import Response
            mock_fetch.return_value = Response(content=b"jpeg", media_type="image/jpeg")
            from app.api.cover import reader_cover
            import asyncio
            from unittest.mock import AsyncMock
            req = MagicMock()
            req.query_params.get.return_value = "dao-of-the-bizarre-immortal"
            req.url.query = "series=dao-of-the-bizarre-immortal"
            # need Request with query_params mock
            result = asyncio.run(reader_cover(req))
            assert result.media_type == "image/jpeg"
```

- [ ] **Step 2: Run to verify fails**

Run: `py -3 -m pytest apps/backend/tests/test_api_cover.py::test_reader_cover_finds_shinigami_via_slug_and_series_meta -v`
Expected: FAIL — `reader_cover` returns `image/svg+xml` No cover, not `image/jpeg`, because current candidates `{"dao-of-the-bizarre-immortal","dao of the bizarre immortal"}` not normalized and no `series_meta` query.

- [ ] **Step 3: Implement canonical + series_meta lookup**

```python
# apps/backend/app/api/cover.py:201-258 — edit reader_cover()
from app.utils.text import normalize_title_key, slugify_title_key
from app.storage.canonical import canonical_of  # if exists else fallback to normalize

# Build normalized candidates (6-8 variants) exactly as rss_query does
series_raw = (request.query_params.get("series","") or "").strip()
series_norm = normalize_title_key(series_raw)  # "dao of the bizarre immortal"
series_slug = slugify_title_key(series_raw)   # "dao-of-the-bizarre-immortal"
series_canonical = canonical_of(series_raw) if series_raw else series_norm
# Also handle bizzare typo: canonical_of maps known typo? Else use norm/slug only
candidates_norm = {series_raw, series_slug, series_norm, series_canonical,
                   series_raw.lower(), series_slug.lower(), series_norm.lower()}
# Also expand dashed/space swaps already covered by norm/slug

# Query 3 tables in order: whitelist -> recent_chapters -> series_meta
# Use batch IN with all candidates, plus ilike fallback with _like as before but on normalized
# For each table: .in_("title_key", list(candidates_norm)) OR .in_("title_key", [norm, slug])
# Add series_meta query after recent_chapters
```

Add loop:

```python
for table in ("whitelist","recent_chapters","series_meta"):
    try:
        res = sb.table(table).select("cover, title_key").in_("title_key", list(candidates_norm)).limit(5).execute()
        # also try normalized IN if not found, and ilike
    except Exception:
        continue
```

Collect `all_covers` from all 3.

- [ ] **Step 4: Run test to verify passes**

Run: `py -3 -m pytest apps/backend/tests/test_api_cover.py::test_reader_cover_finds_shinigami_via_slug_and_series_meta -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/app/api/cover.py apps/backend/tests/test_api_cover.py
git commit -m "fix: cover lookup canonical + series_meta fallback"
```

### Task 2: Fix voratoon proxy URL unwrap and non-http skip

**Files:**
- Modify: `apps/backend/app/api/cover.py:254-258`
- Modify: `apps/backend/app/scrapers/_shared/cover.py:35-60` (add `unwrap_proxy_cover` helper)
- Test: `apps/backend/tests/test_api_cover.py` (append)

**Interfaces:**
- Consumes: `scrub_cover(url: str) -> str`, `urllib.parse.unquote`, `urllib.parse.urlparse`
- Produces: `reader_cover` handles `cover="/api/v1/reader/proxy?url=https%3A...cvr.voratoon.id...X-Amz..."` → unwrapped presigned URL → `scrub_cover` returns direct URL → `_fetch_image` succeeds, not SVG.

- [ ] **Step 1: Write failing test for voratoon proxy cover**

```python
def test_reader_cover_unwraps_voratoon_proxy():
    mock_sb = MagicMock()
    # recent_chapters returns proxy cover (as live RSS does)
    proxy_cover = "/api/v1/reader/proxy?url=https%3A%2F%2Fcvr.voratoon.id%2Fprod%2Fseries%2Fdao-of-the-bizarre-immortal%2Fcover%2Fdao.webp%3FX-Amz-Algorithm%3DAWS4-HMAC-SHA256%26X-Amz-Signature%3D322a"
    def table_side(name):
        m = MagicMock()
        sel = m.select.return_value
        if name == "recent_chapters":
            sel.in_.return_value.limit.return_value.execute.return_value.data = [{"cover": proxy_cover, "title_key": "dao-of-the-bizzare-immortal"}]
        else:
            sel.in_.return_value.limit.return_value.execute.return_value.data = []
        sel.ilike.return_value.limit.return_value.execute.return_value.data = []
        return m
    mock_sb.table.side_effect = table_side
    with patch("app.api.cover.get_supabase", return_value=mock_sb):
        with patch("app.api.cover._fetch_image") as mock_fetch:
            mock_fetch.return_value = MagicMock(status_code=200, media_type="image/webp")
            # ensure _fetch_image called with unwrapped https://cvr.voratoon.id... not /api/...
            from app.api.cover import reader_cover
            import asyncio
            req = MagicMock()
            req.query_params.get.return_value = "dao-of-the-bizzare-immortal"
            result = asyncio.run(reader_cover(req))
            called_url = mock_fetch.call_args[0][0]
            assert called_url.startswith("https://cvr.voratoon.id")
            assert "X-Amz-" in called_url
```

- [ ] **Step 2: Run to verify fails**

Run: `py -3 -m pytest apps/backend/tests/test_api_cover.py::test_reader_cover_unwraps_voratoon_proxy -v`
Expected: FAIL — current `if not cover_url.startswith("http"): continue` skips proxy cover, returns SVG, `mock_fetch` never called with `https://cvr...`.

- [ ] **Step 3: Implement unwrap**

```python
# apps/backend/app/api/cover.py:254-258 inside for raw in ranked loop
from urllib.parse import unquote, urlparse, parse_qs

def _unwrap_cover(raw: str) -> str:
    raw = (raw or "").strip()
    if raw.startswith("/api/v1/reader/proxy?url=") or raw.startswith("/api/v1/reader/cover-img?url=") or raw.startswith("/api/img?url="):
        try:
            inner = raw.split("url=",1)[1]
            inner = unquote(inner)
            # double decode if needed
            if "%" in inner and not inner.startswith("http"):
                inner = unquote(inner)
            return inner
        except Exception:
            return raw
    return raw

# in loop:
for raw in ranked:
    cover_url = _unwrap_cover(raw)
    cover_url = scrub_cover(cover_url)
    if not cover_url or not cover_url.startswith("http"):
        continue
    return await _fetch_image(cover_url, cache_control="public, max-age=3600")
```

Update `scrub_cover` comment for voratoon direct.

- [ ] **Step 4: Run test to verify passes**

Run: `py -3 -m pytest apps/backend/tests/test_api_cover.py -v`
Expected: PASS both tests.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/app/api/cover.py apps/backend/app/scrapers/_shared/cover.py apps/backend/tests/test_api_cover.py
git commit -m "fix: unwrap voratoon proxy cover before scrub/fetch"
```

### Task 3: Integration verification against live + local DB

**Files:**
- Modify: `apps/backend/tests/test_api_cover.py` (add live curl test, optional)
- No code change, just verification

**Interfaces:**
- Consumes: `curl.exe -s -i https://scanner.aldifhr.fun/api/v1/reader/cover?series=...`, `curl -s https://scanner.aldifhr.fun/api/v1/rss?q=...`

- [ ] **Step 1: Write verification script (not failing test, manual)**

```python
# verify_live.py (temp)
import subprocess, json
for slug in ["dao-of-the-bizarre-immortal","dao-of-the-bizzare-immortal","idle-player-returns-as-a-god","island-of-stars-and-chains"]:
    out = subprocess.check_output(["curl.exe","-s","-i",f"https://scanner.aldifhr.fun/api/v1/reader/cover?series={slug}"]).decode()
    assert "image/jpeg" in out or "image/webp" in out or "image/png" in out, f"{slug} still SVG: {out[:200]}"
    print(slug, "OK")
```

- [ ] **Step 2: Run py_compile + pytest**

Run: `py -3 -m py_compile apps/backend/app/api/cover.py && py -3 -m pytest apps/backend/tests/test_api_cover.py apps/backend/tests/test_utils_cover_scrub.py -v`
Expected: PASS

- [ ] **Step 3: Deploy and curl live**

Run after deploy:
`curl.exe -s -i "https://scanner.aldifhr.fun/api/v1/reader/cover?series=dao-of-the-bizarre-immortal" | head -n 5`
Expected: `Content-Type: image/jpeg` or `image/webp` `Content-Length: >10000` `X-Cache: MISS`

`curl.exe -s "https://scanner.aldifhr.fun/api/v1/rss?q=dao&limit=2"` still returns `cover` with `assets.shngm.id`.

- [ ] **Step 4: Check pm2 logs**

Run: `pm2 logs manhwa-api --lines 50 --nostream` check no `cover cache get failed` warn spike.

- [ ] **Step 5: Commit verification doc**

```bash
git add docs/superpowers/plans/2026-09-21-reader-cover-no-fe-fallback.md
git commit -m "docs: add cover fix plan"
```
