"""Shinigami per-series collector."""
from app.config import settings
from app.logger import get_logger
from app.services.rating_utils import normalize_rating
from app.utils.text import slugify_title_key
from app.scrapers.shinigami import _country_to_type as _country_to_type_fn
from app.cron.collectors.common import _cached_series_meta
from app.services.fcfs import parse_chapter_number as _parse_chapter_num

logger = get_logger("cron:collect:shinigami")

def _collect_shinigami_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    from datetime import datetime, timezone, timedelta

    from app.scrapers import shinigami as _shinigami_scraper
    from app.utils.text import slugify_title_key as _ntk
    from app.services.scanner_confidence import attach_confidence

    # 3 most recent chapters regardless of age (e.g. ch 25 today + ch 24 from 7 days
    # ago). Without cutoff, old chapters flood recent_chapters + Discord.
    # Mirrors ikiru collector's 24h filter.
    try:
        _lookback = int(getattr(settings, "RSS_LOOKBACK_HOURS", 24))
    except Exception:
        _lookback = 24
    _cutoff = datetime.now(timezone.utc) - timedelta(hours=_lookback)

    items: list[dict] = []
    _series: list[dict] = []
    try:
        _series.extend(_shinigami_scraper.get_shinigami_latest_updates() or [])
    except Exception as _pe:
        logger.warn("shinigami latest fetch failed", err=str(_pe)[:120])
        return items
    for m in _series:
        title = m.get("title") or m.get("manga_name") or ""
        if not title:
            continue
        tk = _ntk(title)
        origin = (m.get("country_id") or "").upper()
        cover = m.get("cover_image_url") or m.get("cover_portrait_url") or ""
        rating = normalize_rating(m.get("user_rate")) if m.get("user_rate") else 0.0
        description = (m.get("description") or "").strip()
        _meta_item: dict = {}
        if fetch_meta:
            _meta_item = _cached_series_meta("shinigami", tk)
        if not rating and isinstance(_meta_item, dict):
            rating = normalize_rating(_meta_item.get("rating")) or 0.0
        if not description and isinstance(_meta_item, dict):
            description = (_meta_item.get("description") or "").strip()
        _meta_genres = _meta_item.get("genres") or []
        _tax = m.get("taxonomy") or {}
        if isinstance(_tax, dict):
            genres = [g.get("name") for g in (_tax.get("Genre") or []) if g.get("name")]
        else:
            genres = []
        series_url = f"{settings.SHINIGAMI_PUBLIC_BASE}/series/{m.get('manga_id', '')}"
        chaps = m.get("chapters") or []
        # bulk fix: /manga/list embedded only 3 chapters — if oldest embedded still <24h, there may be >3 within 24h (e.g. Tensei 7, God Killer 6). Fetch full list via /chapter/{id}/list
        if len(chaps) == 3:
            try:
                _oldest_ts = chaps[-1].get("created_at") or chaps[-1].get("release_date") or ""
                _oldest_dt = datetime.fromisoformat(str(_oldest_ts).replace("Z", "+00:00"))
                if _oldest_dt.tzinfo is None:
                    _oldest_dt = _oldest_dt.replace(tzinfo=timezone.utc)
                if _oldest_dt >= _cutoff:
                    _mid = m.get("manga_id") or ""
                    if _mid:
                        try:
                            _full = _shinigami_scraper.get_shinigami_chapters(_mid, per_page=100)
                            if _full:
                                chaps = [
                                    {
                                        "chapter_id": c.get("chapter_id") or c.get("id") or "",
                                        "chapter_number": c.get("chapter_number") or c.get("number") or "",
                                        "created_at": c.get("release_date") or c.get("created_at") or "",
                                        "release_date": c.get("release_date") or c.get("created_at") or "",
                                    }
                                    for c in _full
                                ]
                        except Exception as _fe:
                            logger.debug("shinigami bulk fetch fallback to embedded", manga_id=_mid, err=str(_fe)[:120])
            except Exception:
                pass
        for ch in chaps:
            ch_id = ch.get("chapter_id") or ""
            if not ch_id:
                continue
            ch_str = str(ch.get("chapter_number") or "")
            chapter_url = f"{settings.SHINIGAMI_PUBLIC_BASE}/chapter/{ch_id}"
            _chn = _parse_chapter_num(ch_str)
            _ceil = latest_sent.get((tk, "shinigami"), 0)
            if _chn is not None and _ceil and _chn <= _ceil:
                continue
            # 24h cutoff — skip chapters older than RSS_LOOKBACK_HOURS (parity with ikiru)
            # Use chapter-specific timestamp only; don't fallback to latest_chapter_time
            # which would make a 7-day-old chapter appear fresh.
            _raw_ts = ch.get("created_at") or ch.get("release_date") or ""
            if not _raw_ts:
                continue
            try:
                _dt = datetime.fromisoformat(str(_raw_ts).replace("Z", "+00:00"))
                if _dt.tzinfo is None:
                    _dt = _dt.replace(tzinfo=timezone.utc)
                if _dt < _cutoff:
                    continue
            except (ValueError, TypeError):
                continue
            _type2 = _country_to_type_fn(m.get("country_id")) or ""
            if origin == "CN":
                _type2 = "manhua"
            elif origin == "KR":
                _type2 = "manhwa"
            if not _type2 and isinstance(_meta_item, dict):
                _type2 = (_meta_item.get("type") or "").lower()
            _ch_release = ch.get("created_at") or ch.get("release_date") or m.get("latest_chapter_time") or ""
            items.append({"title": title, "title_key": tk, "chapter": ch_str, "chapter_num": _chn, "url": chapter_url, "source": "shinigami", "cover": cover, "series_url": series_url, "chapter_url": chapter_url, "origin": origin, "updated_time": _ch_release, "release_date": _ch_release, "rating": rating, "genres": genres, "description": description, "type": _type2})
    return attach_confidence(items, "shinigami")
