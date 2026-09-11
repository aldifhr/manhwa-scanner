"""Per-source confidence scoring for collector items.

Validates 6 axes (title, chapter number, URL, source reachability, sequence,
metadata consistency) and returns a 0-100 integer. Used by the /api/v1/confidence
endpoint and as an opt-in post-process in collectors.

ponytail: 6 boolean axes → weighted sum (no ML, no thresholds file). Add new axis
only when a real false-negative justifies it; 6 is enough to catch broken scrapers.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from app.config import settings
from app.logger import get_logger
from app.services.fcfs import parse_chapter_number

logger = get_logger("services:scanner_confidence")

# Weights — must sum to 100
_W_TITLE = 20
_W_CHAPTER = 20
_W_URL = 15
_W_REACH = 20
_W_SEQUENCE = 15
_W_META = 10

# Source host patterns (for reachability heuristic when health store unavailable)
_SOURCE_HOSTS = {
    "ikiru": ("ikiru.wtf", "07.ikiru.wtf", "08.ikiru.wtf"),
    "shinigami": ("shinigami.asia", "shngm.io", "api.shngm.io"),
    "voratoon": ("voratoon.com", "v2.voratoon.com", "api.voratoon.com"),
}

# origin → valid type set (for metadata consistency check)
_ORIGIN_TYPES = {
    "KR": {"manhwa"},
    "CN": {"manhua"},
    "JP": {"manga"},
}


def compute_confidence(source: str, chapter_data: dict) -> int:
    """Compute 0-100 confidence score for a single collector item.

    Args:
        source: source key (ikiru|shinigami|voratoon)
        chapter_data: dict from collector item (must contain title_key, chapter/url)

    Returns:
        int 0-100 confidence score
    """
    if not chapter_data or not source:
        return 0

    score = 0

    # 1. Title matched (20pts) — non-empty, normalized title_key that looks real
    score += _score_title(chapter_data)

    # 2. Chapter number valid (20pts) — parseable positive number
    score += _score_chapter(chapter_data)

    # 3. URL valid (15pts) — well-formed http(s) URL with expected host
    score += _score_url(source, chapter_data)

    # 4. Source reachable (20pts) — health store says healthy (or unknown → assume ok)
    score += _score_reachability(source)

    # 5. Sequence valid (15pts) — chapter_num > latest_sent_chapter
    score += _score_sequence(chapter_data)

    # 6. Metadata consistent (10pts) — origin/type/genres alignment
    score += _score_metadata(chapter_data)

    return min(100, max(0, score))


def _score_title(chapter_data: dict) -> int:
    """Title key present, non-trivial length, not a UUID."""
    tk = (chapter_data.get("title_key") or "").strip()
    if not tk:
        return 0
    if len(tk) < 2:
        return 0
    # UUID-shaped title_key is suspicious
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", tk, re.I):
        return _W_TITLE // 4  # penalize heavily but don't zero
    return _W_TITLE


def _score_chapter(chapter_data: dict) -> int:
    """Chapter number parses to positive float."""
    ch_raw = chapter_data.get("chapter") or chapter_data.get("chapter_num")
    if ch_raw is None:
        return 0
    ch_num = chapter_data.get("chapter_num")
    if ch_num is None:
        ch_num = parse_chapter_number(ch_raw)
    if ch_num is None:
        return 0
    try:
        val = float(ch_num)
    except (TypeError, ValueError):
        return 0
    if val <= 0:
        return 0
    return _W_CHAPTER


def _score_url(source: str, chapter_data: dict) -> int:
    """URL parses as http(s), host matches source's known hosts."""
    url = chapter_data.get("url") or chapter_data.get("chapter_url") or ""
    if not url or not isinstance(url, str):
        return 0
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return 0
    if parsed.scheme not in ("http", "https"):
        return 0
    if not parsed.hostname:
        return 0
    # Host match against source's known hosts
    expected_hosts = _SOURCE_HOSTS.get(source, ())
    if expected_hosts:
        host_lower = parsed.hostname.lower()
        if not any(host_lower == h or host_lower.endswith("." + h) for h in expected_hosts):
            return _W_URL // 2  # partial credit: valid URL but unexpected host
    return _W_URL


def _score_reachability(source: str) -> int:
    """Source is healthy per source_health table."""
    try:
        from app.storage import health as health_store
        hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
        row = (hm or {}).get(source, {})
        status = row.get("status", "unknown")
        consec = row.get("consecutive_failures", 0)
        if status == "down" or consec >= 3:
            return 0
        if status == "degraded":
            return _W_REACH // 2
        # healthy or unknown (no data yet — be lenient)
        return _W_REACH
    except Exception:
        return _W_REACH  # can't check → assume ok


def _score_sequence(chapter_data: dict) -> int:
    """chapter_num > latest_sent_chapter (new chapter, not a re-send)."""
    ch_num = chapter_data.get("chapter_num")
    if ch_num is None:
        ch_raw = chapter_data.get("chapter")
        ch_num = parse_chapter_number(ch_raw) if ch_raw is not None else None
    if ch_num is None:
        return 0
    try:
        ch_val = float(ch_num)
    except (TypeError, ValueError):
        return 0
    latest_sent = chapter_data.get("latest_sent_chapter") or 0
    try:
        ls_val = float(latest_sent)
    except (TypeError, ValueError):
        ls_val = 0
    if ch_val > ls_val:
        return _W_SEQUENCE
    if ch_val == ls_val:
        return _W_SEQUENCE // 2  # edge: same chapter (could be update/re-touch)
    return 0  # chapter < latest_sent → stale


def _score_metadata(chapter_data: dict) -> int:
    """Metadata fields present and internally consistent."""
    score = 0
    origin = (chapter_data.get("origin") or "").upper()
    type_ = (chapter_data.get("type") or "").lower()
    genres = chapter_data.get("genres") or []

    # Origin present (3pts)
    if origin:
        score += 3

    # Type present (3pts)
    if type_:
        score += 3

    # Origin↔type consistency (2pts) — if both present, they should align
    if origin and type_:
        valid_types = _ORIGIN_TYPES.get(origin, set())
        if valid_types and type_ in valid_types:
            score += 2
        elif not valid_types:
            score += 1  # unknown origin → partial
        # else mismatch → 0 for this sub-axis
    elif origin or type_:
        score += 1  # only one present → partial

    # Genres present (2pts) — signals the metadata pipeline ran
    if genres and isinstance(genres, list) and len(genres) > 0:
        score += 2

    return min(_W_META, score)


def attach_confidence(items: list[dict], source: str) -> list[dict]:
    """Attach confidence score to each collector item in-place.

    Usage in collectors:
        items = _collect_ikiru_source(...)
        return attach_confidence(items, "ikiru")
    """
    if not items:
        return items
    for it in items:
        it["confidence"] = compute_confidence(source, it)
    return items
