"""Dispatch storage: claim + history (parity with lib/services/storage/dispatch.ts)."""
from __future__ import annotations

from app.db import get_supabase
from app.logger import get_logger

logger = get_logger("storage:dispatch")


def _already_dispatched(urls: list[str]) -> set[str]:
    """Check dispatch_history for already-sent chapter URLs (parity batchCheckDispatchedChapters)."""
    if not urls:
        return set()
    try:
        res = (
            get_supabase()
            .table("dispatch_history")
            .select("chapter_url")
            .in_("chapter_url", urls)
            .execute()
        )
        return {r["chapter_url"] for r in (res.data or [])}
    except Exception as e:
        logger.error("check dispatch_history failed", exc=e)
        return set()


def _claimed_urls(urls: list[str]) -> set[str]:
    """URLs already claimed in dispatch_claims (non-expired)."""
    if not urls:
        return set()
    try:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        res = (
            get_supabase()
            .table("dispatch_claims")
            .select("chapter_url")
            .in_("chapter_url", urls)
            .gte("expires_at", now)
            .execute()
        )
        return {r["chapter_url"] for r in (res.data or [])}
    except Exception as e:
        logger.error("check dispatch_claims failed", exc=e)
        return set()


def _claimed_fcfs_keys(fcfs_keys: list[str]) -> set[str]:
    """Delegate to centralized FCFS service (app/services/fcfs.py)."""
    from app.services.fcfs import claimed_fcfs_keys as _cf

    return _cf(fcfs_keys)


def mark_claimed(urls: list[str], title_keys: list[str], expires_hours: int = 24) -> None:
    """Mark chapter URLs as claimed in dispatch_claims (with TTL).
    Used when adding a NEW whitelist entry: existing chapters shouldn't be
    re-notified. They auto-expire after `expires_hours`."""
    if not urls:
        return
    from datetime import datetime, timedelta, timezone
    expires = (datetime.now(timezone.utc) + timedelta(hours=expires_hours)).isoformat()
    rows = [
        {"chapter_url": u, "title_key": tk or "unknown", "expires_at": expires}
        for u, tk in zip(urls, title_keys)
        if u
    ]
    if not rows:
        return
    try:
        # upsert on conflict chapter_url to refresh expiry
        get_supabase().table("dispatch_claims").upsert(
            rows, on_conflict="chapter_url"
        ).execute()
    except Exception as e:
        logger.error("mark_claimed failed", exc=e)


def record_failed(
    chapter_url: str,
    title_key: str = "",
    source: str = "",
    chapter_title: str = "",
    chapter_number: float | None = None,
    error_message: str = "",
    error_code: str = "UNKNOWN",
) -> None:
    """Upsert a row in failed_dispatches keyed by chapter_url."""
    if not chapter_url:
        return
    from datetime import datetime, timezone
    try:
        sb = get_supabase()
        row = {
            "chapter_url": chapter_url,
            "title_key": title_key or "unknown",
            "source": source or "",
            "chapter_title": str(chapter_title or ""),
            "chapter_number": chapter_number,
            "error_message": str(error_message)[:500],
            "error_code": error_code,
            "status": "failed",
            "retry_count": 0,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        # Upsert on chapter_url — atomic, no race condition
        sb.table("failed_dispatches").upsert(
            row, on_conflict="chapter_url"
        ).execute()
    except Exception as e:
        logger.error("record_failed failed", exc=e)


def unclaim(chapter_url: str) -> None:
    """Remove a chapter_url from dispatch_history + dispatch_claims so it can be re-sent."""
    if not chapter_url:
        return
    try:
        get_supabase().table("dispatch_history").delete().eq("chapter_url", chapter_url).execute()
    except Exception as e:
        logger.error("unclaim dispatch_history failed", exc=e)
    try:
        get_supabase().table("dispatch_claims").delete().eq("chapter_url", chapter_url).execute()
    except Exception as e:
        logger.error("unclaim dispatch_claims failed", exc=e)


def unclaim_stale(cutoff_iso: str) -> int:
    """Delete dispatch_claims rows created before `cutoff_iso` (ISO timestamp).

    Used by the pipeline to auto-release STUCK claims: a prior cron run may have
    claimed URLs then failed to send (Discord hiccup, bug), leaving active claims
    (48h TTL) that block all future retries. Claims older than the cutoff are
    presumed stuck and released so the next dispatch can re-acquire + send.

    Returns count deleted.
    """
    if not cutoff_iso:
        return 0
    try:
        res = (
            get_supabase()
            .table("dispatch_claims")
            .delete()
            .lt("created_at", cutoff_iso)
            .execute()
        )
        return len(res.data or [])
    except Exception as e:
        logger.error("unclaim_stale failed", exc=e)
        return 0


def claim_and_record(urls: list[str], title_keys: list[str], sources: list[str], instance_id: str, chapter_titles: list[str] | None = None, fcfs_keys: list[str] | None = None) -> list[bool]:
    """Atomic claim guard — returns which urls THIS run is allowed to send.

    IMPORTANT: this does NOT write to dispatch_history. It only records a
    short-TTL claim in dispatch_claims so concurrent runs don't double-send.
    The actual "notified" record (dispatch_history) is written by dispatch()
    ONLY for chapters that were successfully sent to Discord — keeping the
    user-facing 'Notified' view accurate (it shows what was actually sent,
    not every chapter the pipeline touched).

    Race-safety: pre-check dispatch_history (already notified) + dispatch_claims
    (claimed by a concurrent run, non-expired). If neither has the url (or
    fcfs_key, for URL-rotating sources), we claim it (upsert into
    dispatch_claims with a TTL) and return True. A url/fcfs already present in
    either returns False (skip).

    NOTE: the guard keys off BOTH chapter_url AND fcfs_key. shinigami/ikiru
    rotate chapter URLs every scrape, so URL-only dedupe misses cross-source /
    cross-run duplicates of the SAME title+chapter. fcfs_key = normalized
    title+chapter is stable across URL rotations, so we also skip when the
    fcfs_key was already notified (this is what actually prevents duplicate
    Discord notifications for the same release from two sources).
    """
    if not urls:
        return []
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    # Atomic pre-check in single transaction (one connection) to avoid race between check and claim.
    already: set[str] = set()
    fcfs_already: set[str] = set()
    _pre_conn = None
    try:
        from app.db import get_conn
        _pre_conn = get_conn()
        _cur = _pre_conn.cursor()
        if urls:
            ph = ",".join(["%s"] * len(urls))
            _cur.execute(f"SELECT chapter_url FROM dispatch_history WHERE chapter_url IN ({ph})", urls)
            already |= {r["chapter_url"] for r in _cur.fetchall()}
            _cur.execute(f"SELECT chapter_url FROM dispatch_claims WHERE chapter_url IN ({ph}) AND expires_at >= %s", urls + [now.isoformat()])
            already |= {r["chapter_url"] for r in _cur.fetchall()}
        if fcfs_keys:
            uniq = list(set([k for k in fcfs_keys if k]))
            if uniq:
                ph2 = ",".join(["%s"] * len(uniq))
                _cur.execute(f"SELECT fcfs_key FROM dispatch_history WHERE fcfs_key IN ({ph2})", uniq)
                fcfs_already |= {r["fcfs_key"] for r in _cur.fetchall() if r.get("fcfs_key")}
                _cur.execute(f"SELECT fcfs_key FROM dispatch_claims WHERE fcfs_key IN ({ph2})", uniq)
                fcfs_already |= {r["fcfs_key"] for r in _cur.fetchall() if r.get("fcfs_key")}
    except Exception as e:
        logger.error("claim atomic precheck failed", exc=e)
        if _pre_conn:
            try:
                _pre_conn.rollback()
            except Exception:
                pass

    result: list[bool] = []
    new_claims: list[dict] = []
    claimed_fk: set[str] = set()  # fcfs_keys this batch already granted
    expires = (now + timedelta(hours=2)).isoformat()
    for i, (u, tk, src) in enumerate(zip(urls, title_keys, sources)):
        if not u:
            result.append(False)
            continue
        fk = fcfs_keys[i] if fcfs_keys and i < len(fcfs_keys) else None
        if u in already or (fk and (fk in fcfs_already or fk in claimed_fk)):
            result.append(False)
            continue
        # claim it (short TTL so a genuinely-new chapter released later isn't
        # suppressed forever). Claim KEY = fcfs_key when available, so a
        # different source scraping the SAME title+chapter (different URL)
        # cannot claim it a second time -> no cross-source double-send.
        row = {"chapter_url": u, "title_key": tk or "unknown", "expires_at": expires}
        if fk:
            row["fcfs_key"] = fk
            claimed_fk.add(fk)
        new_claims.append(row)
        result.append(True)
    if new_claims:
        # Dedupe by fcfs_key
        seen_fk: set[str] = set()
        deduped = []
        for r in new_claims:
            k = r.get("fcfs_key")
            if k:
                if k in seen_fk:
                    continue
                seen_fk.add(k)
            deduped.append(r)
        with_fk = [r for r in deduped if r.get("fcfs_key")]
        without_fk = [r for r in deduped if not r.get("fcfs_key")]
        try:
            # Use the same _pre_conn for atomic claim insert (commit together with pre-check)
            if _pre_conn is not None:
                # _pre_conn already has transaction open from pre-check; do inserts then commit
                if with_fk:
                    # use INSERT ... ON CONFLICT via raw SQL to stay on same conn
                    for row in with_fk:
                        cols = list(row.keys())
                        vals = [row[c] for c in cols]
                        # Build INSERT ... ON CONFLICT (fcfs_key) DO UPDATE
                        placeholders = ", ".join(["%s"] * len(cols))
                        col_list = ", ".join(cols)
                        update_cols = [c for c in cols if c != "fcfs_key"]
                        if update_cols:
                            upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in update_cols)
                            sql = f"INSERT INTO dispatch_claims ({col_list}) VALUES ({placeholders}) ON CONFLICT (fcfs_key) DO UPDATE SET {upd}"
                        else:
                            sql = f"INSERT INTO dispatch_claims ({col_list}) VALUES ({placeholders}) ON CONFLICT (fcfs_key) DO NOTHING"
                        _cur.execute(sql, vals)
                if without_fk:
                    for row in without_fk:
                        cols = list(row.keys())
                        vals = [row[c] for c in cols]
                        placeholders = ", ".join(["%s"] * len(cols))
                        col_list = ", ".join(cols)
                        update_cols = [c for c in cols if c != "chapter_url"]
                        if update_cols:
                            upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in update_cols)
                            sql = f"INSERT INTO dispatch_claims ({col_list}) VALUES ({placeholders}) ON CONFLICT (chapter_url) DO UPDATE SET {upd}"
                        else:
                            sql = f"INSERT INTO dispatch_claims ({col_list}) VALUES ({placeholders}) ON CONFLICT (chapter_url) DO NOTHING"
                        _cur.execute(sql, vals)
                _pre_conn.commit()
            else:
                # Fallback to old path if pre_conn failed
                if with_fk:
                    get_supabase().table("dispatch_claims").upsert(with_fk, on_conflict="fcfs_key").execute()
                if without_fk:
                    get_supabase().table("dispatch_claims").upsert(without_fk, on_conflict="chapter_url").execute()
        except Exception as ins_err:
            logger.error("dispatch_claims upsert failed", exc=ins_err)
            if _pre_conn is not None:
                try:
                    _pre_conn.rollback()
                except Exception:
                    pass
        finally:
            if _pre_conn is not None:
                try:
                    from app.db import put_conn as _pc
                    _pc(_pre_conn)
                except Exception:
                    pass
                _pre_conn = None
    else:
        # No claims to insert, but need to close pre_conn transaction
        if _pre_conn is not None:
            try:
                _pre_conn.commit()
            except Exception:
                try:
                    _pre_conn.rollback()
                except Exception:
                    pass
            try:
                from app.db import put_conn as _pc2
                _pc2(_pre_conn)
            except Exception:
                pass
    return result


def complete_dispatch_claim(
    chapter_url: str, duplicate_url: str | None, instance_id: str, title_key: str = "", source: str = "", fcfs_key: str | None = None, chapter_title: str = "", cover: str = "", series_url: str = ""
) -> None:
    """Record sent chapter in dispatch_history (so next run skips it)
    AND remove the short-TTL claim from dispatch_claims so the
    queue-depth counter drops. Without this, dispatch_claims only
    grows (every claimed url stays forever) → Queue Depth shows
    stale "pending" forever even though the chapter was sent.

    `fcfs_key` (if provided) is persisted on the dispatch_history row so
    cross-run FCFS dedupe works: another source publishing the same
    title+chapter within 24h is skipped even after the dispatch_claims
    row (which this function deletes) is gone.

    `cover` / `series_url` (when available) are stored on the row so the
    dispatch-history UI can render the chapter card (cover + clickable
    series link) instead of an empty placeholder.
    """
    from datetime import datetime, timezone

    try:
        row = {
            "chapter_url": chapter_url,
            "title_key": title_key or "unknown",
            "source": source or None,
            "chapter_title": str(chapter_title or ""),
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }
        if cover:
            row["cover"] = cover
        if series_url:
            row["series_url"] = series_url
        if fcfs_key:
            row["fcfs_key"] = fcfs_key
        sb = get_supabase()
        # C2 FIX: Use upsert on_conflict=fcfs_key instead of DELETE+INSERT
        # to prevent duplicate rows when two concurrent runs target same fcfs_key
        if fcfs_key:
            sb.table("dispatch_history").upsert(
                row, on_conflict="fcfs_key"
            ).execute()
        else:
            sb.table("dispatch_history").insert(row).execute()
    except Exception as e:
        logger.error("complete_dispatch_claim history failed", exc=e)
    # Drop the claim so queue-depth reflects reality.
    try:
        get_supabase().table("dispatch_claims").delete().eq(
            "chapter_url", chapter_url
        ).execute()
    except Exception as e:
        logger.error("complete_dispatch_claim unclaim failed", exc=e)


def clean_orphan_dispatch_claims() -> int:
    """Reaper: delete dispatch_claims orphans where chapter_url no longer in recent_chapters (pruned 24h).
    Prevents claim table bloat → queue depth stale pending forever. Run daily via cron."""
    try:
        from app.db import q as _q
        # Use NOT EXISTS to handle NULLs and allow index on chapter_url
        rows = _q("DELETE FROM dispatch_claims WHERE NOT EXISTS (SELECT 1 FROM recent_chapters rc WHERE rc.chapter_url = dispatch_claims.chapter_url) RETURNING chapter_url", [])
        deleted = len(rows or [])
        if deleted:
            logger.info("clean_orphan_dispatch_claims done", deleted=deleted)
        return deleted
    except Exception as e:
        logger.error("clean_orphan_dispatch_claims failed", exc=e)
        return 0


# Re-export retry logic (lives in dispatch_retry.py)
from app.services.dispatch_retry import retry_failed_dispatches, MAX_RETRY_ATTEMPTS, RETRY_COOLDOWN_S

__all__ = [
    "_already_dispatched",
    "_claimed_urls",
    "_claimed_fcfs_keys",
    "mark_claimed",
    "record_failed",
    "unclaim",
    "unclaim_stale",
    "claim_and_record",
    "complete_dispatch_claim",
    "clean_orphan_dispatch_claims",
    "retry_failed_dispatches",
    "MAX_RETRY_ATTEMPTS",
    "RETRY_COOLDOWN_S",
]
