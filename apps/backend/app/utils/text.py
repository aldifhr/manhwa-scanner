"""Shared text normalization helpers."""
from __future__ import annotations

import html
import re

from app.config import settings


def normalize_title_key(title: str) -> str:
    """Canonical normalized title key: lowercase, alnum+space, collapsed.

    Used to match whitelist entries against scraped chapter titles across
    all modules (pipeline, dashboard, compat). MUST be the only implementation.
    """
    if not title:
        return ""
    t = html.unescape(str(title).lower())
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


# ponytail: normalize_title_loose alias removed — use normalize_title_key directly, restore alias when grep -r "normalize_title_loose" finds legacy caller needing loose (non-collapsed) semantics


def slugify_title_key(title: str) -> str:
    """URL/path-safe title key: dashes instead of spaces.

    'eternally regressing knight' -> 'eternally-regressing-knight'.
    Use when putting a title_key in a URL path. Inverse of
    deslugify_title_key. Centralizes the dash<->space convention so we stop
    hand-rolling .replace('-',' ')/.replace(' ','-') at every call site.
    """
    return normalize_title_key(title).replace(" ", "-")


def deslugify_title_key(slug: str) -> str:
    """Reverse slugify_title_key: dashes -> spaces (URL path -> DB title_key).

    DB title_key uses spaces (legacy). Call once when receiving a slug from a
    URL path; never re-implement the replacement inline.
    """
    if not slug:
        return ""
    return slug.replace("-", " ").strip()


def ikiru_slug(title: str) -> str:
    """Canonical ikiru manga slug for a series title.

    ikiru (and most reader sites) render possessives WITHOUT an extra dash:
    "World's Strongest Punch" -> "worlds-strongest-punch" (NOT
    "world-s-strongest-punch" and NOT "world-8217-s-strongest-punch").

    Steps: decode HTML entities (&#8217; -> '), drop apostrophes/quotes
    entirely (don't convert to a space/dash), lowercase, then collapse any
    other non-alnum runs to a single dash. Centralizing this keeps ikiru
    series_url slugs consistent so chapter scrapes don't 404 on slug mismatch.
    """
    if not title:
        return ""
    t = html.unescape(str(title).lower())
    # Remove apostrophes/quotes (possessive "world's" -> "worlds").
    t = re.sub(r"[\'’\u2019\"]", "", t)
    t = re.sub(r"[^a-z0-9]+", "-", t)
    return re.sub(r"-+", "-", t).strip("-")


_SHINIGAMI_HOST_RE = re.compile(r"https?://([^/]+)\.shinigami\.asia")


def normalize_shinigami_url(url: str | None) -> str | None:
    """Rewrite stale shinigami hostnames to current SECONDARY_PUBLIC_BASE.

    Any ``*.shinigami.asia`` host that does not match the current configured
    base is rewritten. To migrate after a subdomain change, only update
    ``SECONDARY_PUBLIC_BASE`` in ``.env``/``config.py``.
    """
    if not url or not isinstance(url, str):
        return url
    current_base = settings.SECONDARY_PUBLIC_BASE.rstrip("/")
    current_host = current_base.split("/")[-1]
    # current_host already contains the full *.shinigami.asia host, so
    # check directly instead of appending another ".shinigami.asia".
    if current_host in url:
        return url

    def _replace(m: re.Match[str]) -> str:
        host = m.group(1)
        if host == current_host:
            return m.group(0)
        return f"{m.group(0).split('://', 1)[0]}://{current_host}"

    return _SHINIGAMI_HOST_RE.sub(_replace, url)
