"""Internal health watchdog for the scanner itself.

Runs from the in-process scheduler (see app.tasks.scheduler) on its own
interval, alongside dispatch-alert and gap-detect.

This exists because gap_detector only compares chapter NUMBERS: it can see
chapters that never reached recent_chapters, but it is blind to the failure
mode that actually loses notifications — the chapter is in recent_chapters,
inside the collect window, still deliverable, but never made it into
dispatch_history because dispatch was slow or starved. Those age out of the
window and disappear with no trace.

Ages are deliberately excluded from the alerting decision here. The agreed
policy is a 24h collect window, so a chapter older than that is out of scope
by design, not a loss. Alerting on aged-out rows would fire forever and train
us to ignore the output. What we alert on is a chapter that is still
recoverable and is not being delivered.
"""

from __future__ import annotations

import time
from typing import Any

from app.config import settings
from app.db import get_conn, put_conn
from app.logger import get_logger

logger = get_logger("watchdog")

# A chapter older than this inside the window is not a fresh blip, it means
# dispatch has been failing for a long time and is worth waking someone for.
_URGENT_AGE_H = 12

# Dispatch runs every 2 minutes and the watchdog every 15, so the two
# inevitably interleave: a chapter that landed seconds ago is always briefly
# "stalled" before its own cycle picks it up. That is normal queueing, not a
# fault, and alerting on it trains us to ignore the output.
#
# Discord notification is therefore off. The numbers are still logged at warn
# level and still surfaced by GET /api/v1/watchdog, so the state stays
# inspectable without paging anyone. Flip this to notify again only alongside
# an age floor well past one dispatch cycle, otherwise the same false alarm
# comes straight back.
_SEND_ALERTS = False


def _stalled_chapters(age_hours: float) -> list[dict[str, Any]]:
    """Whitelisted chapters inside the window that were never dispatched.

    Two dedup rules are applied, matching dispatch exactly, because anything
    looser reports chapters that were correctly skipped:

    1. (title_key, source, chapter_title) in dispatch_history — the direct
       record of "this exact chapter of this exact source was sent".

    2. fcfs_key in dispatch_history — the cross-source rule. fcfs_key is
       built from the display title and deliberately excludes the source, so
       a chapter that already shipped from one source is considered
       delivered even when a second source later surfaces the same chapter.
       Without this, every chapter that shipped on shinigami is reported as
       stalled forever, because the second row has a different
       chapter_url and rule 1 cannot see it.
    """
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            select rc.source,
                   rc.title,
                   rc.title_key,
                   rc.chapter,
                   extract(epoch from (now() - rc.release_date)) / 3600.0 as age_h
            from recent_chapters rc
            join whitelist w
              on w.title_key = rc.title_key and w.source = rc.source
            where rc.release_date >= now() - make_interval(hours => %s)
              and not exists (
                    select 1 from dispatch_history dh
                    where dh.title_key = rc.title_key
                      and dh.source = rc.source
                      and dh.chapter_title = rc.chapter
              )
            order by rc.release_date asc
            """,
            (age_hours,),
        )
        # The shared cursor yields RealDictRow (mapping access), not tuples.
        rows = cur.fetchall()
    finally:
        put_conn(conn)

    # Cross-source dedup in Python, not SQL: fcfs_key() is slugify_title_key()
    # plus a normalized chapter token, and slugify_title_key is Python-only.
    # SQL has no equivalent, so the candidate set is narrowed there and the
    # exact key is applied here. The candidate set is small (only chapters
    # inside the window that are not a direct history hit), so this is cheap.
    if not rows:
        return []
    from app.services.fcfs import fcfs_key

    keys = [fcfs_key(r.get("title") or "", r.get("chapter") or "") for r in rows]
    delivered: set[str] = set()
    uniq = list(dict.fromkeys(k for k in keys if k))
    if uniq:
        try:
            conn = get_conn()
            try:
                cur = conn.cursor()
                cur.execute("select fcfs_key from dispatch_history where fcfs_key = any(%s)", (uniq,))
                delivered = {r.get("fcfs_key") for r in cur.fetchall() if r.get("fcfs_key")}
            finally:
                put_conn(conn)
        except Exception as exc:
            # Fail open: without the cross-source filter we would over-report,
            # which is noisy but never hides a real loss.
            logger.warn("watchdog: fcfs cross-source lookup failed", error=str(exc)[:120])

    out: list[dict[str, Any]] = []
    for r, k in zip(rows, keys):
        if k and k in delivered:
            continue
        out.append(
            {
                "source": r.get("source"),
                "title_key": r.get("title_key"),
                "chapter": r.get("chapter"),
                "age_h": float(r.get("age_h") or 0),
            }
        )
    return out


def _aged_out_count(lookback_hours: float) -> int:
    """Chapters already past the window and therefore unrecoverable.

    Reported, not alerted: the 24h policy is the agreed tradeoff, so these
    are a number to trend rather than a page to answer.

    The exact (title_key, source, chapter) exclusion below only proves the
    row was not sent by *that* source. A chapter delivered through the other
    source for the same series is already dispatched as far as the user is
    concerned, so the candidates are re-checked against the shared fcfs_key
    in Python, exactly like _stalled_candidates(). Without this the count
    was 13 when the true number of lost chapters was 0.
    """
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            select rc.title, rc.chapter
            from recent_chapters rc
            join whitelist w
              on w.title_key = rc.title_key and w.source = rc.source
            where rc.release_date < now() - interval '24 hours'
              and rc.release_date >= now() - make_interval(hours => %s)
              and not exists (
                    select 1 from dispatch_history dh
                    where dh.title_key = rc.title_key
                      and dh.source = rc.source
                      and dh.chapter_title = rc.chapter
              )
            """,
            (lookback_hours,),
        )
        rows = cur.fetchall()
    finally:
        put_conn(conn)

    if not rows:
        return 0

    from app.services.fcfs import fcfs_key

    keys = [fcfs_key(r.get("title") or "", r.get("chapter") or "") for r in rows]
    uniq = list(dict.fromkeys(k for k in keys if k))
    if not uniq:
        return 0
    try:
        conn = get_conn()
        try:
            cur = conn.cursor()
            cur.execute("select fcfs_key from dispatch_history where fcfs_key = any(%s)", (uniq,))
            delivered = {r.get("fcfs_key") for r in cur.fetchall() if r.get("fcfs_key")}
        finally:
            put_conn(conn)
    except Exception as exc:
        # Fail open: over-reporting is noisy, hiding a real loss is not.
        logger.warn("watchdog: aged_out fcfs lookup failed", error=str(exc)[:120])
        return len(rows)
    return sum(1 for k in keys if k not in delivered)


def _dispatch_health() -> dict[str, Any]:
    """Queue + claim state, so a stuck worker is visible before it starves."""
    from app.tasks.queue import CRON_PROCESSING_KEY, CRON_QUEUE_KEY, _get_redis

    try:
        r = _get_redis()
        depth = int(r.llen(CRON_QUEUE_KEY))
        processing = int(r.llen(CRON_PROCESSING_KEY))
    except Exception as exc:  # Redis down is itself worth reporting
        logger.warn("watchdog: redis unavailable", error=str(exc))
        return {"queue": -1, "processing": -1, "claims": -1}

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("select count(*) as n from dispatch_claims")
        claims = int(cur.fetchone()["n"])
    finally:
        put_conn(conn)

    return {"queue": depth, "processing": processing, "claims": claims}


def snapshot(window_hours: int = 24) -> dict[str, Any]:
    """Read-only health snapshot for the API. Never notifies, never raises.

    Separate from check_and_alert so the dashboard can poll it without
    spamming the alert channel.
    """
    out: dict[str, Any] = {"ok": True, "window_hours": window_hours}
    try:
        stalled = _stalled_chapters(window_hours)
        out.update(
            {
                "stalled": len(stalled),
                "urgent": sum(1 for c in stalled if c["age_h"] >= _URGENT_AGE_H),
                "aged_out": _aged_out_count(48),
                "oldest_stalled_h": round(max((c["age_h"] for c in stalled), default=0.0), 1),
                "chapters": stalled[:50],
                **_dispatch_health(),
            }
        )
    except Exception as exc:
        out["ok"] = False
        out["error"] = str(exc)
    return out


def check_and_alert() -> dict[str, Any]:
    """Entry point for the scheduler's watchdog action."""
    started = time.monotonic()
    stats: dict[str, Any] = {}

    try:
        stalled = _stalled_chapters(24)
        urgent = [c for c in stalled if c["age_h"] >= _URGENT_AGE_H]
        stats["stalled"] = len(stalled)
        stats["urgent"] = len(urgent)
        stats["aged_out"] = _aged_out_count(48)
        stats.update(_dispatch_health())

        if stalled:
            by_source: dict[str, int] = {}
            for c in stalled:
                by_source[c["source"] or "?"] = by_source.get(c["source"] or "?", 0) + 1
            # Observation, not an alarm. Most of these are chapters that landed
            # since the last dispatch cycle and are simply next in line.
            (logger.warn if urgent else logger.info)(
                "watchdog: whitelisted chapters inside the 24h window not yet dispatched",
                stalled=len(stalled),
                urgent=len(urgent),
                by_source=",".join(f"{k}:{v}" for k, v in sorted(by_source.items())),
                oldest_h=round(max(c["age_h"] for c in stalled), 1),
                queue=stats.get("queue"),
                processing=stats.get("processing"),
                claims=stats.get("claims"),
            )
            if _SEND_ALERTS:
                _notify(stalled, urgent, stats)
    except Exception as exc:
        # A failing watchdog must never take the scheduler down with it.
        logger.error("watchdog: check failed", error=str(exc))
        stats["error"] = str(exc)

    stats["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
    logger.info(
        "watchdog done",
        stalled=stats.get("stalled"),
        urgent=stats.get("urgent"),
        aged_out=stats.get("aged_out"),
        queue=stats.get("queue"),
        processing=stats.get("processing"),
        claims=stats.get("claims"),
        elapsed_ms=stats["elapsed_ms"],
    )
    return stats


def _notify(stalled: list[dict[str, Any]], urgent: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    """Send to the admin report channel; never raise into the scheduler."""
    try:
        cid = (settings.ADMIN_REPORT_CHANNEL_ID or "").strip()
        if not cid:
            from app.db import get_supabase

            res = get_supabase().table("guild_settings").select("channel_id").limit(1).execute()
            rws = res.data or []
            cid = str(rws[0]["channel_id"]) if rws and rws[0].get("channel_id") else ""
        if not cid:
            logger.warn("watchdog: no alert channel, skipping")
            return

        lines = [
            f"**{len(stalled)}** whitelisted chapter(s) inside the 24h window were never "
            f"dispatched (**{len(urgent)}** older than {_URGENT_AGE_H}h).",
        ]
        if stats.get("aged_out"):
            lines.append(
                f"Already past the window (24–48h, unrecoverable by design): **{stats['aged_out']}**"
            )
        lines.append(
            f"queue={stats.get('queue')} processing={stats.get('processing')} claims={stats.get('claims')}"
        )
        lines.append("")
        for c in urgent[:10]:
            lines.append(
                f"• `{c['source']}` {c['title_key']} — ch {c['chapter']} (waiting {round(c['age_h'], 1)}h)"
            )
        if len(stalled) > len(urgent[:10]):
            lines.append(f"… and {len(stalled) - len(urgent[:10])} more")

        from app.discord import client as discord_client

        discord_client.send_channel_message(cid, content="\n".join(lines))
        logger.warn("watchdog alert sent", stalled=len(stalled), urgent=len(urgent))
    except Exception as exc:
        logger.warn("watchdog: notification failed", error=str(exc))
