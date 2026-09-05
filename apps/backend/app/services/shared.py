"""Shared utilities — extracted from collect.py, dispatch_mod.py, rss.py, whitelist.py.

Single source of truth for:
- Chapter number parsing
- Whitelist matching
- Cover URL normalization
"""
import re
from urllib.parse import unquote

# ── Chapter Parsing — delegate to centralized FCFS (app/services/fcfs.py) ──
from app.services.fcfs import normalize_chapter, parse_chapter_number  # noqa: F401, re-export


def chapter_label(ch: str) -> str:
    """Clean human label from raw chapter title."""
    ch = (ch or "").strip()
    if not ch:
        return ""
    m = re.match(r"^\s*(?:ch(?:apter)?\.?\s*|chapter\s*)[:.]?\s*(.+)$", ch, re.I)
    if m:
        inner = m.group(1).strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", inner):
            return f"Chapter {inner}"
        num = re.match(r"(\d+(?:\.\d+)?)", inner)
        if num:
            rest = inner[num.end():].strip(" -–—:")
            return f"Chapter {num.group(1)}" + (f" - {rest}" if rest else "")
        return f"Chapter {inner}"
    num = re.match(r"^(\d+(?:\.\d+)?)\s*(.*)$", ch)
    if num and (not num.group(2) or num.group(2).lower().startswith(("side", "extra", "special", "ss"))):
        rest = num.group(2).strip()
        return f"Chapter {num.group(1)}" + (f" - {rest}" if rest else "")
    return ch


# ── Whitelist Matching ──

def whitelist_key(title_key: str, source: str = "") -> tuple[str, str]:
    """Build lookup key for whitelist matching."""
    from app.utils.text import normalize_title_key
    return (normalize_title_key(title_key), source)


def is_whitelisted(title_key: str, source: str, whitelist_map: dict[tuple[str, str], dict]) -> bool:
    """Check if title_key + source is in whitelist."""
    return whitelist_key(title_key, source) in whitelist_map


def get_whitelisted_items(items: list[dict], whitelist_map: dict[tuple[str, str], dict]) -> list[dict]:
    """Filter items to only whitelisted ones."""
    result = []
    for it in items:
        tk = it.get("title_key", "") or it.get("title", "")
        src = it.get("source", "")
        if is_whitelisted(tk, src, whitelist_map):
            result.append(it)
    return result


# ── Cover URL Normalization ──

def normalize_cover(cov: str | None) -> str | None:
    """Extract raw URL from proxy wrapper, handle double-encoding."""
    if not cov or not isinstance(cov, str) or cov.startswith(("http://", "https://")):
        return cov
    # ponytail: stdlib parse_qs replaces 3-prefix loop + manual unquote chain
    from urllib.parse import parse_qs, urlparse, unquote as _uq
    try:
        q = parse_qs(urlparse(cov).query)
        raw = (q.get("url") or [""])[0]
        if raw:
            if "%" in raw:
                try: raw = _uq(_uq(raw))
                except Exception: raw = _uq(raw)
            return raw if raw.startswith(("http://", "https://")) else cov
    except Exception:
        pass
    return cov


# ── FCFS Dedupe Key — delegate to centralized FCFS ──
from app.services.fcfs import fcfs_key as fcfs_key  # noqa: F401, re-export
