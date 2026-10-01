"""Voratoon API client.

The site moved to v4.voratoon.com and api.voratoon.com, and the API was
restructured at the same time: /api/v1/comics is gone, replaced by /series,
/series/{id}/chapters and /genres. The old Playwright scraper read an
HTML updates page that no longer exists.

What did NOT change is that the endpoint is no longer blocked by Cloudflare
from this host, so a plain HTTP client is enough -- no browser needed.

Two API quirks that shape this module:

  1. `limit` is ignored. Every page returns 30 rows no matter what is asked
     for, with the real count in meta.total / meta.lastPage. Pagination has to
     walk pages by number.

  2. `sort` is ignored. Rows come back in id order, so "recently updated"
     cannot be asked for -- the caller has to walk and compare itself.

There is no country field anywhere in the payload, so origin is derived from
the format instead. See _derive_origin.
"""
from __future__ import annotations

import time as _t

import httpx

from app.config import settings
from app.logger import get_logger
from app.services.resilience import cb_voratoon

logger = get_logger("voratoon:api")

TIMEOUT = 12.0
# API ignores `limit` and always answers 30 rows.
PAGE_SIZE = 30

_HEADERS = {
    "User-Agent": settings.HTTP_USER_AGENT,
    "Accept": "application/json",
}

_client: httpx.Client | None = None


def _api() -> str:
    return settings.VORATOON_API_BASE.rstrip("/")


def _public() -> str:
    return settings.VORATOON_PUBLIC_BASE.rstrip("/")


def _get() -> httpx.Client:
    """One client for the whole process: connection reuse across pages."""
    global _client
    if _client is None:
        _client = httpx.Client(
            timeout=TIMEOUT, headers=_HEADERS, follow_redirects=True
        )
    return _client


# Format strings this API returns, mapped to the type/country pair the rest of
# the pipeline uses. The API calls the format `type` and uses values like
# "project" that carry no geography, so anything unmapped falls back to KR.
_FORMAT_MAP = {
    "manhwa": ("manhwa", "KR"),
    "manhua": ("manhua", "CN"),
    "manga": ("manga", "JP"),
    "manju": ("manhua", "CN"),
    "project": ("manhwa", "KR"),
    "comic": ("manhwa", "KR"),
    "novel": ("manga", "JP"),
    "novel_manga": ("manga", "JP"),
    "manwha": ("manhwa", "KR"),
}


def _derive_format(raw) -> tuple[str, str]:
    """Map the API's format field onto (type, origin).

    Returns ("", "KR") for anything unrecognized rather than ("", ""), because
    an empty origin produces a null country in the RSS feed and the frontend
    then has to guess the flag. KR is the correct default for this source.
    """
    key = str(raw or "").strip().lower().replace(" ", "_")
    if not key:
        return "manhwa", "KR"
    if key in _FORMAT_MAP:
        return _FORMAT_MAP[key]
    # Try the longest known prefix, so "manhwa_scan" still resolves.
    for known in sorted(_FORMAT_MAP, key=len, reverse=True):
        if key.startswith(known):
            return _FORMAT_MAP[known]
    logger.debug("voratoon unknown format, defaulting", raw=str(raw)[:40])
    return "manhwa", "KR"


def _series_payload(raw: dict) -> dict:
    """Flatten the {id, data:{...}} envelope into the fields we consume."""
    d = raw.get("data") or {}
    if not isinstance(d, dict):
        d = {}
    return {
        "id": raw.get("id"),
        "title": d.get("title") or "",
        "native_title": d.get("nativeTitle") or "",
        "slug": d.get("slug") or "",
        "format": d.get("format") or d.get("type") or "",
        "status": d.get("status") or "",
        "total_chapters": d.get("totalChapters") or 0,
        "rating": d.get("rating"),
        "cover": d.get("coverImage") or "",
        "genre_ids": d.get("genreIds") or [],
        "updated_at": raw.get("updatedAt") or "",
    }


def _chapter_payload(raw: dict) -> dict:
    d = raw.get("data") or {}
    if not isinstance(d, dict):
        d = {}
    return {
        "id": raw.get("id"),
        "index": d.get("index"),
        "slug": d.get("slug") or "",
        "thumbnail": d.get("thumbnail") or "",
        "created_at": raw.get("createdAt") or "",
        "updated_at": raw.get("updatedAt") or "",
    }


# Minimum gap between consecutive requests. The catalogue walk fires ~40
# requests in a row; without a floor that burst is the most obvious thing an
# abuse filter can key on, and it is what this whole module exists to avoid.
_MIN_INTERVAL_S = 0.25
_last_request_at = 0.0


def _throttle() -> None:
    global _last_request_at
    gap = _t.monotonic() - _last_request_at
    if gap < _MIN_INTERVAL_S:
        _t.sleep(_MIN_INTERVAL_S - gap)
    _last_request_at = _t.monotonic()


# Backoff on 429: give up on this cycle rather than hammering through the
# block. Escalating waits turn a rate limit into a longer rate limit.
_BACKOFF_S = (5.0, 15.0)


def _fetch(path: str, params: dict | None = None) -> dict:
    """GET with throttle, circuit breaker and bounded backoff. {} on failure."""
    url = f"{_api()}/{path.lstrip('/')}"
    if not cb_voratoon.allow():
        logger.debug("voratoon circuit open", path=path)
        return {}
    for attempt, wait in enumerate(_BACKOFF_S, start=1):
        try:
            _throttle()
            r = _get().get(url, params=params)
            if r.status_code == 429:
                cb_voratoon.record_failure()
                logger.warn("voratoon rate limited", path=path, attempt=attempt)
                _t.sleep(wait)
                continue
            r.raise_for_status()
            payload = r.json()
            cb_voratoon.record_success()
            return payload if isinstance(payload, dict) else {}
        except Exception as exc:  # noqa: BLE001
            cb_voratoon.record_failure()
            logger.warn("voratoon fetch failed", path=path, attempt=attempt, err=str(exc)[:120])
            return {}
    return {}


def get_voratoon_series_page(page: int = 1) -> tuple[list[dict], dict]:
    """One page of series. Returns (rows, meta)."""
    payload = _fetch("series", {"page": page})
    if not payload:
        return [], {}
    rows = payload.get("data") or []
    meta = payload.get("meta") or {}
    if not isinstance(rows, list):
        return [], {}
    return [_series_payload(r) for r in rows if isinstance(r, dict)], meta


def get_voratoon_genres() -> dict[int, str]:
    """genreId -> name, for turning genreIds into labels."""
    payload = _fetch("genres")
    out: dict[int, str] = {}
    for r in payload.get("data") or []:
        if not isinstance(r, dict):
            continue
        d = r.get("data") or {}
        try:
            out[int(r["id"])] = str(d.get("name") or "")
        except (KeyError, TypeError, ValueError):
            continue
    return out


def get_voratoon_chapters(series_id: int | str) -> list[dict]:
    """All chapters for one series, newest first."""
    payload = _fetch(f"series/{series_id}/chapters")
    if not payload:
        return []
    rows = payload.get("data") or []
    if not isinstance(rows, list):
        return []
    return [_chapter_payload(r) for r in rows if isinstance(r, dict)]


def series_url_for(slug_or_id) -> str:
    return f"{_public()}/series/{slug_or_id}"
