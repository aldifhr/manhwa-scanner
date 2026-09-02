"""Audit log — track all state-changing actions."""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from app.logger import get_logger

logger = get_logger("audit")


class AuditAction(str, Enum):
    """All auditable actions."""
    # Whitelist
    WHITELIST_ADD = "whitelist.add"
    WHITELIST_REMOVE = "whitelist.remove"
    WHITELIST_BULK_ADD = "whitelist.bulk_add"
    WHITELIST_IMPORT = "whitelist.import"
    WHITELIST_EXPORT = "whitelist.export"
    WHITELIST_CLEANUP = "whitelist.cleanup"

    # Exclude
    EXCLUDE_ADD = "exclude.add"
    EXCLUDE_REMOVE = "exclude.remove"
    EXCLUDE_BULK = "exclude.bulk"

    # Dispatch
    DISPATCH_SEND = "dispatch.send"
    DISPATCH_RETRY = "dispatch.retry"
    DISPATCH_FAIL = "dispatch.fail"

    # Settings
    SETTINGS_UPDATE = "settings.update"
    SETTINGS_RESET = "settings.reset"

    # Auth
    AUTH_LOGIN = "auth.login"
    AUTH_LOGOUT = "auth.logout"
    AUTH_FAILED = "auth.failed"

    # System
    SYSTEM_DEPLOY = "system.deploy"
    SYSTEM_BACKUP = "system.backup"
    SYSTEM_RESTORE = "system.restore"
    SYSTEM_RETENTION = "system.retention"


def log_action(
    action: AuditAction | str,
    actor: str = "system",
    target: str = "",
    details: dict | None = None,
    ip: str = "",
) -> None:
    """Log an audit action."""
    try:
        from app.db import q
        q("""
            INSERT INTO audit_log (action, actor, target, details, ip, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s, %s)
        """, [
            str(action),
            actor[:100],
            target[:200],
            json.dumps(details or {}),
            ip[:45],
            datetime.now(timezone.utc).isoformat(),
        ])
    except Exception as e:
        logger.error("audit log failed", exc=e, action=str(action))


def get_audit_log(
    limit: int = 100,
    offset: int = 0,
    action: str | None = None,
    actor: str | None = None,
    since: str | None = None,
) -> list[dict]:
    """Query audit log with filters."""
    from app.db import q
    sql = "SELECT * FROM audit_log WHERE 1=1"
    params = []

    if action:
        sql += " AND action = %s"
        params.append(action)
    if actor:
        sql += " AND actor = %s"
        params.append(actor)
    if since:
        sql += " AND created_at >= %s"
        params.append(since)

    sql += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
    params.extend([limit, offset])

    return q(sql, params)


def get_audit_stats(days: int = 7) -> dict:
    """Get audit statistics."""
    from app.db import q
    stats = q("""
        SELECT action, COUNT(*) as count
        FROM audit_log
        WHERE created_at >= NOW() - INTERVAL '%s days'
        GROUP BY action
        ORDER BY count DESC
    """, [days])
    return {s["action"]: s["count"] for s in stats}


import json  # noqa: E402 — needed for log_action
