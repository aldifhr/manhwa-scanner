from __future__ import annotations

import logging
import threading

logger = logging.getLogger("tasks.retention")

_DISPATCH_HISTORY_RETENTION_DAYS = 30
_CRON_RUN_STATUS_RETENTION_DAYS = 7
_FAILED_DISPATCHES_RETENTION_DAYS = 7
_RECENT_CHAPTERS_RETENTION_DAYS = 7
_RETENTION_MAX_PER_SERIES = 500
_SERIES_META_RETENTION_DAYS = 14
_VACUUM_INTERVAL_S = 604800  # weekly


def _retention_loop(stop_event) -> None:
    """Hourly check: prune old rows + stale whitelist (1 bulan nggak update -> hapus)."""
    _last_whitelist_prune = 0.0
    _last_vacuum = 0.0
    while not stop_event.is_set():
        try:
            from app.db import get_supabase as _gsb_m
            _sb = _gsb_m()
            from datetime import datetime, timedelta, timezone
            cutoff = (datetime.now(timezone.utc) - timedelta(days=_DISPATCH_HISTORY_RETENTION_DAYS)).isoformat()
            _sb.table("dispatch_history").delete().lt("sent_at", cutoff).execute()
            try:
                _cron_cutoff = (datetime.now(timezone.utc) - timedelta(days=_CRON_RUN_STATUS_RETENTION_DAYS)).isoformat()
                _sb.table("cron_run_status").delete().lt("created_at", _cron_cutoff).execute()
            except Exception as e:
                logger.warning("retention: cron_run_status cleanup failed", exc_info=e)
            try:
                _failed_cutoff = (datetime.now(timezone.utc) - timedelta(days=_FAILED_DISPATCHES_RETENTION_DAYS)).isoformat()
                _sb.table("failed_dispatches").delete().in_("status", ["resolved", "permanent_failure"]).lt("updated_at", _failed_cutoff).execute()
            except Exception as e:
                logger.warning("retention: failed_dispatches cleanup failed", exc_info=e)
            # VACUUM ANALYZE weekly to prevent bloat (Supabase pooler: no autovacuum admin)
            import time as _t3
            if _t3.time() - _last_vacuum > _VACUUM_INTERVAL_S:
                try:
                    from app.db import get_conn, put_conn
                    _vc = get_conn()
                    try:
                        with _vc.cursor() as cur:
                            cur.execute("VACUUM ANALYZE recent_chapters")
                            cur.execute("VACUUM ANALYZE cron_run_status")
                            cur.execute("VACUUM ANALYZE series_meta")
                        _last_vacuum = _t3.time()
                        logger.info("retention: weekly VACUUM ANALYZE done")
                    except Exception as e:
                        logger.warning("retention: vacuum failed", exc_info=e)
                    finally:
                        put_conn(_vc)
                except Exception:
                    pass
            try:
                _over = (
                    _sb.table("dispatch_history")
                    .select("title_key, source")
                    .execute()
                )
                from collections import Counter
                _cnt = Counter((r.get("title_key"), r.get("source")) for r in (_over.data or []))
                _bad = {k: v for k, v in _cnt.items() if v > _RETENTION_MAX_PER_SERIES}
                for (tk, src), n in _bad.items():
                    _keep = (
                        _sb.table("dispatch_history")
                        .select("sent_at")
                        .eq("title_key", tk)
                        .eq("source", src)
                        .order("sent_at", desc=True)
                        .limit(_RETENTION_MAX_PER_SERIES)
                        .execute()
                    )
                    _cutoff_ts = (_keep.data or [{}])[-1].get("sent_at") if _keep.data else None
                    if _cutoff_ts:
                        _sb.table("dispatch_history").delete().eq("title_key", tk).eq("source", src).lt("sent_at", _cutoff_ts).execute()
            except Exception as e:
                logger.warning("retention: dispatch_history per-series cap failed", exc_info=e)
            try:
                _now_iso = datetime.now(timezone.utc).isoformat()
                _stale = _sb.table("dispatch_claims").delete().lt("expires_at", _now_iso).execute()
                _stale_count = len(_stale.data) if _stale.data else 0
                _null = _sb.table("dispatch_claims").delete().is_("created_at", "null").execute()
                _null_count = len(_null.data) if _null.data else 0
                if _stale_count or _null_count:
                    logger.info("retention: cleaned stale dispatch_claims", expired=_stale_count, null_created=_null_count)
            except Exception as e:
                logger.warning("retention: stale claims cleanup failed", exc_info=e)
            try:
                from app.storage.error_logs import delete_older_than as _err_prune
                _pruned = _err_prune(days=7)
                if _pruned:
                    logger.info("retention: pruned error_logs", deleted=_pruned, days=7)
            except Exception as e:
                logger.warning("retention: error_logs cleanup failed", exc_info=e)
            try:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=_SERIES_META_RETENTION_DAYS)).isoformat()
                _wl = _sb.table("whitelist").select("title_key").execute()
                _wl_keys = {r.get("title_key") for r in (_wl.data or []) if r.get("title_key")}
                _rc = _sb.table("recent_chapters").select("title_key").gte("updated_time", cutoff).execute()
                _rc_keys = {r.get("title_key") for r in (_rc.data or []) if r.get("title_key")}
                keep = _wl_keys | _rc_keys
                q = _sb.table("series_meta").select("title_key").lt("updated_at", cutoff).execute()
                to_del = [r.get("title_key") for r in (q.data or []) if r.get("title_key") and r.get("title_key") not in keep]
                if to_del:
                    _sb.table("series_meta").delete().in_("title_key", to_del).execute()
                    logger.info("retention: pruned series_meta", deleted=len(to_del), days=_SERIES_META_RETENTION_DAYS)
            except Exception as e:
                logger.warning("retention: series_meta cleanup failed", exc_info=e)
            try:
                import time as _t2
                if _t2.time() - _last_whitelist_prune > 86400:
                    from app.storage.whitelist import auto_cleanup_stale_whitelist
                    _r = auto_cleanup_stale_whitelist(days=30)
                    if _r.get("removed"):
                        logger.info("retention: pruned stale whitelist", removed=_r.get("removed"), days=30)
                    _last_whitelist_prune = _t2.time()
            except Exception as e:
                logger.warning("retention: whitelist 30d cleanup failed", exc_info=e)
            try:
                _rc_cutoff = (datetime.now(timezone.utc) - timedelta(days=_RECENT_CHAPTERS_RETENTION_DAYS)).isoformat()
                _pruned_rc = _sb.table("recent_chapters").delete().lt("updated_time", _rc_cutoff).execute()
                _rc_count = len(_pruned_rc.data) if _pruned_rc.data else 0
                if _rc_count:
                    logger.info("retention: pruned recent_chapters", deleted=_rc_count, days=_RECENT_CHAPTERS_RETENTION_DAYS)
            except Exception as e:
                logger.warning("retention: recent_chapters cleanup failed", exc_info=e)
        except Exception as e:
            logger.exception("retention prune failed")
        try:
            stop_event.wait(3600)
        except (KeyboardInterrupt, SystemExit):
            break
