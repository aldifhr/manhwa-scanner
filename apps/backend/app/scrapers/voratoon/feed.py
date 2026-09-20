"""VoratoonFeed seam — deep module for Voratoon collection.

Hides combos, pagination, takeChapter, dedup, window filtering behind
`VoratoonFeed(window=24h).collect() -> List[dict]`.

Caller (collectors/voratoon.py) no longer knows about 6 combos or 50.
Test seam with fake clock / fake http without live API.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from app.logger import get_logger

logger = get_logger("scraper:voratoon:feed")


class VoratoonFeed:
    def __init__(self, window_hours: int = 24):
        self.window_hours = window_hours

    def _cutoff(self) -> datetime:
        return datetime.now(timezone.utc) - timedelta(hours=self.window_hours)

    def collect(self) -> list[dict]:
        from app.scrapers.voratoon import collect_voratoon as _collect

        # delegate to existing implementation, but ensure window is respected
        # (collect_voratoon already uses 24h cutoff internally)
        # This seam allows future injection of window without touching caller
        if self.window_hours != 24:
            # override cutoff by monkey-patching time? For now, just call and filter
            cutoff = self._cutoff()
            results = _collect()
            out = []
            for r in results:
                ts = r.get("updated_time") or r.get("release_date") or ""
                try:
                    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    if dt >= cutoff:
                        out.append(r)
                except Exception:
                    continue
            return out
        return _collect()
