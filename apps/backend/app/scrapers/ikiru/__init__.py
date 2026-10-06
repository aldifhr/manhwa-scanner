"""Ikiru API client (09.ikiru.wtf).

Cloudflare blocks plain httpx/requests from this host, so every call goes
through curl_cffi with a Chrome TLS fingerprint. That is the only reason this
module exists instead of a bare httpx client.

Two list surfaces, both verified live:

  /api/public/library/search?type=MANHWA|MANHUA|MANGA&page=N&limit=M
      Paginated catalogue. `limit` IS honoured (unlike voratoon). Rows carry
      the full metadata (description, genres, score) AND the series' latest
      chapter with a real `updatedAt`, so one request yields everything the
      dispatch pipeline needs.

  /api/public/manga/{slug}
      Series detail. `chapters` is an object holding the complete chapter list
      plus `lastUpdated` / `lastChapter` / `latestChapter`.

Timestamps: ikiru emits WIB wall-clock (UTC+7) but suffixes it with `Z`, so
naively parsing the string as UTC lands every chapter 7 hours in the FUTURE.
Measured directly: the newest chapter's `updatedAt` reads "now + 7h" against a
real UTC clock, and shifting the whole feed by -7h puts the maximum exactly on
now with zero future rows. Normalize by subtracting the offset in `_parse_ts`;
do not trust the `Z`.

Chapter URL shape is /manga/{slug}/chapter-{n}; verified 200.
"""
from __future__ import annotations

import time as _t

from app.config import settings
from app.logger import get_logger
from app.services.resilience import cb_shinigami as _cb  # shared breaker slot

logger = get_logger("scraper:ikiru")

TIMEOUT = 20.0
# The API answers 21 rows per page when limit is omitted; we always pass one.
DEFAULT_LIMIT = 50
MAX_PAGES = 60

# The three catalogue types ikiru serves. MANGA is the JP shelf, MANHUA CN,
# MANHWA KR — matching the origin country codes the rest of the pipeline uses.
TYPE_TO_ORIGIN = {
    "MANHWA": ("manhwa", "KR"),
    "MANHUA": ("manhua", "CN"),
    "MANGA": ("manga", "JP"),
}

# Shelves actually ingested. MANGA (JP) is excluded — see iter_all_series().
_SHELVES = ("MANHWA", "MANHUA")

_cf = None


def _client():
    """One curl_cffi session for the whole process (TLS handshake reuse)."""
    global _cf
    if _cf is None:
        from curl_cffi import requests as _cffi

        _cf = _cffi.Session(impersonate="chrome", timeout=TIMEOUT)
    return _cf


def _api() -> str:
    return settings.IKIRU_API_BASE.rstrip("/")


def _public() -> str:
    return settings.IKIRU_PUBLIC_BASE.rstrip("/")


def _get(path: str, params: dict | None = None):
    """GET JSON, retrying once on a Cloudflare-shaped failure."""
    url = f"{_api()}{path}"
    last = None
    for attempt in range(2):
        try:
            r = _client().get(url, params=params, headers={"Accept": "application/json"})
            if r.status_code != 200:
                last = f"HTTP {r.status_code}"
                _t.sleep(0.6 * (attempt + 1))
                continue
            try:
                data = r.json()
            except Exception:
                # A 200 that is not JSON is a Cloudflare interstitial.
                last = "non-JSON body (Cloudflare challenge?)"
                _t.sleep(1.0 + attempt)
                continue
            if data.get("success") is False:
                last = str(data.get("message") or "success=false")
                _t.sleep(0.6 * (attempt + 1))
                continue
            return data.get("data")
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
            _t.sleep(0.6 * (attempt + 1))
    logger.warn("ikiru request failed", path=path, err=str(last)[:160])
    return None


# ikiru labels WIB wall-clock as UTC. Every timestamp needs this shift or the
# whole feed sits 7h in the future and the freshness window drops everything.
_IKIRU_TZ_OFFSET_H = 7


def parse_ikiru_ts(value):
    """Ikiru timestamp -> aware UTC datetime, correcting the mislabeled zone."""
    from datetime import datetime, timedelta, timezone

    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt - timedelta(hours=_IKIRU_TZ_OFFSET_H)


def _chapter_url(slug: str, number) -> str:
    """Reader URL for a chapter.

    The separator is a HYPHEN, not a slash: /manga/<slug>/chapter-21 returns
    200 while /manga/<slug>/chapter/21 returns 404. Verified against the live
    site for several series. Getting this wrong makes every ikiru link in
    Discord a dead 404 while the chapter itself still looks collected.
    """
    return f"{_public()}/manga/{slug}/chapter-{number}"


def _series_url(slug: str) -> str:
    return f"{_public()}/manga/{slug}"


def get_library_page(page: int = 1, limit: int = DEFAULT_LIMIT, manga_type: str = "MANHWA"):
    """One catalogue page. Returns (rows, total)."""
    data = _get(
        "/api/public/library/search",
        {"type": manga_type, "page": page, "limit": limit, "sortBy": "updated", "sort": "desc"},
    )
    if not isinstance(data, dict):
        return [], 0
    rows = data.get("mangas")
    if not isinstance(rows, list):
        return [], 0
    try:
        total = int(data.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    return rows, total


def get_series_detail(slug: str) -> dict | None:
    """Series detail, or None. `chapters.chapters[]` is the full chapter list."""
    data = _get(f"/api/public/manga/{slug}")
    return data if isinstance(data, dict) else None


def iter_all_series(max_pages: int = MAX_PAGES):
    """Walk the catalogue shelves we actually ingest.

    MANGA (JP) is deliberately excluded: the JP shelf is the largest of the
    three (183 of 287 rows) and the user does not want JP chapters scraped at
    all — dropping it here also removes ~1/3 of the page requests. To bring JP
    back, add "MANGA" to _SHELVES.
    """
    for manga_type in _SHELVES:
        page = 1
        seen = 0
        while page <= max_pages:
            rows, total = get_library_page(page=page, manga_type=manga_type)
            if not rows:
                break
            for row in rows:
                if isinstance(row, dict) and row.get("slug"):
                    yield manga_type, row
            seen += len(rows)
            if total and seen >= total:
                break
            page += 1
