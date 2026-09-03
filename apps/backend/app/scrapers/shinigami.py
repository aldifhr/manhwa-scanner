"""Shinigami (secondary source) API client.

Shinigami exposes a public REST API at api.shngm.io/v1 that does NOT sit behind
Cloudflare, so a plain HTTP client works. Parity with
shared/scrapers/secondary/api.ts.
"""
import httpx
import random
import time as _t

from app.config import settings
from app.logger import get_logger
from app.services.resilience import cb_shinigami

from app.services.rating_utils import normalize_rating
logger = get_logger("shinigami:api")

# Lazy BASE/API so tests can patch settings.SECONDARY_SOURCE_URL at runtime (was import-time binding)
def _base() -> str:
    return settings.SECONDARY_SOURCE_URL.rstrip("/")
def _api() -> str:
    return f"{_base()}/v1"
def _public() -> str:
    return settings.SECONDARY_PUBLIC_BASE.rstrip("/")
# Keep module-level constants for backward compat (callers that import BASE/API)
BASE = _base()  # type: ignore
API = _api()  # type: ignore
PUBLIC = _public()  # type: ignore
TIMEOUT = 10.0

_HEADERS = {
    "User-Agent": settings.HTTP_USER_AGENT,
    "Accept": "application/json",
}

# PERF-03: reuse a single httpx.Client across all requests so TCP/TLS
# connections are pooled + keep-alive'd instead of re-handshaking on every
# _get() call. httpx.Client is thread-safe (internal connection pool).
_CLIENT = httpx.Client(timeout=TIMEOUT, headers=_HEADERS, verify=True)


def _get(path: str, retries: int = 4):
    if not cb_shinigami.allow():
        logger.warn("shinigami circuit OPEN — skipping fetch", path=path)
        return None
    try:
        for attempt in range(retries + 1):
            r = _CLIENT.get(f"{API}{path}")
            if r.status_code == 200:
                cb_shinigami.record_success()
                return r.json()
            if r.status_code in (429, 403, 500, 502, 503) and attempt < retries:
                # R1/R2 FIX: True jittered backoff + respect Retry-After
                retry_after = r.headers.get("retry-after")
                if retry_after:
                    try:
                        _sleep = float(retry_after)
                    except (ValueError, TypeError):
                        _sleep = min(3.0 * (attempt + 1), 12.0) + random.uniform(0, 1.0)
                else:
                    _sleep = min(3.0 * (attempt + 1), 12.0) + random.uniform(0, 1.0)
                _t.sleep(_sleep)
                continue
            logger.warn("Shinigami HTTP error", path=path, status=r.status_code)
            cb_shinigami.record_failure()
            return None
    except Exception as e:
        cb_shinigami.record_failure()
        logger.warn("Shinigami fetch failed", path=path, err=str(e))
    return None


def search_shinigami_api(query: str, per_page: int = 20):
    q = query.replace("/", " ")
    data = _get(f"/manga/list?q={q}&page=1&page_size={per_page}")
    if isinstance(data, dict):
        return data.get("data", []) or []
    if isinstance(data, list):
        return data
    return []


def get_shinigami_latest_updates(page: int = 1, per_page: int = 100, max_pages: int = 10, hours_cutoff: int = 24):
    """Fetch latest-updates (is_update=true, sorted by latest) across BOTH
    manga types (mirror + project), paginating until items are older than
    `hours_cutoff` (or after `max_pages` as a safety cap).

    Shinigami splits its catalog into `type=mirror` (scanlations) and
    `type=project` (official/OEL). The default list only returns `mirror`,
    so we must query both types explicitly and merge + dedupe by manga_id.

    Each type returns `per_page` manga per page. We stop a type's pagination
    when the newest item on a page is older than `hours_cutoff`.
    """
    from datetime import datetime, timezone, timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_cutoff)
    all_items: list[dict] = []
    seen_ids: set[str] = set()
    for mtype in ("mirror", "project"):
        for p in range(1, max_pages + 1):
            data = _get(f"/manga/list?type={mtype}&page={p}&page_size={per_page}&is_update=true&sort=latest&sort_order=desc")
            items = data.get("data", []) if data else []
            if not items:
                break
            # Shinigami returns newest-first; check timestamps to decide whether to stop.
            stop = False
            for it in items:
                ts_raw = it.get("latest_chapter_time") or it.get("updated_at")
                if not ts_raw:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
                    if ts < cutoff:
                        stop = True
                        break
                except (ValueError, TypeError):
                    continue
            for it in items:
                mid = it.get("manga_id")
                if mid and mid in seen_ids:
                    continue
                if mid:
                    seen_ids.add(mid)
                all_items.append(it)
            if stop:
                break
    return all_items


def get_shinigami_series(manga_id: str):
    data = _get(f"/manga/detail/{manga_id}")
    return data.get("data") if data else None


def _country_to_type(country_id: str | None) -> str | None:
    """Map shinigami country_id to content type: KR->manhwa, CN->manhua, JP->manga."""
    if not country_id:
        return None
    mapping = {"KR": "manhwa", "CN": "manhua", "JP": "manga"}
    return mapping.get(country_id.upper())


def get_shinigami_series_meta(manga_id: str) -> dict | None:
    """Normalize shinigami series detail into a flat metadata dict for
    enriching whitelist / whitelist. Extracts cover, rating, genres,
    description, author, artist, status, type, released from the rich
    /v1/manga/detail/<id> taxonomy. Returns None on failure.
    """
    d = get_shinigami_series(manga_id)
    if not d:
        return None
    tax = d.get("taxonomy") or {}
    # taxonomy can be a LIST in some API responses (whitelist.py handles both
    # shapes) — a dict .get() on a list would AttributeError and kill the
    # whole cron prefetch.
    if not isinstance(tax, dict):
        tax = {}
    genres = [g.get("name") for g in (tax.get("Genre") or []) if g.get("name")]
    authors = [a.get("name") for a in (tax.get("Author") or []) if a.get("name")]
    artists = [a.get("name") for a in (tax.get("Artist") or []) if a.get("name")]
    formats = [f.get("name") for f in (tax.get("Format") or []) if f.get("name")]
    types = [t.get("name") for t in (tax.get("Type") or []) if t.get("name")]
    status_map = {1: "ongoing", 2: "completed", 3: "hiatus", 0: "unknown"}
    desc = (d.get("description") or "").strip()
    import re as _re
    import html as _html
    desc_clean = _re.sub(r"<[^>]+>", "", desc)
    desc_clean = _html.unescape(desc_clean)
    desc_clean = _re.sub(r"\s+", " ", desc_clean).strip()
    return {
        "cover": d.get("cover_image_url") or d.get("cover_portrait_url"),
        "rating": normalize_rating(d.get("user_rate")),
        "genres": genres,
        "description": desc_clean[:2000],
        "author": ", ".join(authors) if authors else None,
        "artist": ", ".join(artists) if artists else None,
        
        "type": _country_to_type(d.get("country_id")) or (formats or types or [""])[0].lower() if (formats or types) else None,
        "released": str(d.get("release_year") or ""),
        "origin": d.get("country_id"),
        "source": "shinigami",
        "series_url": f"https://11.shinigami.asia/series/{manga_id}",
    }


def get_shinigami_chapters(manga_id: str, per_page: int = 100) -> list[dict]:
    """Fetch chapter list for a shinigami manga. Returns list of
    dicts with chapter_number and chapter_id. Alias of the
    canonical fetcher (preserved for callers in gap_detector,
    backfill scripts)."""
    data = _get(f"/chapter/{manga_id}/list?page=1&page_size={per_page}&sort_by=chapter_number&sort_order=desc")
    if not data:
        return []
    return data.get("data", [])
