"""Build relay.json from web_extract cache files.

The VPS IP is Cloudflare-blocked for api.voratoon.com, so a Hermes cron job
fetches the payloads from its own egress (web_extract saves each full response
under ~/.hermes/cache/web/) and this script turns the newest matching cache
file per URL into relay/voratoon/relay.json. The collector reads that file
first and only touches the API directly when the relay is stale — which also
means the direct path keeps working unchanged if the IP block ever lifts.

Run: .venv/bin/python relay/voratoon/build_relay.py
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from app.scrapers.voratoon import _chapter_payload, _series_payload  # noqa: E402
from app.utils.text import slugify_title_key  # noqa: E402

RAW_DIR = Path("/root/.hermes/cache/web")
SLUGS: dict[str, str] = json.loads((HERE / "slugs.json").read_text())
RELAY_PATH = HERE / "relay.json"


def _extract_json(text: str) -> dict | list | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _salvage_chapters(text: str) -> list[dict]:
    """Pull complete chapter objects out of a truncated cache file.

    web_extract caps saved pages at ~50k chars, which cuts a long chapter list
    mid-JSON. The list is newest-first, so everything the 24-hour cutoff keeps
    is already in the head; raw_decode per object recovers the intact ones and
    silently skips the cut-off tail.
    """
    dec = json.JSONDecoder()
    items: list[dict] = []
    for m in re.finditer(r'\{"id":', text):
        try:
            obj, _ = dec.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("data"), dict) and "index" in obj["data"]:
            items.append(obj)
    return items


def _newest_cache_text(url: str, contains: str | None = None) -> str | None:
    """Newest cache file matching a URL header, else a content fingerprint.

    web_extract cache files come in two shapes: a markdown header carrying
    ``URL: <url>``, or a bare JSON code fence with no header at all. The
    content fingerprint is the fallback for the second shape.
    """
    marker = f"URL: {url}"
    best: tuple[float, str] | None = None
    for f in RAW_DIR.glob("*.md"):
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        hit = marker in text[:400] or (contains is not None and contains in text)
        if not hit:
            continue
        cand = (f.stat().st_mtime, text)
        if best is None or cand[0] > best[0]:
            best = cand
    return best[1] if best else None


def _newest_cache_for(url: str, contains: str | None = None) -> dict | None:
    text = _newest_cache_text(url, contains)
    if text is None:
        return None
    payload = _extract_json(text)
    return payload if isinstance(payload, dict) and payload.get("status") == 200 else None


def main() -> int:
    api = "https://api.voratoon.com"
    series_out: dict[str, dict] = {}
    chapters_out: dict[str, list[dict]] = {}
    missing: list[str] = []

    for title_key, slug in SLUGS.items():
        detail = _newest_cache_for(f"{api}/series/{slug}", contains=f'"slug":"{slug}"')
        if not detail:
            missing.append(f"detail:{slug}")
            continue
        # _series_payload unwraps {id, data:{...}}; the HTTP envelope wraps that
        # one level deeper as {status, data: {id, data:{...}}}, and the client's
        # _fetch normally strips it.
        envelope = detail.get("data")
        if not isinstance(envelope, dict):
            missing.append(f"detail-shape:{slug}")
            continue
        raw_series = envelope.get("data")
        if not isinstance(raw_series, dict):
            missing.append(f"detail-shape:{slug}")
            continue
        row = _series_payload(envelope)
        inner = raw_series
        row["description"] = str(inner.get("synopsis") or "").strip()
        row["genres"] = [
            str((g.get("data") or {}).get("name") or "").strip()
            for g in (inner.get("genres") or [])
            if isinstance(g, dict)
        ]
        row["title_key"] = slugify_title_key(row.get("title") or title_key)
        series_out[row["title_key"]] = row

        # The chapters payload carries no slug, so it can only be fingerprinted
        # by the series id the detail payload just gave us.
        sid = row.get("id")
        ch_text = _newest_cache_text(
            f"{api}/series/{slug}/chapters?page=1",
            contains=f'"seriesId":{sid}' if sid is not None else None,
        )
        if ch_text is None:
            missing.append(f"chapters:{slug}")
            continue
        ch_payload = _extract_json(ch_text)
        if isinstance(ch_payload, dict) and isinstance(ch_payload.get("data"), list):
            raw_list = ch_payload["data"]
        else:
            raw_list = _salvage_chapters(ch_text)
        if not raw_list:
            missing.append(f"chapters:{slug}")
            continue
        chapters_out[row["title_key"]] = [
            _chapter_payload(r) for r in raw_list if isinstance(r, dict)
        ]

    if not series_out:
        print("relay build FAILED: no series resolved from cache", file=sys.stderr)
        return 1

    tmp = RELAY_PATH.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(
            {
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "series": series_out,
                "chapters": chapters_out,
            },
            ensure_ascii=False,
        )
    )
    tmp.replace(RELAY_PATH)
    print(
        f"relay ok: series={len(series_out)} chapters={len(chapters_out)}"
        + (f" missing={missing}" if missing else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
