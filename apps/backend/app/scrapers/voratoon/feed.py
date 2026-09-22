"""VoratoonFeed seam — deep module for Voratoon collection.

Uses Playwright (headless Chromium) to scrape v2.voratoon.com/updates page.
The API at api.voratoon.com is blocked by Cloudflare WAF from datacenter IPs,
but the updates page returns full HTML with chapter links and timestamps.

ponytail: Playwright only for updates page — the HTML has everything we need:
    <a href="/series/{slug}/chapter/{num}">Chapter {N}</a>
    with relative timestamps like "4 hours" or "8 days"
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Iterator

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

logger = logging.getLogger(__name__)

# ─── helpers ──────────────────────────────────────────────────────────────────

_CHAPTER_RE = re.compile(r"/series/(?P<slug>[^/]+)/chapter/(?P<num>\d+)")
_TIME_RE = re.compile(r"(\d+)\s*(hour|day|week|minute)s?", re.IGNORECASE)


def _parse_relative_time(text: str) -> datetime | None:
    """Convert relative time like '4 hours ago' or '8 days' to a datetime."""
    now = datetime.now(timezone.utc)
    total_seconds = 0
    for m in _TIME_RE.finditer(text):
        val = int(m.group(1))
        unit = m.group(2).lower()
        if unit == "minute":
            total_seconds += val * 60
        elif unit == "hour":
            total_seconds += val * 3600
        elif unit == "day":
            total_seconds += val * 86400
        elif unit == "week":
            total_seconds += val * 604800
    if total_seconds == 0:
        return None
    return now - timedelta(seconds=total_seconds)


def _fetch_updates_html() -> str:
    """Fetch rendered HTML from v2.voratoon.com/updates via Playwright."""
    url = "https://v2.voratoon.com/updates"
    logger.debug("voratoon updates fetching: %s", url)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pg = browser.new_page()
        try:
            pg.goto(url, wait_until="networkidle", timeout=30000)
            pg.wait_for_timeout(2000)
            html = pg.content()
        finally:
            browser.close()

    return html


def _parse_updates(html: str) -> list[dict]:
    """Parse chapter updates from the updates page HTML."""
    soup = BeautifulSoup(html, "lxml")
    results = []

    for a in soup.select('a[href*="/series/"][href*="/chapter/"]'):
        href = str(a.get("href", ""))
        m = _CHAPTER_RE.search(href)
        if not m:
            continue

        slug = m.group("slug")
        ch_num = m.group("num")
        text = a.text.strip()

        # Try to extract timestamp from the text or nearby element
        timestamp: datetime | None = None
        time_el = a.find_next(["time", "span"], class_=re.compile(r"time|ago|relative"))
        if time_el:
            timestamp = _parse_relative_time(time_el.text)
        if timestamp is None:
            timestamp = _parse_relative_time(text)

        results.append({
            "slug": slug,
            "chapter_num": ch_num,
            "chapter_url": f"https://v2.voratoon.com{href}",
            "title": slug.replace("-", " ").title(),
            "updated_time": timestamp or datetime.now(timezone.utc),
        })

    return results


# ─── VoratoonFeed class ──────────────────────────────────────────────────────

class VoratoonFeed:
    """Scrape recent chapter updates from Voratoon.

    Usage:
        for item in VoratoonFeed(window_hours=24).collect():
            print(item["title_key"], item["chapter"])
    """

    def __init__(self, window_hours: int = 24) -> None:
        self.window_hours = window_hours
        self._cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)

    def collect(self) -> list[dict]:
        """Collect recent chapter updates, deduplicated by series (latest only)."""
        try:
            html = _fetch_updates_html()
        except Exception as exc:
            logger.warning("voratoon updates fetch failed: %s", exc)
            return []

        items = _parse_updates(html)
        if not items:
            logger.debug("voratoon updates: no items found")
            return []

        # Group by slug, keep only the latest chapter per series
        latest_by_slug: dict[str, dict] = {}
        for item in items:
            slug = item["slug"]
            if slug not in latest_by_slug:
                latest_by_slug[slug] = item
            else:
                existing_ch = latest_by_slug[slug]["chapter_num"]
                if item["chapter_num"] > existing_ch:
                    latest_by_slug[slug] = item

        # Filter by window and format output
        results: list[dict] = []
        for item in latest_by_slug.values():
            updated = item["updated_time"]
            if isinstance(updated, str):
                updated = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            if updated < self._cutoff:
                continue

            results.append({
                "title_key": item["slug"],
                "title": item["title"],
                "chapter": str(item["chapter_num"]),
                "chapter_num": float(item["chapter_num"]),
                "chapter_url": item["chapter_url"],
                "series_url": f"https://v2.voratoon.com/series/{item['slug']}",
                "source": "voratoon",
                "origin": "KR",
                "type": "manhwa",
                "updated_time": updated.isoformat(),
                "description": "",
                "genres": [],
                "rating": None,
                "cover": "",
                "url": item["chapter_url"],
            })

        logger.info(
            "voratoon feed: %d series with updates in last %dh",
            len(results),
            self.window_hours,
        )
        return results


# ─── public API ──────────────────────────────────────────────────────────────

def scrape_origin(origin: str, max_pages: int = 10) -> Iterator[dict]:
    """Scrape all series for a given origin (KR/CN/JP). Not implemented — use feed."""
    logger.warning("voratoon: scrape_origin not implemented for %r", origin)
    yield from ()


def backfill(origin: str, max_pages: int = 50) -> tuple[int, int]:
    """Backfill whitelist with all series from browse pages. Not implemented."""
    logger.warning("voratoon: backfill not implemented for %r", origin)
    return 0, 0


def fetch_series_detail(slug: str) -> dict | None:
    """Fetch a single series detail page. Returns parsed info or None."""
    url = f"https://v2.voratoon.com/series/{slug}"
    logger.debug("voratoon detail: %s", url)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pg = browser.new_page()
        try:
            pg.goto(url, wait_until="networkidle", timeout=30000)
            pg.wait_for_timeout(2000)
            html = pg.content()
        finally:
            browser.close()

    soup = BeautifulSoup(html, "lxml")

    cover_img = soup.select_one("img[src*='prod/series/']")
    cover_url = str(cover_img["src"]) if cover_img else ""

    synopsis_el = soup.select_one("[class*='synopsis']")
    synopsis = synopsis_el.text.strip() if synopsis_el else ""

    latest_chapter = 0
    for tag in soup.select("span.tag-chapters"):
        match = re.search(r"Chapter\s+(\d+)", tag.text)
        if match:
            latest_chapter = max(latest_chapter, int(match.group(1)))

    return {
        "slug": slug,
        "cover_url": cover_url,
        "synopsis": synopsis,
        "latest_chapter": latest_chapter,
    }
