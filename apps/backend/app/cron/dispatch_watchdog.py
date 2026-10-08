"""Dispatch starvation watchdog.

Answers two questions the existing alerts do not:

  1. Is dispatch RUNNING at all? A source alert covers "shinigami is failing",
     but not "the cron worker stopped" or "the queue wedged" — the July outage
     was exactly that: every source reported HEALTHY for 7 hours while no
     notification left the box, and it was only noticed by eye.

  2. Is anything ELIGIBLE but UNDELIVERED? Even a running dispatcher can drop a
     chapter (a claim held too long, a ledger write that failed). Comparing the
     eligible set against the FCFS ledger catches that regardless of cause.

Both are grounded in the same `fcfs_key` the dispatcher itself uses, so this
cannot disagree with the pipeline about what "sent" means. An earlier ad-hoc
check compared against a hand-rolled key and produced false positives — that
mistake is the reason this uses the real function.

Anti-spam: one alert per condition per cooldown window, tracked in Redis, and
the state resets as soon as the condition clears so the next genuine incident
still alerts.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.logger import get_logger

logger = get_logger("dispatch-watchdog")

# No successful dispatch for this long => something is wrong.
# The scheduler enqueues `update` every 120s, so 30 minutes is ~15 missed
# cycles: comfortably beyond a transient hiccup, well inside "the user would
# have noticed".
STARVE_AFTER_MIN = 30

# An eligible chapter older than this without a ledger entry is treated as
# dropped. The dispatcher runs every 2 minutes, so 60 is generous slack.
# Raised from 15 because a chapter that just entered the whitelist (e.g. user
# subscribes a new source) can take up to an hour to be picked up by the
# rotating walk — that is normal, not a failure.
UNDELIVERED_AFTER_MIN = 60

# Re-alert at most this often while a condition persists.
COOLDOWN_MIN = 60

_STATE_KEY = "beag:dispatch_watchdog:alerted"


def _redis():
    from app.tasks.queue import _get_redis

    return _get_redis()


def _alert_channel_id() -> str | None:
    """Explicit admin channel, else the chapter channel, so an alert lands
    somewhere even when ADMIN_REPORT_CHANNEL_ID is unset."""
    from app.config import settings

    cid = (settings.ADMIN_REPORT_CHANNEL_ID or "").strip()
    if cid:
        return cid
    try:
        from app.db import get_supabase

        res = get_supabase().table("guild_settings").select("channel_id").limit(1).execute()
        rows = res.data or []
        if rows and rows[0].get("channel_id"):
            return str(rows[0]["channel_id"])
    except Exception as e:
        logger.warn("alert channel lookup failed", err=str(e)[:120])
    return None


def _send(content: str) -> None:
    cid = _alert_channel_id()
    if cid:
        try:
            from app.discord import client as discord_client

            discord_client.send_channel_message(cid, content=content)
        except Exception as e:
            logger.warn("dispatch alert send failed", err=str(e)[:160])
    try:
        from app.cron.telegram_notifier import notify_text

        notify_text(content.replace("**", ""))
    except Exception:
        pass


def _should_alert(condition: str) -> bool:
    """True when this condition has not alerted inside the cooldown."""
    try:
        r = _redis()
        if r.get(f"{_STATE_KEY}:{condition}"):
            return False
        r.setex(f"{_STATE_KEY}:{condition}", COOLDOWN_MIN * 60, "1")
        return True
    except Exception:
        # Redis unavailable: prefer alerting (a duplicate beats a silent outage).
        return True


def _clear_alert_state(condition: str) -> None:
    """Drop the cooldown once the condition clears, so the NEXT incident alerts
    immediately instead of being suppressed by the previous one's window."""
    try:
        _redis().delete(f"{_STATE_KEY}:{condition}")
    except Exception:
        pass


def check_dispatch_starvation() -> dict:
    """Alert when dispatch has not succeeded recently, or chapters are stuck."""
    from app.db import get_conn, put_conn

    result = {"stalled_min": None, "undelivered": 0, "alerted": []}
    now = datetime.now(timezone.utc)

    # ── 1. is dispatch RUNNING? ──
    #
    # Liveness comes from cron_run_status (the pipeline's own heartbeat), NOT
    # from dispatch_history.sent_at. Using the ledger was wrong: sending
    # nothing is the normal state when no chapter is new, so "no send for 30
    # min" fired on a perfectly healthy system. The outage this is meant to
    # catch was the worker not running at all, which the heartbeat shows
    # directly.
    last_run = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT MAX(created_at) AS last FROM cron_run_status")
        row = cur.fetchone()
        last_run = (row or {}).get("last") if row else None
        put_conn(conn)
    except Exception as e:
        logger.warn("starvation check: heartbeat read failed", err=str(e)[:160])
        return result

    if last_run is None:
        # No heartbeat at all is a fresh install, not an outage.
        logger.debug("starvation check: no heartbeat yet, skipping")
        return result

    if last_run.tzinfo is None:
        last_run = last_run.replace(tzinfo=timezone.utc)
    stalled_min = (now - last_run).total_seconds() / 60
    result["stalled_min"] = round(stalled_min, 1)

    if stalled_min >= STARVE_AFTER_MIN:
        if _should_alert("starved"):
            _send(
                f"🔴 **Pipeline STOPPED** — no cron run for {stalled_min:.0f} min "
                f"(threshold {STARVE_AFTER_MIN}). Sources may still report healthy. "
                f"Check the cron worker and the queue."
            )
            logger.error("pipeline stalled", stalled_min=round(stalled_min, 1))
            result["alerted"].append("starved")
    else:
        _clear_alert_state("starved")

    # ── 2. eligible but undelivered ──
    # Same definition the dispatcher uses: a row whose (title_key, source) is
    # whitelisted, inside the freshness window, with no FCFS ledger entry.
    undelivered = 0
    oldest_min = 0.0
    try:
        from app.services.fcfs import fcfs_key

        conn = get_conn()
        cur = conn.cursor()
        cutoff = (now - timedelta(hours=24)).isoformat()
        cur.execute(
            """
            SELECT rc.title, rc.title_key, rc.chapter, rc.source, rc.release_date
            FROM recent_chapters rc
            JOIN whitelist w
              ON w.title_key = rc.title_key
             AND w.source = rc.source
            WHERE rc.release_date > %s
            """,
            (cutoff,),
        )
        rows = cur.fetchall() or []

        cur.execute("SELECT fcfs_key FROM dispatch_history WHERE fcfs_key IS NOT NULL")
        sent = {r["fcfs_key"] for r in (cur.fetchall() or []) if r.get("fcfs_key")}
        put_conn(conn)

        for r in rows:
            key = fcfs_key(r.get("title") or (r.get("title_key") or "").replace("-", " "), r.get("chapter"))
            if key in sent:
                continue
            # Skip chapters the dispatch sanity guard refuses. They are
            # whitelisted, inside the window, and have no ledger entry — exactly
            # this check's definition of "undelivered" — but dispatch will never
            # send them, so alerting on them pages the operator forever. Live:
            # shinigami serves chapter_number '26596' for a series whose real
            # chapters are 1..266. Rejected under BOTH batch shapes means no
            # future pass can deliver it; anything the guard could still send
            # stays reported.
            try:
                from app.cron.dispatch_mod import (
                    is_implausible_chapter,
                    load_chapter_ceilings,
                )

                _tk = str(r.get("title_key") or "").strip()
                _src = str(r.get("source") or "").strip()
                _ceil = load_chapter_ceilings([(_tk, _src)]).get((_tk, _src))
                if is_implausible_chapter(r.get("chapter"), _ceil, 1) and is_implausible_chapter(
                    r.get("chapter"), _ceil, 3
                ):
                    continue
            except Exception:
                pass  # fail open: over-reporting beats hiding a real loss
            rd = r.get("release_date")
            if rd is None:
                continue
            if rd.tzinfo is None:
                rd = rd.replace(tzinfo=timezone.utc)
            age_min = (now - rd).total_seconds() / 60
            if age_min >= UNDELIVERED_AFTER_MIN:
                undelivered += 1
                oldest_min = max(oldest_min, age_min)
    except Exception as e:
        logger.warn("starvation check: eligible query failed", err=str(e)[:160])

    result["undelivered"] = undelivered

    if undelivered > 0:
        if _should_alert("undelivered"):
            _send(
                f"⚠️ **{undelivered} chapter(s) eligible but UNDELIVERED** — "
                f"oldest {oldest_min:.0f} min. They are whitelisted and inside the "
                f"window with no dispatch record. Check the dispatch claim path."
            )
            logger.error("undelivered chapters", count=undelivered, oldest_min=round(oldest_min, 1))
            result["alerted"].append("undelivered")
    else:
        _clear_alert_state("undelivered")

    if not result["alerted"]:
        logger.info(
            "dispatch watchdog ok",
            stalled_min=result["stalled_min"],
            undelivered=undelivered,
        )
    return result
