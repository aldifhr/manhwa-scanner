"""Merge /series?title= search caches into slug_map.json.

The relay cron resolves unresolved /updates titles by fetching
``/series?title=<name>``; each response lands in the web_extract cache. This
script folds every cached search/detail payload into slug_map.json
(title -> {slug, id, format, cover, rating}), newest wins. Idempotent — safe
to run every tick.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_relay import _extract_json  # noqa: E402

RAW_DIR = Path("/root/.hermes/cache/web")
SLUG_MAP = HERE / "slug_map.json"


def _series_from_payload(p: dict) -> list[dict]:
    d = p.get("data")
    if isinstance(d, dict) and isinstance(d.get("data"), dict):
        d = d["data"]
        return [
            {
                "title": d.get("title") or "",
                "slug": d.get("slug") or "",
                "id": p.get("data", {}).get("id") if isinstance(p.get("data"), dict) else None,
                "format": d.get("format") or "",
                "cover": d.get("coverImage") or "",
                "rating": d.get("rating"),
            }
        ]
    if isinstance(d, list):  # search results
        out = []
        for row in d:
            if not isinstance(row, dict):
                continue
            inner = row.get("data") or {}
            if not isinstance(inner, dict) or not inner.get("title"):
                continue
            out.append(
                {
                    "title": inner.get("title") or "",
                    "slug": inner.get("slug") or "",
                    "id": row.get("id"),
                    "format": inner.get("format") or "",
                    "cover": inner.get("coverImage") or "",
                    "rating": inner.get("rating"),
                }
            )
        return out
    return []


def main() -> int:
    try:
        m = json.loads(SLUG_MAP.read_text())
        if not isinstance(m, dict):
            m = {}
    except Exception:
        m = {}

    merged = 0
    for f in RAW_DIR.glob("api.voratoon.com-*.md"):
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        if "/series" not in text[:400] and '"slug"' not in text:
            continue
        p = _extract_json(text)
        if not isinstance(p, dict) or p.get("status") != 200:
            continue
        mt = f.stat().st_mtime
        for row in _series_from_payload(p):
            title, slug = row["title"], row["slug"]
            if not title or not slug:
                continue
            prev = m.get(title)
            if isinstance(prev, dict) and prev.get("_mtime", 0) > mt:
                continue
            row["_mtime"] = mt
            m[title] = row
            merged += 1

    SLUG_MAP.write_text(json.dumps(m, ensure_ascii=False, indent=1))
    print(f"slug_map: {len(m)} titles ({merged} rows merged)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
