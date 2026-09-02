"""Pipeline service — orchestrates scrape → enrich → dispatch flow.

Replaces the monolithic pipeline.py and collect.py functions.
"""
from __future__ import annotations

import time

from app.logger import get_logger
from app.services.scraper_service import scraper_service
from app.services.dispatch_service import dispatch_service
from app.services.shared import fcfs_key, parse_chapter_number
from app.storage import health as health_store

logger = get_logger("services:pipeline")


class PipelineService:
    """Full scrape → enrich → dispatch pipeline."""

    def __init__(self):
        self.scraper_service = scraper_service
        self.dispatch_service = dispatch_service

    def run_dispatch(self, dry_run: bool = False) -> dict:
        """Run the full pipeline. Returns stats dict."""
        start = time.time()
        stats = {"sent": 0, "skipped": 0, "failed": 0, "guilds": 0, "duration": 0, "fetched": 0, "matched": 0, "dispatched": True}

        try:
            # Step 1: Collect recent chapters
            items, health = self.scraper_service.collect_recent_chapters()
            stats["fetched"] = len(items)

            # Step 2: Filter to whitelisted items
            from app.db import get_supabase
            sb = get_supabase()
            wl_rows = sb.table("whitelist").select("title_key, source").execute().data or []
            wl_set = {(w.get("title_key", ""), w.get("source", "")) for w in wl_rows}

            to_dispatch = [it for it in items if (it.get("title_key", ""), it.get("source", "")) in wl_set]
            stats["matched"] = len(to_dispatch)

            if not to_dispatch:
                logger.info("pipeline: nothing to dispatch")
                return stats

            # Step 3: Dispatch
            channels = self.dispatch_service.get_target_channels()
            if not channels:
                logger.warn("pipeline: no target channels")
                return stats

            stats["guilds"] = len(channels)

            # FCFS dedupe
            all_keys = [fcfs_key(it.get("title", ""), it.get("chapter", "")) for it in to_dispatch if it.get("url") or it.get("chapter_url")]
            claimed_keys = self.dispatch_service.get_claimed_keys(list(set(all_keys)))

            # Sort: ascending chapter per series
            import re
            to_dispatch.sort(key=lambda it: (
                it.get("title_key") or it.get("title") or "",
                (lambda m: float(m.group(1)) if m else float("inf"))(re.search(r"(\d+(?:\.\d+)?)", str(it.get("chapter") or "")))
            ))

            sent = 0
            seen_run = set()

            for ch in channels:
                for it in to_dispatch:
                    url = it.get("url", "") or it.get("chapter_url", "")
                    if not url:
                        continue
                    norm = fcfs_key(it.get("title", ""), it.get("chapter", ""))
                    if norm in claimed_keys or norm in seen_run:
                        continue
                    seen_run.add(norm)

                    if dry_run:
                        sent += 1
                        continue

                    if self.dispatch_service.send_chapter(it, ch):
                        sent += 1
                        # Keep ceiling + latest markers current so re-touched old
                        # chapters (ikiru) and /recent stay accurate.
                        try:
                            _cn = float(it.get("chapter_num") or parse_chapter_number(it.get("chapter", "")) or 0)
                            if _cn:
                                self.dispatch_service.update_latest_sent_chapter(it.get("title_key", ""), it.get("source", ""), _cn)
                                self.dispatch_service.update_latest_chapter(it.get("title_key", ""), it.get("source", ""), _cn)
                        except Exception as e:
                            logger.warn("ceiling update failed", err=str(e)[:120])
                        # Record in dispatch_history
                        try:
                            from app.storage import dispatch as _ds
                            _ds.claim_and_record([url], [it.get("title_key", "")], [it.get("source", "")], "pipeline",
                                                 chapter_titles=[it.get("chapter", "")], fcfs_keys=[norm])
                            _ds.complete_dispatch_claim(url, None, "pipeline", it.get("title_key", ""), it.get("source", ""),
                                                        norm, it.get("chapter", ""), it.get("cover", "") or "", it.get("series_url", "") or "")
                        except Exception as e:
                            logger.warn("dispatch_history write failed", err=str(e)[:120])

                        time.sleep(0.4)

            stats["sent"] = sent
            logger.info("pipeline dispatch done", sent=sent)

        except Exception as e:
            logger.error("pipeline error", exc=e)
            stats["failed"] = 1

        stats["duration"] = round(time.time() - start, 1)
        health_store.write_cron_status("ok", chapters_sent=stats["sent"], matched=stats["matched"], duration=stats["duration"])
        return stats

    def run_rss_fetch(self) -> dict:
        """Run scrape only (no Discord). Returns stats."""
        start = time.time()
        items, health = self.scraper_service.collect_recent_chapters()
        for src, h in health.items():
            health_store.write_source_health(src, h.get("status", 0), h.get("rt_ms", 0))
        return {"fetched": len(items), "duration": round(time.time() - start, 1)}


# Singleton
pipeline_service = PipelineService()
