"""Discord embed builder (parity with lib/discord/embed-builder.ts)."""
from __future__ import annotations

import html
import re
from datetime import datetime, timezone

# Same-origin image proxy so Discord can load covers that would
# otherwise 403 on hotlink (ikiru/shinigami block cross-origin img).
# Mirror of the frontend rewriteCoverUrl() logic.
from urllib.parse import quote as _urlquote


try:
    from app.config import settings as _settings
    _PUBLIC_BASE = (_settings.PUBLIC_BASE_URL or "https://scanner.aldifhr.fun").rstrip("/")
except Exception:
    _PUBLIC_BASE = "https://scanner.aldifhr.fun"


def _proxy_cover(cover: str | None) -> str | None:
    """Return the cover URL for Discord embeds.

    Discord's embed image fetcher cannot send our monitor auth token, so the
    authenticated /reader/proxy returns 401 and covers render blank. Use the
    PUBLIC /api/reader/cover endpoint instead — it serves the same
    allowlisted, size-capped, cached image bytes without auth, so Discord can
    load the cover directly.
    """
    if not cover or not isinstance(cover, str):
        return cover
    cover = cover.strip()
    if not cover:
        return cover
    # Already proxied — return as-is
    if "/api/v1/reader/cover-img" in cover or "/api/reader/cover-img" in cover:
        return cover
    public_base = (_PUBLIC_BASE or "https://scanner.aldifhr.fun").rstrip("/")
    # Voratoon covers are stored as a same-origin /api/reader/proxy?url=<enc
    # upstream> wrapper (so the FE fetches them through the authed proxy).
    # Discord needs the DIRECT upstream URL wrapped in the PUBLIC cover-img
    # proxy instead — unwrap the inner url first, else the double-wrap 403s.
    if ("/api/reader/proxy" in cover or "/api/v1/reader/proxy" in cover) and "url=" in cover:
        from urllib.parse import urlparse as _up, parse_qs as _pqs, unquote as _uq
        _inner = _pqs(_up(cover).query).get("url", [""])[0]
        if _inner:
            cover = _uq(_inner)
    # Direct URLs (ikiru, shinigami, voratoon assets) — wrap in public cover-img proxy
    # so Discord can fetch without auth and bypass hotlink protection
    return f"{public_base}/api/v1/reader/cover-img?url={_urlquote(cover, safe='')}"


SOURCE_COLORS = {
    "ikiru": 0x22C55E,
    "shinigami": 0xEF4444,
    "voratoon": 0xFFA500,
}

SOURCE_LABELS = {
    "ikiru": "Ikiru",
    "shinigami": "Shinigami",
    "voratoon": "Voratoon",
}

STAR_FILLED = "⭐"
STAR_EMPTY = "☆"



def _rating_stars(rating) -> str:
    if rating in (None, "", "N/A"):
        return "`No rating`"
    try:
        num = float(rating)
    except (TypeError, ValueError):
        return "`No rating`"
    filled = max(0, min(5, round(num / 2)))
    display = int(num) if num.is_integer() else f"{num:.1f}"
    return f"{STAR_FILLED * filled}{STAR_EMPTY * (5 - filled)} `{display}/10`"


def _short_synopsis(text: str) -> str | None:
    if not text:
        return None
    d = str(text).strip()
    if d.lower() in ("unknown", "n/a"):
        return None
    # strip html tags
    import re
    clean = re.sub(r"<[^>]*>", "", d).strip()
    if len(clean) <= 220:
        return clean
    sub = clean[:220]
    last_space = sub.rfind(" ")
    return f"{sub[:last_space if last_space > 160 else 220].strip()}..."


def _truncate(text: str, n: int = 200) -> str:
    text = (text or "").strip()
    return text[:n] + "..." if len(text) > n else text


def _release_timestamps(updated_time: str | None) -> str:
    if not updated_time:
        return "Unknown"
    try:
        # psycopg returns datetime objects for timestamptz columns (claim path
        # uses SELECT *), not strings. Handle both.
        if isinstance(updated_time, datetime):
            secs = int(updated_time.timestamp())
            return f"<t:{secs}:R> (<t:{secs}:F>)"
        s = str(updated_time)
        if s.isdigit():
            secs = int(s) / 1000 if len(s) > 11 else int(s)
        else:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            secs = int(dt.timestamp())
        return f"<t:{secs}:R> (<t:{secs}:F>)"
    except Exception:
        return "Unknown"


def build_chapter_embed(
    title: str,
    chapter: str,
    url: str = "",
    series_url: str = "",
    source: str = "",
    cover: str = "",
    rating: str = "",
    genres: list | None = None,
    description: str = "",
    updated_time: str = "",
) -> dict:
    return _build_embed(
        title=title,
        chapters=[str(chapter)],
        chapter_urls=[url],
        series_url=series_url,
        source=source,
        cover=cover,
        rating=rating,
        genres=genres,
        description=description,
        updated_time=updated_time,
    )


def build_multi_chapter_embed(
    title: str,
    chapters: list[str],
    chapter_urls: list[str],
    series_url: str = "",
    source: str = "",
    cover: str = "",
    rating: str = "",
    genres: list | None = None,
    description: str = "",
    updated_time: str = "",
) -> dict:
    """One embed for a title that dropped MULTIPLE chapters in 24h.

    Groups all chapters into a single Discord message (instead of N messages,
    one per chapter) to stay under daily message limits. Shows the chapter
    list and links to the latest one.
    """
    return _build_embed(
        title=title,
        chapters=[str(c) for c in chapters],
        chapter_urls=chapter_urls,
        series_url=series_url,
        source=source,
        cover=cover,
        rating=rating,
        genres=genres,
        description=description,
        updated_time=updated_time,
    )


# Pre-compiled regex for chapter number extraction (called 2x per embed build).
_CHAPTER_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")


def _build_embed(
    title: str,
    chapters: list[str],
    chapter_urls: list[str],
    series_url: str = "",
    source: str = "",
    cover: str = "",
    rating: str = "",
    genres: list | None = None,
    description: str = "",
    updated_time: str = "",
) -> dict:
    label = SOURCE_LABELS.get(source, source or "unknown")
    color = SOURCE_COLORS.get(source, 0x95A5A6)
    genres_text = ", ".join((genres or [])[:5]) if genres else None
    rating_display = _rating_stars(rating) if rating else "`No rating`"

    # Decode HTML entities (e.g. "I&#8217;m" → "I'm")
    title_clean = html.unescape(title or "")
    description_clean = html.unescape(description or "")
    if genres_text:
        genres_text = html.unescape(genres_text)

    # Chapter field: list all chapters, link the latest one.
    _chapters_sorted = sorted(
        zip(chapters, chapter_urls),
        key=lambda x: float(m.group(1)) if (m := _CHAPTER_NUM_RE.search(x[0])) else 0,
    )
    _chapter_links = []
    for _ch, _url in _chapters_sorted:
        if _url:
            _chapter_links.append(f"[ch {_ch}]({_url})")
        else:
            _chapter_links.append(f"ch {_ch}")
    _latest_url = _chapters_sorted[-1][1] if _chapters_sorted else ""
    _latest_tracked = _latest_url
    _multi = len(_chapters_sorted) > 1
    _chapter_value = ", ".join(_chapter_links) if _multi else (_chapter_links[0] if _chapter_links else "—")

    fields = [
        {"name": "🕐 Released", "value": _release_timestamps(updated_time), "inline": False},
        {"name": "📖 Chapter" + ("s" if _multi else ""), "value": _chapter_value, "inline": True},
        {"name": "🔗 Source", "value": f"`{label}`", "inline": True},
    ]
    if genres_text:
        fields.append({"name": "🏷️ Genres", "value": f"`{genres_text}`", "inline": False})
    fields.append({"name": "⭐ Rating", "value": rating_display, "inline": True})

    action_parts = []
    if _latest_tracked:
        action_parts.append(f"[📖 Read Latest]({_latest_tracked})")
    if series_url and series_url != _latest_url:
        action_parts.append(f"[📚 Series Page]({series_url})")
    action_line = f"**Links:** {' • '.join(action_parts)}" if action_parts else ""
    synopsis_text = _short_synopsis(description_clean)
    desc = ""
    if synopsis_text:
        desc = synopsis_text + (f"\n{action_line}" if action_line else "")
    elif action_line:
        desc = action_line

    embed = {
        "title": _truncate(title_clean, 200) or "Untitled",
        "url": series_url or None,
        "color": color,
        "fields": fields,
        "footer": {"text": f"Source: {label}"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if desc:
        embed["description"] = desc
    if cover and (cover.startswith("http") or cover.startswith("/api/reader/") or cover.startswith("/api/v1/reader/") or cover.strip()):
        embed["thumbnail"] = {"url": _proxy_cover(cover)}
    return embed
