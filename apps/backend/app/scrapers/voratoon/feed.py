"""VoratoonFeed seam — deep module for Voratoon collection.

Hides combos, pagination, takeChapter, dedup, window filtering behind
`VoratoonFeed(window=24h).collect() -> List[dict]`.
"""
from __future__ import annotations

import random
import time
import threading
from datetime import datetime, timezone, timedelta

import httpx

from app.config import settings
from app.logger import get_logger
from app.utils.cover_scrub import scrub_cover
from app.services.resilience import cb_voratoon

logger = get_logger("scraper:voratoon:feed")

TIMEOUT = 30.0
_CLIENTS: dict[int, httpx.Client] = {}
_CLIENTS_LOCK = threading.Lock()


def _base_url() -> str:
    from app.utils.ssrf import assert_allowed_url
    _b = settings.VORATOON_API_URL.rstrip("/")
    assert_allowed_url(_b)
    return _b


def _client() -> httpx.Client:
    key = threading.get_ident()
    with _CLIENTS_LOCK:
        return _CLIENTS.setdefault(key, httpx.Client(timeout=TIMEOUT))


def _get(url: str, **kwargs):
    return _client().get(url, **kwargs)


def _parse_chapter_number(index: int | None) -> float:
    try:
        return float(index) if index is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _emit_series(results: list[dict], s: dict, cutoff: datetime | None = None) -> None:
    data = s.get("data", {})
    slug = data.get("slug", "")
    title = data.get("title", "")
    if not slug:
        return
    _fmt = str(data.get("format") or "").lower()
    _orig_raw = str(data.get("origin") or data.get("country") or "").upper()
    if _fmt == "manga" or _fmt == "jp" or _orig_raw == "JP":
        return
    cover = data.get("coverImage", "")
    cover = scrub_cover(cover) if cover else ""
    synopsis = data.get("synopsis", "")
    rating = data.get("rating")
    genres = [g.get("data", {}).get("name", "") for g in data.get("genres", [])]
    fmt = data.get("format", "manhwa")
    for ch in (s.get("chapters") or []):
        ch_index = ch.get("chapterIndex") or ch.get("data", {}).get("index")
        if not ch_index:
            continue
        _created = ch.get("createdAt") or ch.get("updatedAt") or ""
        if not _created:
            # Skip chapters without valid timestamp — cannot determine release date
            continue
        if cutoff is not None and _created:
            try:
                _ts = datetime.fromisoformat(_created.replace("Z", "+00:00"))
                if _ts.tzinfo is None:
                    _ts = _ts.replace(tzinfo=timezone.utc)
                if _ts < cutoff:
                    continue
            except (ValueError, TypeError):
                pass
        results.append({
            "title": title,
            "title_key": slug.lower(),
            "chapter": str(ch_index),
            "chapter_num": _parse_chapter_number(ch_index),
            "source": "voratoon",
            "cover": cover,
            "series_url": f"https://{settings.VORATOON_DOMAIN}/series/{slug}",
            "chapter_url": f"https://{settings.VORATOON_DOMAIN}/series/{slug}/chapter/{ch_index}",
            "description": synopsis[:500] if synopsis else "",
            "rating": float(rating) if rating else 0.0,
            "genres": genres,
            "type": fmt if fmt in ("manhwa", "manhua", "manga") else "manga" if fmt == "mangatoon" else "",
            "origin": "CN" if fmt == "manhua" else "KR" if fmt == "manhwa" else "",
            "updated_time": _created,
            "release_date": _created,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })


class VoratoonFeed:
    def __init__(self, window_hours: int = 24):
        self.window_hours = window_hours

    def _cutoff(self) -> datetime:
        return datetime.now(timezone.utc) - timedelta(hours=self.window_hours)

    def collect(self) -> list[dict]:
        results: list[dict] = []
        cutoff = self._cutoff()
        _combos = [
            ("manhwa", None),
            ("manhua", None),
            ("mangatoon", None),
            ("manhwa", "type==project"),
            ("manhua", "type==project"),
            ("mangatoon", "type==project"),
        ]

        def _fetch_combo(fmt: str, filt) -> list[dict]:
            _out: list[dict] = []
            page = 1
            while True:
                url = f"{_base_url()}/series"
                params = {
                    "take": 30,
                    "page": page,
                    "sort": "latest",
                    "sortOrder": "desc",
                    "includeMeta": "true",
                    "takeChapter": 50,
                    "format": fmt,
                }
                if filt:
                    params["filter"] = filt
                payload = None
                for attempt in range(3):
                    try:
                        r = _get(
                            url,
                            params=params,
                            timeout=TIMEOUT,
                            headers={"Accept-Encoding": "gzip, deflate"},
                        )
                        if r.status_code == 429:
                            retry_after = r.headers.get("retry-after")
                            wait = float(retry_after) if retry_after else (2 ** attempt + random.uniform(0, 1))
                            logger.debug("voratoon 429 rate limited", attempt=attempt, wait=round(wait, 2))
                            time.sleep(wait)
                            continue
                        r.raise_for_status()
                        payload = r.json()
                        break
                    except Exception as e:
                        logger.error("voratoon series list failed", exc=e)
                        break
                if payload is None:
                    break
                series_list = payload.get("data", [])
                if not series_list:
                    break
                page_has_recent = False
                for s in series_list:
                    for ch in (s.get("chapters") or []):
                        stamp = ch.get("createdAt") or ch.get("updatedAt") or ""
                        try:
                            ts = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                            if ts.tzinfo is None:
                                ts = ts.replace(tzinfo=timezone.utc)
                            if ts >= cutoff:
                                page_has_recent = True
                                break
                        except (ValueError, TypeError):
                            continue
                    _emit_series(_out, s, cutoff)
                if not page_has_recent:
                    break
                meta = payload.get("meta") or {}
                if meta.get("lastPage") and page >= int(meta["lastPage"]):
                    break
                if len(series_list) < 30:
                    break
                page += 1
            return _out

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=len(_combos)) as _ex:
            for _combo_results in _ex.map(lambda c: _fetch_combo(*c), _combos):
                results.extend(_combo_results)

        _seen: set[tuple[str, str]] = set()
        _deduped: list[dict] = []
        for r in results:
            _k = (str(r.get("title_key") or "").lower(), str(r.get("chapter") or ""))
            if _k in _seen:
                continue
            _seen.add(_k)
            _deduped.append(r)
        results = _deduped
        logger.info("voratoon collect done", chapters=len(results))
        return results


# compat: keep old function name for callers that import from app.scrapers.voratoon
def collect_voratoon() -> list[dict]:
    return VoratoonFeed(window_hours=24).collect()
