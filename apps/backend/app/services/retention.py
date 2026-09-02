"""Data retention — auto-delete old records to prevent unbounded growth.

Retention policies:
- dispatch_history: 90 days
- chapter_clicks: 90 days
- failed_dispatches: 30 days (resolved/permanent)
- cron_run_status: 30 days
- dashboard_snapshot: keep latest only
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from app.logger import get_logger

logger = get_logger("retention")

# Retention periods (days)
RETENTION = {
    "dispatch_history": 90,
    "chapter_clicks": 90,
    "failed_dispatches": 30,
    "cron_run_status": 30,
}


def run_retention_cleanup() -> dict:
    """Run retention cleanup for all tables. Returns counts deleted."""
    from app.db import q
    
    results = {}
    now = datetime.now(timezone.utc)
    
    for table, days in RETENTION.items():
        cutoff = (now - timedelta(days=days)).isoformat()
        try:
            if table == "failed_dispatches":
                # Only delete resolved/permanent failures
                q(f"""
                    DELETE FROM {table}
                    WHERE status IN ('resolved', 'permanent_failure')
                      AND updated_at < %s
                """, [cutoff])
            else:
                q(f"DELETE FROM {table} WHERE created_at < %s", [cutoff])
            results[table] = "ok"
            logger.info(f"retention: {table} cleaned (cutoff: {cutoff})")
        except Exception as e:
            results[table] = f"error: {str(e)[:100]}"
            logger.error(f"retention: {table} cleanup failed", exc=e)
    
    # Dashboard snapshot: keep only latest
    try:
        q("""
            DELETE FROM dashboard_snapshot
            WHERE id NOT IN (SELECT id FROM dashboard_snapshot ORDER BY computed_at DESC LIMIT 1)
        """)
        results["dashboard_snapshot"] = "ok"
    except Exception as e:
        results["dashboard_snapshot"] = f"error: {str(e)[:100]}"
    
    return results
