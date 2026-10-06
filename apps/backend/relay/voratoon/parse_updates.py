"""Parse the /updates cache and list titles the slug map cannot resolve yet.

The /updates page is the only "recently updated" index Voratoon exposes (the
API ignores sort), so it drives the sweep: every title on page 1 is fresh.
Entry shape in the extracted text is::

    Title
    Chapter 119 UP 2 hours Chapter 118 7 days

The first chapter group after a title line is the newest one. PIN/ANIME are
badges, not titles.

Prints one unresolved title per line for the relay cron to fetch via
``/series?title=...``; empty output means everything is already mapped.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW_DIR = Path("/root/.hermes/cache/web")
SLUG_MAP = HERE / "slug_map.json"

_BADGE = {"PIN", "ANIME", "HOT", "NEW"}
_CHAPTER_RE = re.compile(r"^Chapter\s+(\d+)\s+UP\s+(.+)$", re.I)


def _load_slug_map() -> dict[str, str]:
    try:
        d = json.loads(SLUG_MAP.read_text())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _updates_text() -> str | None:
    best: tuple[float, str] | None = None
    for f in RAW_DIR.glob("v5.voratoon.com-*.md"):
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        if "Update Komik Terbaru" not in text:
            continue
        cand = (f.stat().st_mtime, text)
        if best is None or cand[0] > best[0]:
            best = cand
    return best[1] if best else None


def parse_updates(text: str) -> list[dict]:
    """[{title, chapter, age_text}] newest chapter per entry, in page order."""
    entries: list[dict] = []
    pending_title: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line in _BADGE or line.startswith("#") or line.startswith("URL:"):
            continue
        if line.startswith("Halaman "):
            break
        m = _CHAPTER_RE.match(line)
        if m:
            if pending_title:
                entries.append(
                    {"title": pending_title, "chapter": int(m.group(1)), "age_text": m.group(2).strip()}
                )
                pending_title = None
            continue
        # A non-chapter line before any chapter group is the next entry's title.
        if pending_title is None and not line.startswith("Chapter"):
            pending_title = line
    return entries


def main() -> int:
    text = _updates_text()
    if not text:
        print("ERROR: no /updates cache found", file=sys.stderr)
        return 1
    entries = parse_updates(text)
    slug_map = _load_slug_map()
    unresolved = [e["title"] for e in entries if e["title"] not in slug_map]
    print(json.dumps({"total": len(entries), "unresolved": unresolved}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
