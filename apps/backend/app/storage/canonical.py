"""Canonical series mapping: title_key -> canonical_title_key.

Canonical identity collapses the same series across sources (ikiru slug vs
shinigami slug) so the FE can group/dedupe by canonical_title_key instead of
per-source title_key. Self-canonical (title_key == canonical_title_key) when
no mapping exists.
"""
from __future__ import annotations

import time
from threading import Lock

from app.logger import get_logger

logger = get_logger("storage:canonical")

_CACHE: dict[str, str] | None = None
_CACHE_TS = 0.0
_TTL = 300.0  # 5 min — mapping changes only on manual review
_LOCK = Lock()
_MAX_ENTRIES = 10_000  # bound key growth; series catalog is finite


def _load(force: bool = False) -> dict[str, str]:
    global _CACHE, _CACHE_TS
    now = time.monotonic()
    if not force and _CACHE is not None and (now - _CACHE_TS) < _TTL:
        return _CACHE
    with _LOCK:
        now = time.monotonic()
        if not force and _CACHE is not None and (now - _CACHE_TS) < _TTL:
            return _CACHE
        try:
            # canonical_series table was dropped in migration 035 (dead table).
            # No mapping exists anymore — self-canonical fallback only.
            _CACHE = {}
            _CACHE_TS = now
            # Enforce cap on the fresh load
            if len(_CACHE) > _MAX_ENTRIES:
                _CACHE = dict(list(_CACHE.items())[-_MAX_ENTRIES:])
            return _CACHE
        except Exception as e:
            logger.error("canonical load failed", err=str(e)[:160])
            return _CACHE or {}


def invalidate_cache() -> None:
    """Invalidate canonical cache (call after manual mapping changes)."""
    global _CACHE_TS
    with _LOCK:
        _CACHE_TS = 0.0


def canonical_of(title_key: str) -> str:
    """Canonical title_key for a given title_key (self if unmapped)."""
    if not title_key:
        return ""
    return _load().get(title_key, title_key)
