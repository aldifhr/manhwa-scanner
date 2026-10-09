from __future__ import annotations

import logging
import threading

logger = logging.getLogger("tasks.retention")

_DISPATCH_HISTORY_RETENTION_DAYS = 3
_CRON_RUN_STATUS_RETENTION_DAYS = 7
_FAILED_DISPATCHES_RETENTION_DAYS = 7
# recent_chapters holds the working set the feed, gap-detection and enrichment
# all read. The feed itself only ever asks for 24h (every reader defaults to
# hours=24), so 3 days is headroom for the backfill/gap paths rather than a
# serving requirement.
#
# This used to be declared 7 here while lifecycle.py pruned at 72h, so the
# tighter of the two always won and this constant was a lie: raising it changed
# nothing. One definition now — lifecycle imports it.
_RECENT_CHAPTERS_RETENTION_DAYS = 3
_RETENTION_MAX_PER_SERIES = 500
_SERIES_META_RETENTION_DAYS = 14
# Audit is a compliance trail, not a log — keep it longer than the operational
# tables. It was the only table with NO policy at all, so it grew unbounded
# (2146 rows / 30 days at the time of writing). 30 days is enough to answer
# "who changed this" for anything recent, and the table has an index on
# created_at so the prune is cheap.
_AUDIT_LOG_RETENTION_DAYS = 30
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
                    logger.info("retention: cleaned stale dispatch_claims expired=%s null_created=%s", _stale_count, _null_count)
            except Exception as e:
                logger.warning("retention: stale claims cleanup failed", exc_info=e)
            try:
                from app.storage.error_logs import delete_older_than as _err_prune
                _pruned = _err_prune(days=7)
                if _pruned:
                    logger.info("retention: pruned error_logs deleted=%s days=7", _pruned)
            except Exception as e:
                logger.warning("retention: error_logs cleanup failed", exc_info=e)
            try:
                _audit_cutoff = (datetime.now(timezone.utc) - timedelta(days=_AUDIT_LOG_RETENTION_DAYS)).isoformat()
                _pruned_audit = _sb.table("audit_log").delete().lt("created_at", _audit_cutoff).execute()
                _audit_count = len(_pruned_audit.data) if _pruned_audit.data else 0
                if _audit_count:
                    logger.info("retention: pruned audit_log deleted=%s days=%s", _audit_count, _AUDIT_LOG_RETENTION_DAYS)
            except Exception as e:
                logger.warning("retention: audit_log cleanup failed", exc_info=e)
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
                    logger.info("retention: pruned series_meta deleted=%s days=%s", len(to_del), _SERIES_META_RETENTION_DAYS)
            except Exception as e:
                logger.warning("retention: series_meta cleanup failed", exc_info=e)
            try:
                import time as _t2
                if _t2.time() - _last_whitelist_prune > 86400:
                    from app.storage.whitelist import auto_cleanup_stale_whitelist
                    _r = auto_cleanup_stale_whitelist(days=30)
                    if _r.get("removed"):
                        logger.info("retention: pruned stale whitelist removed=%s days=30", _r.get("removed"))
                    _last_whitelist_prune = _t2.time()
            except Exception as e:
                logger.warning("retention: whitelist 30d cleanup failed", exc_info=e)
            try:
                _rc_cutoff = (datetime.now(timezone.utc) - timedelta(days=_RECENT_CHAPTERS_RETENTION_DAYS)).isoformat()
                _pruned_rc = _sb.table("recent_chapters").delete().lt("updated_time", _rc_cutoff).execute()
                _rc_count = len(_pruned_rc.data) if _pruned_rc.data else 0
                if _rc_count:
                    logger.info("retention: pruned recent_chapters deleted=%s days=%s", _rc_count, _RECENT_CHAPTERS_RETENTION_DAYS)
            except Exception as e:
                logger.warning("retention: recent_chapters cleanup failed", exc_info=e)
        except Exception as e:
            logger.exception("retention prune failed")
        try:
            stop_event.wait(3600)
        except (KeyboardInterrupt, SystemExit):
            break
