"""Ikiru REST API client — JSON API primary, HTML scrape fallback.

API endpoints used:
  - /list/latest     → latest updates feed (replaces HTML scrape)
  - /series/{slug}    → series metadata + chapters (replaces HTML scrape)
  - /search/series    → search

HTML scrape fallback is kept for resilience when the API is unavailable.
"""
import random
import time as _t

from app.services.rating_utils import normalize_rating
from app.config import settings
from app.logger import get_logger
from app.utils.cover_scrub import scrub_cover
from app.services.resilience import cb_ikiru

logger = get_logger("ikiru:api")

IKIRU_API = f"{settings.IKIRU_BASE_URL.rstrip('/')}/wp-json/readerkiru/v1"
TIMEOUT = 15.0
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}


def _cf_get(url: str, timeout: float = TIMEOUT) -> object:
    """GET via curl_cffi with Chrome impersonation. Respects circuit breaker."""
    if not cb_ikiru.allow():
        raise RuntimeError("circuit ikiru OPEN — fast fail")
    from curl_cffi import requests as cffi_req
    try:
        r = cffi_req.get(url, headers=_HEADERS, impersonate="chrome", timeout=timeout, allow_redirects=True)
        if r.status_code < 500:
            cb_ikiru.record_success()
        else:
            cb_ikiru.record_failure()
        return r
    except Exception:
        cb_ikiru.record_failure()
        raise


def _fetch_json(path: str, retries: int = 4):
    """GET JSON from Ikiru API with jittered backoff. Circuit-aware."""
    if not cb_ikiru.allow():
        logger.warn("ikiru circuit OPEN — skipping fetch", path=path)
        return None

    # API failure detector — skip API if in HTML-only mode
    from app.services.api_health import get_detector
    _api_health = get_detector("ikiru")
    if not _api_health.should_try_api():
        logger.debug("ikiru in HTML-only mode, skipping API", path=path)
        return None

    url = f"{IKIRU_API}{path}"
    try:
        for attempt in range(retries + 1):
            try:
                # Small delay to avoid Cloudflare rate-limit
                if attempt > 0:
                    _t.sleep(0.5 * attempt)
                r = _cf_get(url)
            except RuntimeError:
                return None
            if r.status_code == 200:
                # Detect Cloudflare challenge (HTML instead of JSON)
                try:
                    data = r.json()
                    cb_ikiru.record_success()
                    _api_health.record_success()
                    return data
                except Exception:
                    # Not JSON — likely Cloudflare challenge
                    logger.warn("ikiru non-JSON response (CF challenge?)", path=path, attempt=attempt)
                    cb_ikiru.record_failure()
                    _api_health.record_failure()
                    if attempt < retries:
                        _t.sleep(1.0 + random.uniform(0, 2.0))
                        continue
                    return None
            if r.status_code in (429, 403, 500, 502, 503) and attempt < retries:
                retry_after = r.headers.get("retry-after")
                if retry_after:
                    try:
                        _sleep = float(retry_after)
                    except (ValueError, TypeError):
                        _sleep = min(2.0 * (attempt + 1), 12.0) + random.uniform(0, 1.0)
                else:
                    _sleep = min(2.0 * (attempt + 1), 12.0) + random.uniform(0, 1.0)
                _t.sleep(_sleep)
                continue
            logger.warn("Ikiru HTTP error", path=path, status=r.status_code)
            cb_ikiru.record_failure()
            _api_health.record_failure()
            return None
    except Exception as e:
        logger.warn("Ikiru fetch failed", path=path, err=str(e))
        cb_ikiru.record_failure()
        _api_health.record_failure()
    return None


# ── Search ──

def search_ikiru_api(query: str, per_page: int = 20):
    """Search series via API."""
    q = query.replace("/", " ")
    data = _fetch_json(f"/search/series?q={q}&per_page={per_page}")
    return data.get("items", []) if data else []


# ── Latest updates: API primary, HTML fallback ──

def get_ikiru_latest_updates(max_pages: int = 20, hours_cutoff: int = 24):
    """Get latest updates. Primary: /list/latest API. Fallback: HTML scrape."""
    from datetime import datetime, timezone, timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_cutoff)
    all_items: list[dict] = []
    seen_slugs: set[str] = set()

    # ── PRIMARY: /list/latest API ──
    for page in range(1, max_pages + 1):
        data = _fetch_json(f"/list/latest?page={page}&per_page=50")
        if not data or not data.get("ok"):
            logger.warn("ikiru /list/latest API failed, falling back to HTML")
            break

        items = data.get("items", [])
        if not items:
            break

        added_this_page = 0
        for item in items:
            slug = item.get("slug") or ""
            if not slug or slug in seen_slugs:
                continue

            modified = item.get("modified_gmt") or ""
            if modified:
                try:
                    ts = datetime.fromisoformat(modified.replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    if ts < cutoff:
                        continue
                except (ValueError, TypeError):
                    pass

            seen_slugs.add(slug)
            series_url = item.get("permalink") or f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
            all_items.append({
                "id": item.get("id") or abs(hash(slug)) % (10 ** 9),
                "title": item.get("title") or slug.replace("-", " ").title(),
                "slug": slug,
                "url": series_url,
                "permalink": series_url,
                "cover": item.get("cover") or "",
                "type": (item.get("type") or [""])[0].lower() if isinstance(item.get("type"), list) else (item.get("type") or "").lower(),
                "modified_gmt": modified or datetime.now(timezone.utc).isoformat(),
                "source": "ikiru",
            })
            added_this_page += 1

        if added_this_page == 0:
            break

    # ── FALLBACK: HTML scrape ──
    if not all_items:
        logger.warn("ikiru API returned no items, falling back to HTML scrape")
        return _get_ikiru_latest_updates_html(max_pages, hours_cutoff)

    return all_items


def _get_ikiru_latest_updates_html(max_pages: int = 2, hours_cutoff: int = 24):
    """Fallback: scrape the latest-update HTML feed."""
    from datetime import datetime, timezone, timedelta
    import re as _re

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_cutoff)
    all_items: list[dict] = []
    seen_slugs: set[str] = set()

    _TIME_RE = _re.compile(
        r'<time[^>]*\sdatetime=["\']([^"\']+)["\'][^>]*>(.*?)</time>',
        _re.IGNORECASE | _re.DOTALL,
    )
    _LINK_RE = _re.compile(
        r'<a[^>]*href=["\']([^"\']*?/manga/[^"\']*?/chapter-(?P<num>\d+(?:\.\d+)?)\.(?P<cid>[\w]+)/?)[^>]*>',
        _re.IGNORECASE,
    )

    for page in range(1, max_pages + 1):
        url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/latest-update/?the_page={page}"
        try:
            r = _cf_get(url)
            if r.status_code == 403 and page == 1:
                _t.sleep(2.0)
                r = _cf_get(url)
            if r.status_code != 200:
                logger.warn("ikiru latest-update http", page=page, status=r.status_code)
                break
            html = r.text
        except Exception as e:
            logger.warn("ikiru latest-update fetch failed", page=page, err=str(e)[:120])
            break

        link_hits = [(m.start(), m) for m in _LINK_RE.finditer(html)]
        time_hits = [(m.start(), m.group(1)) for m in _TIME_RE.finditer(html)]
        link_time: dict[int, str] = {}
        for tpos, _dt in time_hits:
            owner = -1
            for li, (lpos, _lm) in enumerate(link_hits):
                if lpos < tpos:
                    owner = li
                else:
                    break
            if owner >= 0:
                link_time.setdefault(owner, _dt)

        added_this_page = 0
        for li, (lpos, lm) in enumerate(link_hits):
            ch_url = lm.group(1)
            slug = ch_url.rstrip("/").split("/")[-2]
            if slug in seen_slugs:
                continue
            _dt = link_time.get(li) or ""
            if _dt:
                try:
                    _ts = datetime.fromisoformat(_dt.replace("Z", "+00:00"))
                    if _ts.tzinfo is None:
                        _ts = _ts.replace(tzinfo=timezone.utc)
                    if _ts < cutoff:
                        continue
                except (ValueError, TypeError):
                    pass
            seen_slugs.add(slug)
            series_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
            title = slug.replace("-", " ").title()
            all_items.append({
                "id": abs(hash(slug)) % (10 ** 9),
                "title": title,
                "slug": slug,
                "url": ch_url,
                "permalink": series_url,
                "cover": "",
                "type": "",
                "modified_gmt": _dt or datetime.now(timezone.utc).isoformat(),
                "source": "ikiru",
            })
            added_this_page += 1

        if added_this_page == 0:
            break

    return all_items


# ── Series metadata ──

def get_ikiru_series(slug: str):
    """Fetch series metadata via API."""
    data = _fetch_json(f"/series/{slug}")
    return data.get("series") if data else None


def get_ikiru_series_meta(slug: str) -> dict | None:
    """Fetch RICH metadata for an ikiru series via API.

    NOTE: the readerkiru/v1 API returns an EMPTY `rating` field (ikiru bug),
    so we fall back to scraping the series HTML page for the
    schema.org aggregateRating ratingValue. Genres/description/cover come
    from the API.
    """
    url = f"{IKIRU_API}/series/{slug}"
    rating = None
    try:
        r = _cf_get(url)
        if r.status_code != 200:
            logger.warn("ikiru series meta http", slug=slug, status=r.status_code)
            return None
        d = r.json()
        s = d.get("series") if isinstance(d, dict) else None
        if not s:
            return None
        desc = (s.get("description") or "").strip()
        import re as _re
        import html as _html
        desc_clean = _re.sub(r"<[^>]+>", "", desc)
        desc_clean = _html.unescape(desc_clean)
        desc_clean = _re.sub(r"\s+", " ", desc_clean).strip()
        rating = normalize_rating(s.get("rating")) if s.get("rating") not in (None, "", 0) else None
        result = {
            "cover": scrub_cover(s.get("cover")),
            "rating": rating,
            "genres": s.get("genre") or [],
            "description": desc_clean[:2000],
            "type": (s.get("type") or [""])[0].lower() if isinstance(s.get("type"), list) else (s.get("type") or "").lower(),
            "origin": "",  # filled in collect.py from list item type
            "released": str(s.get("released") or ""),
            "source": "ikiru",
            "series_url": s.get("permalink") or f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/",
        }
        # HTML fallback for rating (API returns empty rating)
        if rating is None:
            try:
                from app.scrapers.ikiru import _cf_get as _g
                html_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
                hr = _g(html_url)
                if hr.status_code == 200:
                    import re as _re2
                    m = _re2.search(r'aggregateRating[^}]*ratingValue":\s*([0-9.]+)', hr.text)
                    if not m:
                        m = _re2.search(r'ratingValue"\s*content="([0-9.]+)"', hr.text)
                    if m:
                        result["rating"] = normalize_rating(m.group(1))
            except Exception:
                pass
        # HTML fallback for cover (API returns null for The Strongest Girl)
        if not result.get("cover"):
            try:
                from app.scrapers.ikiru import _cf_get as _g2
                html_url2 = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
                hr2 = _g2(html_url2)
                if hr2.status_code == 200:
                    import re as _re3
                    # Try series thumb first
                    m = _re3.search(r'<div[^>]*class="[^"]*thumb[^"]*"[^>]*>.*?<img[^>]*src="([^"]+)"', hr2.text, _re3.I | _re3.S)
                    if m:
                        result["cover"] = scrub_cover(m.group(1))
                    else:
                        m2 = _re3.search(r'<meta[^>]*property="og:image"[^>]*content="([^"]+)"', hr2.text, _re3.I)
                        if m2 and "logo-ikiru" not in m2.group(1):
                            result["cover"] = scrub_cover(m2.group(1))
            except Exception:
                pass
        return result
    except Exception as e:
        logger.warn("ikiru series meta failed", slug=slug, err=str(e)[:120])
        return None


# ── Chapters: API primary, HTML fallback ──

def get_ikiru_chapters(slug: str, per_page: int = 100):
    """Get chapters for a series. Primary: /series/{slug} API. Fallback: HTML scrape."""
    # ── PRIMARY: API ──
    data = _fetch_json(f"/series/{slug}")
    if data and data.get("ok"):
        chapters_raw = data.get("chapters", {})
        if isinstance(chapters_raw, dict):
            items = chapters_raw.get("items", [])
        else:
            items = chapters_raw if isinstance(chapters_raw, list) else []

        if items:
            series_slug = data.get("series", {}).get("slug") or ""
            return _normalize_api_chapters(items, series_slug)

        # Try latest_chapters inside series
        series = data.get("series", {})
        latest = series.get("latest_chapters", [])
        if latest:
            return _normalize_api_chapters(latest)

    # ── FALLBACK: HTML scrape ──
    if data and data.get("ok"):
        # API succeeded but returned no chapters for this series (e.g. completed
        # / not-yet-indexed) — expected, not an error.
        logger.debug("ikiru API ok but no chapters, falling back to HTML", slug=slug)
    else:
        # API genuinely failed (CF challenge, 5xx, circuit open) — worth a warn.
        logger.warn("ikiru chapters API failed, falling back to HTML", slug=slug)
    return get_ikiru_series_chapters_html(slug)


def _normalize_api_chapters(items: list[dict], series_slug: str = "") -> list[dict]:
    """Normalize API chapter objects to our internal shape."""

    out = []
    for ch in items:
        num = ch.get("number")
        if num is None:
            num = ch.get("number_raw", "")
        cid = ch.get("id") or ch.get("slug") or ""
        permalink = ch.get("permalink") or ""
        # URL must use the SERIES slug, not the chapter slug. The API chapter
        # object carries its own `slug` (e.g. "...-chapter-154") which would
        # produce a broken /manga/<series>-chapter-154/chapter-154.<cid>/ URL.
        # Always anchor the URL on series_slug.
        slug = series_slug or ch.get("slug", "")
        
        # Fix: permalink from API is often broken ("?chapter" without slug)
        # Always construct URL from series slug + chapter number when possible
        ch_url = ""
        if slug and num:
            ch_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/chapter-{num}.{cid}/" if cid else f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/chapter-{num}/"
        elif permalink and "?" not in permalink:
            # Only use permalink if it looks complete (has no query params)
            ch_url = permalink
        elif slug:
            ch_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"

        modified = ch.get("modified_gmt") or ch.get("modified") or ""
        out.append({
            "number": str(num) if num is not None else "",
            "id": str(cid),
            "url": ch_url,
            "slug": slug,
            "updated_time": modified,
            "title": ch.get("title") or f"Chapter {num}",
        })
    return out


def get_ikiru_series_chapters_html(slug: str) -> list[dict]:
    """Fallback: Scrape the FULL chapter list from the manga HTML page."""
    from datetime import datetime, timezone
    import re as _re

    url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
    try:
        r = _cf_get(url)
        if r.status_code == 403:
            _t.sleep(2.0)
            r = _cf_get(url)
        if r.status_code != 200:
            if r.status_code == 404:
                logger.debug("ikiru html chapter fetch http (not found)", slug=slug)
            else:
                logger.warn("ikiru html chapter fetch http", slug=slug, status=r.status_code)
            html_text = ""
        else:
            html_text = r.text
    except Exception as e:
        logger.warn("ikiru html chapter fetch failed", slug=slug, err=str(e))
        html_text = ""

    if not html_text:
        try:
            jina_url = f"https://r.jina.ai/http://{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
            j = _cf_get(jina_url, timeout=20)
            if j.status_code == 200 and j.text:
                html_text = j.text
        except Exception:
            pass
        if not html_text:
            return []

    _TIME_RE = _re.compile(
        r'<time[^>]*\sdatetime=["\']([^"\']+)["\'][^>]*>(.*?)</time>',
        _re.IGNORECASE | _re.DOTALL,
    )
    _LINK_RE = _re.compile(
        r'<a[^>]*href=["\']([^"\']*?/manga/[^"\']*?/chapter-(?P<num>\d+(?:\.\d+)?)\.(?P<cid>[\w]+)/?)[^>]*>',
        _re.IGNORECASE,
    )
    _RE_RELATIVE_TIME = _re.compile(
        r"(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago",
        _re.IGNORECASE,
    )

    seen: set[str] = set()
    out: list[dict] = []

    def _parse_rel(text):
        if not text:
            return None
        m = _RE_RELATIVE_TIME.search(text)
        if not m:
            return None
        n = int(m.group(1))
        unit = m.group(2).lower()
        mult = {
            "second": 1, "minute": 60, "hour": 3600, "day": 86400,
            "week": 604800, "month": 2592000, "year": 31536000,
        }.get(unit)
        if not mult:
            return None
        return (datetime.now(timezone.utc) - __import__("datetime").timedelta(seconds=n * mult))

    link_hits = [(m.start(), m) for m in _LINK_RE.finditer(html_text)]
    time_hits = [
        (m.start(), m.group(1), m.group(2).strip())
        for m in _TIME_RE.finditer(html_text)
    ]
    time_owner = {}
    for ti, (tpos, _dt, _tx) in enumerate(time_hits):
        owner = None
        for li, (lpos, lm) in enumerate(link_hits):
            if lpos < tpos:
                owner = li
            else:
                break
        if owner is not None:
            time_owner[ti] = li
    link_dt = {}
    for ti, li in time_owner.items():
        if li not in link_dt:
            _attr = time_hits[ti][1]
            _txt = time_hits[ti][2]
            _from_attr = None
            _from_text = _parse_rel(_txt)
            try:
                _d = datetime.fromisoformat(_attr.replace("Z", "+00:00"))
                _from_attr = _d if _d.tzinfo else _d.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                pass
            candidates = [c for c in (_from_attr, _from_text) if c]
            link_dt[li] = min(candidates).isoformat() if candidates else None

    for idx, (pos, lm) in enumerate(link_hits):
        s = lm.group(1).rstrip("/").split("/")[-2] if "/manga/" in lm.group(1) else lm.group(2)
        num = lm.group("num")
        cid = lm.group("cid")
        ch_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{s}/chapter-{num}.{cid}/"
        if ch_url in seen:
            continue
        seen.add(ch_url)
        out.append({"number": num, "id": cid, "url": ch_url, "slug": s, "updated_time": link_dt.get(idx)})

    out.sort(key=lambda c: c.get("updated_time") or "", reverse=True)
    return out


