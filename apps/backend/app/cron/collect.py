"""Source collection orchestrator — delegates per-source to collectors/*."""
from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta

from app.config import settings
from app.logger import get_logger
from app.services.fcfs import parse_chapter_number as _parse_chapter_num
from app.services.rating_utils import normalize_rating
from app.utils.text import normalize_title_key
from app.storage import health, whitelist as wl_store
from app.cron.collectors.common import _SOURCE_TIMEOUT, _parse_types
from app.cron.collectors.ikiru import _collect_ikiru_source
from app.cron.collectors.shinigami import _collect_shinigami_source
from app.cron.collectors.voratoon import _collect_voratoon_source

logger = get_logger("cron:collect")
health_store = health


def collect_recent_chapters(
    with_whitelisted_ikiru: bool = False,
    with_whitelisted_shinigami: bool = False,
    source: str | None = None,
    fetch_meta: bool = True,
) -> tuple[list[dict], dict]:
    _disabled: set[str] = set()
    _env_disabled = (getattr(settings, "DISABLED_SOURCES", "") or "").strip()
    if _env_disabled:
        for _s in _env_disabled.split(","):
            _s = _s.strip().lower()
            if _s:
                _disabled.add(_s)
    try:
        from datetime import datetime, timezone
        hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
        _now = datetime.now(timezone.utc)
        for src, row in (hm or {}).items():
            du = row.get("disabled_until")
            if du:
                try:
                    if datetime.fromisoformat(du.replace("Z", "+00:00")) > _now:
                        _disabled.add(src)
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass

    items: list[dict] = []
    import time as _t
    _hm: dict[str, dict] = {}
    _now_iso = datetime.now(timezone.utc).isoformat()

    _latest_sent: dict[tuple[str, str], float] = {}
    try:
        from app.db import get_supabase as _gsb_ls
        _wl_ls = _gsb_ls().table("whitelist").select("title_key, source, latest_sent_chapter").execute()
        for _w in (_wl_ls.data or []):
            _tk = _w.get("title_key") or ""
            _src = _w.get("source") or ""
            try:
                _ls = float(_w.get("latest_sent_chapter") or 0)
            except (ValueError, TypeError):
                _ls = 0
            _latest_sent[(_tk, _src)] = max(_latest_sent.get((_tk, _src), 0), _ls)
    except Exception as _e:
        logger.warn("collect: load latest_sent_chapter failed", err=str(_e)[:160])

    def _health_start(src: str) -> float:
        return _t.time()

    def _health_end(src: str, t0: float, ok: bool, err: str | None = None) -> None:
        rt = int((_t.time() - t0) * 1000)
        prev = _hm.get(src) or {}
        consec = prev.get("consecutive_failures", 0)
        consec = 0 if ok else consec + 1
        _hm[src] = {
            "status": "healthy" if ok else "degraded",
            "response_time_ms": rt,
            "successes_today": (prev.get("successes_today", 0) + 1) if ok else prev.get("successes_today", 0),
            "failures_today": (prev.get("failures_today", 0) + 1) if not ok else prev.get("failures_today", 0),
            "consecutive_failures": consec,
            "last_success_at": _now_iso if ok else prev.get("last_success_at"),
            "last_checked_at": _now_iso,
            "last_error": err if not ok else None,
        }

    import concurrent.futures

    def _try_collect(src: str) -> tuple[str, list[dict]]:
        try:
            _src_items: list[dict] = []
            if src == "ikiru":
                _exclude_keys: set[str] = set()
                for _it in items:
                    _tk = _it.get("title_key", "") or _it.get("title", "")
                    if _tk:
                        _exclude_keys.add(normalize_title_key(_tk))
                _src_items = _collect_ikiru_source(_latest_sent, _disabled, fetch_meta, exclude_keys=_exclude_keys)
            elif src == "shinigami":
                _src_items = _collect_shinigami_source(_latest_sent, _disabled, fetch_meta)
            elif src == "voratoon":
                _src_items = _collect_voratoon_source(_latest_sent)
            return (src, _src_items)
        except Exception:
            return (src, [])

    _sources_to_run: list[str] = []
    for _src in ("ikiru", "shinigami", "voratoon"):
        if (source is None or source == _src) and _src not in _disabled:
            _sources_to_run.append(_src)

    if _sources_to_run:
        # Sequential fix: collect shinigami+voratoon first (UUID vs slug), then ikiru with exclude_keys.
        # Previously all 3 ran concurrently, so ikiru's _exclude_keys snapshot saw empty `items` (race)
        # and voratoon/ikiru slug duplicates were never excluded. Now phase1 completes before ikiru.
        _phase1 = [s for s in ("shinigami", "voratoon") if s in _sources_to_run]
        _phase2 = [s for s in ("ikiru",) if s in _sources_to_run]
        _t0_map: dict[str, float] = {}

        def _run_phase(sources: list[str]):
            if not sources:
                return
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(sources)) as _executor:
                _futures: dict = {}
                for _src in sources:
                    _t0_map[_src] = _health_start(_src)
                    logger.info("collect start", source=_src)
                    _futures[_executor.submit(_try_collect, _src)] = _src
                for _future in concurrent.futures.as_completed(_futures, timeout=_SOURCE_TIMEOUT):
                    _src = _futures[_future]
                    _t0 = _t0_map.get(_src, _health_start(_src))
                    try:
                        _collected_src, _src_items = _future.result(timeout=5)
                        items.extend(_src_items)
                        _health_end(_src, _t0, True)
                        rt_ms = int((_t.time() - _t0) * 1000)
                        logger.info("collect done", source=_src, count=len(_src_items), response_time_ms=rt_ms)
                    except concurrent.futures.TimeoutError:
                        _health_end(_src, _t0, False, f"timeout after {_SOURCE_TIMEOUT}s")
                        logger.warn("collect TIMEOUT", source=_src, timeout=_SOURCE_TIMEOUT)
                    except Exception as e:
                        _health_end(_src, _t0, False, str(e)[:300])
                        logger.warn("collect failed", source=_src, err=str(e)[:200])

        _run_phase(_phase1)
        _run_phase(_phase2)
    else:
        for _src in ("ikiru", "shinigami", "voratoon"):
            _hm[_src] = {"status": "disabled", "response_time_ms": 0, "successes_today": 0, "failures_today": 0, "consecutive_failures": 0, "last_success_at": None, "last_checked_at": _now_iso, "last_error": "cooldown"}

    if with_whitelisted_ikiru and "ikiru" not in _disabled:
        try:
            wl = wl_store.load_whitelist()
            items.extend(collect_whitelisted_ikiru_chapters(wl))
        except Exception as e:
            logger.warn("collect whitelisted ikiru failed", err=str(e))

    if with_whitelisted_shinigami and "shinigami" not in _disabled:
        try:
            wl = wl_store.load_whitelist()
            items.extend(collect_whitelisted_shinigami_chapters(wl))
        except Exception as e:
            logger.warn("collect whitelisted shinigami failed", err=str(e))

    try:
        from app.storage import excluded_titles as excl_store
        from app.utils.text import normalize_title_key as _ntk_c
        _excl = excl_store.load_excluded_keys()
        if _excl:
            _before = len(items)
            items = [it for it in items if not ((tk := _ntk_c(it.get("title_key", "") or it.get("title", ""))) and ((tk, (it.get("source") or "all")) in _excl or (tk, "all") in _excl))]
            _dropped = _before - len(items)
            if _dropped:
                logger.info("collect: dropped excluded titles", count=_dropped)
    except Exception as e:
        logger.warn("collect: exclude filter failed", err=str(e)[:200])

    return items, _hm


def filter_whitelisted(items: list[dict], whitelist: list[dict]) -> list[dict]:
    allowed: set[str] = set()
    for w in whitelist:
        wk = normalize_title_key(w.get("title_key", ""))
        src = w.get("source")
        if src:
            allowed.add(f"{wk}:{src}")
    result = []
    for it in items:
        key = f"{normalize_title_key(it.get('title_key', ''))}:{it.get('source')}"
        if key in allowed:
            result.append(it)
    return result


def _ikiru_slug_from_source(src: dict) -> str | None:
    v = src.get("url") or ""
    if v:
        seg = v.rstrip("/").split("/")[-1]
        if seg and "chapter-" not in seg:
            return seg
    p = src.get("permalink") or src.get("series_url") or ""
    if p and "/manga/" in p:
        part = p.split("/manga/")[-1].strip("/")
        if part and "chapter-" not in part:
            return part.split("/")[0]
    return None


def collect_whitelisted_shinigami_chapters(whitelist: list[dict]) -> list[dict]:
    import random
    ids: list[tuple[str, str, str]] = []
    seen_ids: set[str] = set()
    from app.db import get_supabase as _get_sb
    from app.scrapers import shinigami
    _sb = _get_sb()
    for w in whitelist:
        wk = normalize_title_key(w.get("title_key", ""))
        src = w.get("source")
        if src != "shinigami":
            continue
        v = w.get("url") or w.get("series_url") or w.get("permalink") or ""
        mid = None
        if 'shinigami.asia/' in v:
            seg = v.rstrip('/').split('/')[-1]
            if seg and '-' in seg:
                mid = seg
        if not mid:
            try:
                rc = (_sb.table("recent_chapters").select("series_url").eq("title_key", w.get("title_key", "")).eq("source", "shinigami").neq("series_url", "").limit(1).execute())
                if rc.data:
                    su = rc.data[0].get("series_url") or ""
                    if "shinigami.asia/series/" in su:
                        mid = su.rstrip("/").split("/")[-1]
            except Exception:
                pass
        if not mid:
            continue
        if mid in seen_ids:
            continue
        seen_ids.add(mid)
        ids.append((mid, wk, w.get("title") or wk.replace("_", " ").title()))
    items: list[dict] = []
    API_CHAPTER_LIMIT = 30
    _notified: dict[str, set[float]] = {}
    try:
        from app.db import get_supabase as _gsb2
        _sb2 = _gsb2()
        _wk_list = [wk for _, wk, _ in ids]
        if _wk_list:
            _dh = (_sb2.table("dispatch_history").select("title_key, source, chapter_title").in_("title_key", _wk_list).execute())
            for _row in (_dh.data or []):
                _tk = _row.get("title_key")
                _ct = _row.get("chapter_title")
                try:
                    _cn = float(_ct)
                except (ValueError, TypeError):
                    continue
                _notified.setdefault(f"{_tk}:{_row.get('source')}", set()).add(_cn)
    except Exception as _e:
        logger.warn("shinigami notified-history load failed", err=str(_e)[:120])
    for mid, wk, wtitle in ids:
        chapters = None
        for _att in range(5):
            try:
                chapters = shinigami.get_shinigami_chapters(mid, per_page=API_CHAPTER_LIMIT)
                break
            except Exception as e:
                import time as _bt
                if _att < 4:
                    _sleep = min(2.0 * (_att + 1), 10.0) + random.uniform(0, 1.0)
                    _bt.sleep(_sleep)
                    continue
                logger.warn("whitelisted shinigami api scrape failed", mid=mid, err=str(e)[:120])
        if not chapters:
            continue
        series_url = f"https://11.shinigami.asia/series/{mid}"
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        _sent = _notified.get(f"{wk}:shinigami") or set()
        for ch in chapters:
            num = ch.get("chapter_number") or ch.get("number") or ch.get("chapter")
            ch_id = ch.get("chapter_id") or ch.get("id")
            ch_url = f"https://11.shinigami.asia/chapter/{ch_id}" if ch_id else (ch.get("url") or "")
            if not ch_url or num is None:
                continue
            rel_raw = ch.get("release_date") or ch.get("published_at") or ch.get("created_at")
            rel_iso = None
            if rel_raw:
                try:
                    rel_iso = datetime.fromisoformat(str(rel_raw).replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    rel_iso = None
            if rel_iso is None or rel_iso < cutoff:
                continue
            try:
                _num_f = float(num)
            except (ValueError, TypeError):
                _num_f = 0
            if _num_f > 0 and _num_f in _sent:
                continue
            items.append({"title": (wtitle or wk.replace("_", " ").title()).replace("’", "'"), "title_key": wk, "chapter": str(num), "chapter_num": float(num) if str(num).replace(".", "", 1).isdigit() else 0, "url": ch_url, "source": "shinigami", "cover": None, "series_url": series_url, "chapter_url": ch_url, "origin": "", "updated_time": rel_iso.isoformat()})
    return items


def collect_whitelisted_ikiru_chapters(whitelist: list[dict]) -> list[dict]:
    slugs: list[str] = []
    seen_slugs: set[str] = set()
    slug_meta = {}
    for w in whitelist:
        src = w.get("source")
        if src != "ikiru":
            continue
        from app.utils.text import ikiru_slug as _ikiru_slug
        _src_url = w.get("url") or w.get("series_url") or w.get("permalink") or ""
        slug = _ikiru_slug_from_source({"url": _src_url}) or _ikiru_slug(w.get("title") or w.get("title_key") or "")
        if not slug and w.get("title"):
            try:
                from app.scrapers.ikiru import search_ikiru_api
                _hits = search_ikiru_api(str(w.get("title")), per_page=5)
                for _h in _hits:
                    _perm = _h.get("permalink") or ""
                    if "/manga/" in _perm:
                        slug = _perm.split("/manga/")[-1].strip("/").split("/")[0]
                        try:
                            from app.db import get_supabase
                            get_supabase().table("whitelist").update({"series_url": _perm}).eq("title_key", w.get("title_key")).eq("source", "ikiru").execute()
                        except Exception:
                            pass
                        break
            except Exception:
                pass
        if slug in seen_slugs:
            continue
        if not slug:
            continue
        seen_slugs.add(slug)
        slugs.append(slug)
        slug_meta[slug] = {"title": w.get("title") or w.get("title_key", "").replace("-", " ").title(), "origin": w.get("origin") or "", "cover": w.get("cover") or None, "latest_sent_chapter": float(w.get("latest_sent_chapter") or 0)}
    items: list[dict] = []
    HTML_CHAPTER_LIMIT = 30
    _now = datetime.now(timezone.utc)
    _cutoff = _now - timedelta(hours=24)
    _slug_notified: dict[str, set[float]] = {}
    try:
        from app.db import get_supabase as _gsb3
        _sb3 = _gsb3()
        _tk_list = [normalize_title_key(s.replace("-", " ")) for s in slugs]
        if _tk_list:
            _dh = (_sb3.table("dispatch_history").select("title_key, source, chapter_title").in_("title_key", _tk_list).execute())
            for _row in (_dh.data or []):
                _tk = _row.get("title_key")
                _ct = _row.get("chapter_title")
                try:
                    _cn = float(_ct)
                except (ValueError, TypeError):
                    continue
                _slug_notified.setdefault(f"{_tk}:{_row.get('source')}", set()).add(_cn)
    except Exception as _e:
        logger.warn("ikiru notified-history load failed", err=str(_e)[:120])
    for slug in slugs:
        _tk = normalize_title_key(slug.replace("-", " "))
        _sent = _slug_notified.get(f"{_tk}:ikiru") or set()
        from app.cron.collectors.common import _cached_chapter_list, _ikiru_re_touch_anchor, _is_ikiru_re_touch, MAX_CHAPTERS_PER_SERIES
        from app.scrapers import ikiru
        chapters = _cached_chapter_list("ikiru", slug, lambda: ikiru.get_ikiru_chapters(slug))
        if not chapters:
            continue
        _max_num, _max_num_time = _ikiru_re_touch_anchor(chapters)
        if len(chapters) > HTML_CHAPTER_LIMIT:
            chapters = chapters[:HTML_CHAPTER_LIMIT]
        series_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
        meta = slug_meta.get(slug, {})
        title = meta.get("title") or slug.replace("-", " ").title()
        origin = meta.get("origin") or ""
        cover = meta.get("cover") or None
        _snapshot_max = float(meta.get("latest_sent_chapter") or 0)
        _max_num = max(_max_num, _snapshot_max)
        for ch in chapters:
            num = ch.get("number")
            try:
                _num_f = float(num) if num is not None else None
            except (ValueError, TypeError):
                _num_f = None
            ch_url = ch.get("url")
            if not ch_url or _num_f is None:
                continue
            if _num_f in _sent:
                continue
            _ut = ch.get("updated_time") or ""
            if not _ut:
                continue
            try:
                _dtp = datetime.fromisoformat(_ut.replace("Z", "+00:00"))
                if _dtp.tzinfo is None:
                    _dtp = _dtp.replace(tzinfo=timezone.utc)
                if _is_ikiru_re_touch(_num_f, _dtp, _max_num, _max_num_time):
                    continue
                if _num_f < _max_num:
                    continue
                if _dtp < _cutoff:
                    break
            except (ValueError, TypeError):
                continue
            items.append({"title": title, "title_key": (ch_url.rstrip("/").split("/")[-2] if ch_url else "").lower() or normalize_title_key(title), "chapter": str(num), "chapter_num": _num_f, "url": ch_url, "source": "ikiru", "cover": cover, "series_url": series_url, "chapter_url": ch_url, "origin": origin, "updated_time": _ut})
    return items
