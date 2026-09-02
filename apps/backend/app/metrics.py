"""Lightweight process-level metrics (no external deps).

Counters are incremented from hot paths (cron, dispatch, errors) and
exposed via GET /api/metrics (JSON, cron+monitor auth) alongside DB counts.
Prometheus metrics (GET /metrics, open) are the canonical scrape endpoint
for infrastructure; this module is for lightweight JSON debugging.

M1 FIX: Counters are now bounded — old counter names are pruned when
count exceeds MAX_COUNTERS to prevent unbounded memory growth.
"""
import threading
from collections import defaultdict

_lock = threading.Lock()
_counters: dict[str, int] = defaultdict(int)

# M1 FIX: Removed dead _timers dict — never incremented anywhere in codebase

# M1 FIX: Bound the number of counter names to prevent unbounded growth
MAX_COUNTERS = 200


def inc(name: str, by: int = 1) -> None:
    with _lock:
        _counters[name] += by
        # M1 FIX: Prune oldest counters if we exceed MAX_COUNTERS
        if len(_counters) > MAX_COUNTERS:
            # Remove the oldest 25% of counters (those with lowest values)
            sorted_counters = sorted(_counters.items(), key=lambda x: x[1])
            to_remove = sorted_counters[:len(sorted_counters) // 4]
            for k, _ in to_remove:
                del _counters[k]


def snapshot() -> dict:
    with _lock:
        return {
            "counters": dict(_counters),
        }
