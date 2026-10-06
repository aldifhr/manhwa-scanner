"""Turn the sorted catalogue payload into relay_updates.json.

The site's own request shape (``sort=latest&sortOrder=desc&takeChapter=4``)
sorts by updatedAt and embeds the newest chapters per series, so one cached
page is the whole "recently updated" index — no /updates HTML parsing, no
per-series chapter calls. Only chapters inside the freshness cutoff become
items.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from app.scrapers.voratoon import _derive_format, _public  # noqa: E402
from app.utils.text import slugify_title_key  # noqa: E402

RAW_DIR = Path("/root/.hermes/cache/web")
# Fingerprint: payload shape only — chapterIndex appears solely with takeChapter,
# and a complete page ends with lastPage (truncated saves do not).
CATALOG_MARK = '"chapterIndex"'
OUT = HERE / "relay_updates.json"

LOOKBACK_H = 24


def _parse_page(text: str) -> list[dict] | None:
    """Parse one cached catalogue page, tolerating web_extract artifacts."""
    m = re.search(r'\{.*\}', text, re.S)
    if not m:
        return None
    raw = m.group(0)
    # web_extract sometimes injects newlines inside long numbers ("02.\n838").
    raw = re.sub(r'(?<=[0-9])\n(?=[0-9])', '', raw)
    if '"lastPage"' not in raw:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    rows = payload.get("data") if isinstance(payload, dict) else None
    return rows if isinstance(rows, list) else None


def _catalog_pages() -> list[tuple[float, list[dict]]]:
    pages: list[tuple[float, list[dict]]] = []
    for f in RAW_DIR.glob("api.voratoon.com-*.md"):
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        if CATALOG_MARK not in text:
            continue
        rows = _parse_page(text)
        if rows:
            pages.append((f.stat().st_mtime, rows))
    return pages


def _parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def main() -> int:
    pages = _catalog_pages()
    if not pages:
        print("ERROR: no sorted catalogue cache", file=sys.stderr)
        return 1
    # Pages can overlap between ticks (stale + fresh caches coexist); the
    # newest page wins per series id.
    by_id: dict[int, tuple[float, dict]] = {}
    for mtime, rows in pages:
        for row in rows:
            if not isinstance(row, dict):
                continue
            sid = row.get("id")
            if sid is None:
                continue
            prev = by_id.get(sid)
            if prev is not None and prev[0] > mtime:
                continue
            by_id[sid] = (mtime, row)

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=LOOKBACK_H)
    items: list[dict] = []

    for _, row in by_id.values():
        if not isinstance(row, dict):
            continue
        inner = row.get("data") or {}
        if not isinstance(inner, dict):
            continue
        title = (inner.get("title") or "").strip()
        slug = inner.get("slug") or ""
        if not title or not slug:
            continue
        ctype, origin = _derive_format(inner.get("format") or inner.get("type"))
        cover = inner.get("coverImage") or ""
        rating = inner.get("rating") if inner.get("rating") is not None else 0.0
        # The catalogue payload embeds synopsis and genre names per series —
        # free metadata, no per-series detail call needed.
        synopsis = str(inner.get("synopsis") or "").strip()
        genre_names: list[str] = []
        for g in inner.get("genres") or []:
            if not isinstance(g, dict):
                continue
            gd_raw = g.get("data")
            gd = gd_raw if isinstance(gd_raw, dict) else g
            name = gd.get("name")
            if name:
                genre_names.append(str(name))
        tk = slugify_title_key(title)
        series_url = f"{_public()}/series/{slug}"

        chapters = row.get("chapters")
        if not isinstance(chapters, list):
            continue
        for ch in chapters:
            if not isinstance(ch, dict):
                continue
            idx = ch.get("chapterIndex")
            if idx is None:
                continue
            dt = _parse_ts(ch.get("createdAt") or ch.get("updatedAt"))
            if dt is None or dt < cutoff:
                continue
            ts = dt.isoformat()
            url = f"{_public()}/series/{slug}/chapter/{idx}"
            items.append(
                {
                    "title": title,
                    "title_key": tk,
                    "chapter": str(idx),
                    "chapter_num": idx,
                    "url": url,
                    "source": "voratoon",
                    "cover": cover,
                    "series_url": series_url,
                    "chapter_url": url,
                    "origin": origin,
                    "updated_time": ts,
                    "release_date": ts,
                    "rating": rating,
                    "genres": genre_names,
                    "description": synopsis,
                    "type": ctype,
                }
            )

    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"fetched_at": now.isoformat(), "items": items}, ensure_ascii=False)
    )
    tmp.replace(OUT)
    print(f"updates relay: series={len(by_id)} fresh_chapters={len(items)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
