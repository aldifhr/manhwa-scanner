"""FCFS — single source of truth for title+chapter deduplication.

Previously scattered:
- app/cron/dispatch_mod.py: normalize_title, _norm_chapter, fcfs_key, _claimed_titles
- app/storage/dispatch.py: _claimed_fcfs_keys, _claimed_urls
- app/cron/collect.py: _parse_chapter_num
- app/utils/text.py: normalize_title_key (different impl)

This module is the canonical implementation. All callers should import from here.
Re-exports are kept in the old modules for backward compat.
"""
from __future__ import annotations

import html
import re

from app.logger import get_logger

logger = get_logger("services:fcfs")

# --- normalize ---------------------------------------------------------------


def normalize_title(title: str) -> str:
    """Collapse title for FCFS: html-unescape, lower, non-alnum → space.

    "Academy&#8217;s" == "Academy's" → "academy s"
    "The Great Ruler!" == "the great ruler"
    """
    t = html.unescape(str(title or "")).lower()
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def normalize_chapter(ch_str: str | int | float | None) -> str:
    """Canonical chapter token: 12.50 → 12.5, 160-2 → 160.2, 012 → 12."""
    s = str(ch_str or "").strip()
    if not s:
        return s
    m = re.match(r"^(\d+)(?:[.\-](\d+))?$", s)
    if not m:
        # e.g. "OVA", "Extra" — keep as-is (preserve case) for backward compat
        return s
    whole = int(m.group(1))
    if m.group(2) is None:
        return str(whole)
    frac = m.group(2).rstrip("0")
    if not frac:
        return str(whole)
    return f"{whole}.{frac}"


def fcfs_key(title: str, chapter: str | int | float | None) -> str:
    """Stable cross-source dedupe key: normalized title + normalized chapter."""
    return f"{normalize_title(title)}#{normalize_chapter(chapter)}"


def parse_chapter_number(ch: str | int | float | None) -> float | None:
    """Numeric value for sorting/filtering (float), or None if unparseable."""
    if ch is None:
        return None
    if isinstance(ch, (int, float)):
        return float(ch)
    m = re.search(r"(\d+(?:\.\d+)?)", str(ch).strip())
    return float(m.group(1)) if m else None


# --- DB helpers --------------------------------------------------------------


def claimed_fcfs_keys(fcfs_keys: list[str]) -> set[str]:
    """Return subset of fcfs_keys already in dispatch_history or live claims.

    Permanent (dispatch_history) + live (dispatch_claims) so a concurrent
    runner's claim also blocks.
    """
    if not fcfs_keys:
        return set()
    claimed: set[str] = set()
    try:
        from app.db import get_supabase
        res = get_supabase().table("dispatch_history").select("fcfs_key").in_("fcfs_key", fcfs_keys).execute()
        claimed |= {r["fcfs_key"] for r in (res.data or []) if r.get("fcfs_key")}
    except Exception as e:
        logger.warn("fcfs claimed check dispatch_history failed", err=str(e)[:120])
    try:
        from app.db import get_supabase as _gsb2
        res2 = _gsb2().table("dispatch_claims").select("fcfs_key").in_("fcfs_key", fcfs_keys).execute()
        claimed |= {r["fcfs_key"] for r in (res2.data or []) if r.get("fcfs_key")}
    except Exception as e:
        logger.warn("fcfs claimed check dispatch_claims failed", err=str(e)[:120])
    return claimed


# ponytail: claimed_titles removed — use claimed_fcfs_keys; kept as shim in dispatch_mod via alias, delete shim when grep -r "claimed_titles" ==0


# ponytail: _parse_chapter_num alias removed — import parse_chapter_number directly, delete alias shim when grep -r "_parse_chapter_num" ==0
