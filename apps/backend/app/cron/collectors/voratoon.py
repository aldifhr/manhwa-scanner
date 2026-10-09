"""Voratoon per-series collector.

Walks the paginated /series endpoint, keeps whatever sits in the whitelist,
then asks each of those series for its chapter list.

Two API behaviours force this shape (see app/scrapers/voratoon/__init__.py):
`limit` is ignored so pages must be walked by number, and `sort` is ignored so
"recently updated" cannot be requested — the cutoff is applied here instead.

Whitelist membership is what keeps the request count sane. Walking all 10,575
series to find 24-hour chapters would cost 353 page requests; walking only
the ~190 whitelisted titles costs one request each.
"""
from __future__ import annotations

import json
import time as _time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import settings
from app.logger import get_logger
from app.services.fcfs import parse_chapter_number as _parse_chapter_num
from app.services.rating_utils import normalize_rating
from app.services.scanner_confidence import attach_confidence
from app.utils.text import slugify_title_key
from app.storage.series_meta import series_meta

logger = get_logger("cron:collect:voratoon")

SOURCE = "voratoon"
# Hard ceiling on pages walked per cycle. 353 pages exist; this stops a runaway
# walk if the API ever starts returning a bogus lastPage.
MAX_PAGES = 40
MAX_CHAPTERS_PER_SERIES = 25


# The catalogue walk costs ~40 requests. Re-running it every cycle is both slow
# and the exact request shape an abuse filter flags, so it is cached on disk
# and refreshed on an interval instead. Chapters are still checked every cycle,
# which is where the freshness that matters actually comes from.
_CATALOG_CACHE = Path("/tmp/voratoon_catalog_cache.json")
_CATALOG_TTL_S = 3600.0

# The VPS IP is Cloudflare-blocked for api.voratoon.com, so a Hermes cron job
# fetches the payloads from its own egress and drops them here. Relay rows are
# already normalized by relay/voratoon/build_relay.py; when the file is stale
# or missing the code falls through to the direct API, which keeps working if
# the IP block ever lifts.
_RELAY_PATH = Path(__file__).resolve().parents[3] / "relay" / "voratoon" / "relay.json"
_RELAY_TTL_S = 3600.0

# The full sweep: every catalogue page the relay cron fetched (sorted latest,
# takeChapter embedded), normalized by relay/voratoon/build_updates.py. This
# is the primary source — it covers every series with a chapter inside the
# lookback, not just whitelisted ones. relay.json stays as the enrichment
# layer for whitelist titles (description/genres) and the fallback path.
_UPDATES_PATH = Path(__file__).resolve().parents[3] / "relay" / "voratoon" / "relay_updates.json"


def _load_updates_relay() -> list[dict] | None:
    try:
        data = json.loads(_UPDATES_PATH.read_text())
        ts = _parse_ts(data.get("fetched_at"))
        if ts is None or (datetime.now(timezone.utc) - ts).total_seconds() > _RELAY_TTL_S:
            return None
        items = data.get("items")
        return items if isinstance(items, list) else None
    except Exception:
        return None


def _load_relay() -> dict | None:
    try:
        data = json.loads(_RELAY_PATH.read_text())
        ts = _parse_ts(data.get("fetched_at"))
        if ts is None or (datetime.now(timezone.utc) - ts).total_seconds() > _RELAY_TTL_S:
            return None
        return data if isinstance(data.get("series"), dict) else None
    except Exception:
        return None


def _load_catalog_cache() -> list[dict]:
    try:
        st = _CATALOG_CACHE.stat()
        if _time.monotonic() - st.st_mtime > _CATALOG_TTL_S:
            return []
        data = json.loads(_CATALOG_CACHE.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _store_catalog_cache(rows: list[dict]) -> None:
    try:
        # Whitelisted titles only — the cache exists to skip the walk, so
        # storing the whole 10k catalogue would just waste disk.
        tmp = _CATALOG_CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows))
        tmp.replace(_CATALOG_CACHE)
    except Exception as exc:  # noqa: BLE001
        logger.debug("voratoon catalog cache write failed", err=str(exc)[:120])


def _resolve_catalog(wanted: dict[str, dict]) -> list[dict]:
    """Whitelisted series rows: relay first, then the direct API walk."""
    relay = _load_relay()
    if relay:
        matched = [
            row
            for row in relay["series"].values()
            if isinstance(row, dict)
            and slugify_title_key(str(row.get("title_key") or row.get("title") or "")) in wanted
        ]
        if matched:
            logger.info("voratoon catalog from relay", matched=len(matched), whitelist=len(wanted))
            return matched
    cached = _load_catalog_cache()
    if cached:
        return cached
    resolved: list[dict] = []
    for series in _walk_series():
        tk = slugify_title_key((series.get("title") or "").strip())
        if tk in wanted:
            resolved.append(series)
    _store_catalog_cache(resolved)
    logger.info(
        "voratoon catalog resolved",
        matched=len(resolved),
        whitelist=len(wanted),
    )
    return resolved


def _whitelisted_keys() -> dict[str, dict]:
    """{title_key: row} for every whitelisted series, keyed canonically."""
    from app.storage import whitelist as wl_store

    out: dict[str, dict] = {}
    try:
        for row in wl_store.load_whitelist() or []:
            if not isinstance(row, dict):
                continue
            tk = row.get("titleKey") or row.get("title_key") or ""
            if not tk:
                continue
            out[slugify_title_key(tk)] = row
    except Exception as exc:  # noqa: BLE001
        logger.warn("voratoon whitelist read failed", err=str(exc)[:120])
    return out


def series_updated_before(value, cutoff: datetime) -> bool:
    """True when the series row is older than the cutoff, or unparseable.

    Unparseable counts as "too old": the chapter-level cutoff is the real
    gate, and this is only a pre-filter that saves requests.
    """
    dt = _parse_ts(value)
    return dt is None or dt < cutoff


def _parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _excluded_origins() -> set[str]:
    """Origins to skip, from VORATOON_EXCLUDE_ORIGINS (e.g. "JP" or "JP,CN")."""
    try:
        raw = getattr(settings, "VORATOON_EXCLUDE_ORIGINS", "") or ""
    except Exception:
        raw = ""
    if not isinstance(raw, str):
        raw = str(raw)
    return {x.strip().upper() for x in raw.split(",") if x.strip()}


def _items_from_updates(
    updates: list[dict],
    cutoff: datetime,
    latest_sent: dict,
    fetch_meta: bool = True,
) -> list[dict]:
    """Normalize relay updates rows into collector items.

    Rows arrive pre-built by relay/voratoon/build_updates.py (all fields the
    pipeline needs). This applies the same gates the whitelist walk uses —
    freshness cutoff and the dispatch ceiling — plus series_meta enrichment
    for whatever the catalogue payload left empty.
    """
    excluded = _excluded_origins()
    items: list[dict] = []
    for row in updates:
        if not isinstance(row, dict):
            continue
        tk = str(row.get("title_key") or "").strip()
        if not tk:
            continue
        dt = _parse_ts(row.get("updated_time"))
        if dt is None or dt < cutoff:
            continue

        ch_str = str(row.get("chapter") or "").strip()
        num = _parse_chapter_num(ch_str)
        ceiling = latest_sent.get((tk, SOURCE), 0)
        if num is not None and ceiling and num <= ceiling:
            continue

        rating = row.get("rating")
        if rating in (None, ""):
            rating = 0.0
        description = str(row.get("description") or "").strip()
        genres = list(row.get("genres") or [])
        content_type = str(row.get("type") or "").lower()
        origin = str(row.get("origin") or "").upper()
        if origin and origin in excluded:
            continue

        if fetch_meta:
            try:
                meta_item = series_meta.get(SOURCE, tk) or {}
            except Exception:
                meta_item = {}
            if isinstance(meta_item, dict):
                if not rating and meta_item.get("rating") not in (None, ""):
                    rating = normalize_rating(meta_item.get("rating")) or 0.0
                if not description and meta_item.get("description"):
                    description = str(meta_item.get("description") or "").strip()
                if not genres and meta_item.get("genres"):
                    genres = list(meta_item.get("genres") or [])
                if not content_type and meta_item.get("type"):
                    content_type = str(meta_item.get("type") or "").lower()

        items.append(
            {
                "title": str(row.get("title") or "").strip(),
                "title_key": tk,
                "chapter": ch_str,
                "chapter_num": num,
                "url": str(row.get("url") or row.get("chapter_url") or ""),
                "source": SOURCE,
                "cover": str(row.get("cover") or ""),
                "series_url": str(row.get("series_url") or ""),
                "chapter_url": str(row.get("chapter_url") or row.get("url") or ""),
                "origin": str(row.get("origin") or ""),
                "updated_time": dt.isoformat(),
                "release_date": dt.isoformat(),
                "rating": rating,
                "genres": genres,
                "description": description,
                "type": content_type,
            }
        )
    return items


def _walk_series(max_pages: int = MAX_PAGES):
    """Yield series rows from the paginated endpoint."""
    from app.scrapers import voratoon as vt

    for page in range(1, max_pages + 1):
        rows, meta = vt.get_voratoon_series_page(page)
        if not rows:
            return
        for row in rows:
            yield row
        last = meta.get("lastPage")
        try:
            last_i = int(last)
        except (TypeError, ValueError):
            last_i = 0
        if last_i and page >= last_i:
            return


def _collect_voratoon_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    from app.scrapers import voratoon as vt

    try:
        lookback = int(getattr(settings, "RSS_LOOKBACK_HOURS", 24))
    except Exception:
        lookback = 24
    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback)

    wanted = _whitelisted_keys()
    excluded = _excluded_origins()

    # Primary path: the updates relay covers every series with a chapter in
    # the lookback window, not just whitelisted ones. Whitelist gates
    # dispatch downstream, not collection. Falls through to the whitelist
    # walk when the relay file is stale or missing.
    updates = _load_updates_relay()
    if updates is not None:
        items = _items_from_updates(updates, cutoff, latest_sent, fetch_meta)
        logger.info("voratoon collect from updates relay", items=len(items), whitelist=len(wanted))
        return attach_confidence(items, SOURCE)

    if not wanted:
        logger.debug("voratoon: empty whitelist, nothing to do")
        return []

    relay = _load_relay()
    relay_chapters: dict[str, list[dict]] = (relay or {}).get("chapters") or {}

    # Only the fallback path below needs the genre-id table, and fetching it
    # from api.voratoon.com ALWAYS 403s from this VPS (the IP is blocked at
    # Cloudflare's edge), so calling it up front logged a warning on every
    # cycle for a lookup nothing used. Resolve it lazily, and only when a
    # series actually needs it.
    _genres_cache: dict[int, str] | None = None

    def _genre_name(gid: int) -> str | None:
        nonlocal _genres_cache
        if _genres_cache is None:
            try:
                _genres_cache = vt.get_voratoon_genres()
            except Exception:
                _genres_cache = {}
        return _genres_cache.get(gid)

    items: list[dict] = []

    for series in _resolve_catalog(wanted):
        title = (series.get("title") or "").strip()
        if not title:
            continue
        tk = slugify_title_key(title)
        sid = series.get("id")
        if sid is None:
            continue

        # series.updated_at is free data already in the cache. If the series
        # itself has not been touched since the cutoff, its chapters cannot
        # have been either, so skip the request entirely. This is what keeps
        # the cycle at ~5 requests instead of ~100.
        if series_updated_before(series.get("updated_at"), cutoff):
            continue

        content_type, origin = vt._derive_format(series.get("format"))
        if origin and origin in excluded:
            continue
        cover = series.get("cover") or ""
        rating = 0.0
        if series.get("rating") not in (None, ""):
            rating = normalize_rating(series.get("rating")) or 0.0

        description = str(series.get("description") or "").strip()
        genres = list(series.get("genres") or [])
        if not genres:
            genres = [
                name
                for name in (
                    _genre_name(g)
                    for g in (series.get("genre_ids") or [])
                    if isinstance(g, int)
                )
                if name
            ]

        meta_item: dict = {}
        if fetch_meta:
            try:
                meta_item = series_meta.get(SOURCE, tk) or {}
                if not isinstance(meta_item, dict):
                    meta_item = {}
            except Exception:
                meta_item = {}
        if not rating and meta_item.get("rating") not in (None, ""):
            rating = normalize_rating(meta_item.get("rating")) or 0.0
        if not description and meta_item.get("description"):
            description = str(meta_item.get("description") or "").strip()
        if not genres and meta_item.get("genres"):
            genres = list(meta_item.get("genres") or [])
        if not content_type and meta_item.get("type"):
            content_type = str(meta_item.get("type") or "").lower()

        slug = series.get("slug") or tk
        series_url = vt.series_url_for(slug)

        chapters = relay_chapters.get(tk) or vt.get_voratoon_chapters(sid)
        if not chapters:
            continue

        ceiling = latest_sent.get((tk, SOURCE), 0)
        kept = 0
        for ch in chapters:
            if kept >= MAX_CHAPTERS_PER_SERIES:
                break
            index = ch.get("index")
            if index is None:
                continue
            ch_str = str(index)

            dt = _parse_ts(ch.get("created_at") or ch.get("updated_at"))
            if dt is None:
                continue
            if dt < cutoff:
                continue

            num = _parse_chapter_num(ch_str)
            if num is not None and ceiling and num <= ceiling:
                continue

            # The site routes chapters by index, not by the API slug (which
            # is empty on this endpoint).
            chapter_url = f"{vt._public()}/series/{slug}/chapter/{index}"
            kept += 1
            items.append(
                {
                    "title": title,
                    "title_key": tk,
                    "chapter": ch_str,
                    "chapter_num": num,
                    "url": chapter_url,
                    "source": SOURCE,
                    "cover": cover,
                    "series_url": series_url,
                    "chapter_url": chapter_url,
                    "origin": origin,
                    "updated_time": dt.isoformat(),
                    "release_date": dt.isoformat(),
                    "rating": rating,
                    "genres": genres,
                    "description": description,
                    "type": content_type,
                }
            )

    logger.info(
        "voratoon collect done",
        items=len(items),
        whitelist=len(wanted),
    )
    return attach_confidence(items, SOURCE)
