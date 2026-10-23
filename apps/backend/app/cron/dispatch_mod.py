"""Discord dispatch + channel loading + failed-retry.

This module has been consolidated: heavy logic now lives in
app/services/dispatch_service.py and app/services/shared.py. The symbols
here remain exported for backward compatibility with existing call sites.

DB audit fix 4: dispatch_history has UNIQUE (title_key, source,
chapter_title) as dispatch_history_uq (042_db_audit_fix.sql) — race
guard for concurrent runners (different URLs, same chapter). dispatch_claims
is transient (FOR UPDATE SKIP LOCKED in app/services/claim.py); could be
UNLOGGED/dropped, here kept as short-TTL queue only. Duplicate
dispatch_history inserts (unique violation) are treated as already-sent.
"""
from __future__ import annotations

import html
import time

from app.discord import client as discord
from app.discord.embeds import build_chapter_embed
from app.config import settings
import json as _json
from app.logger import get_logger
from app.storage import dispatch as dispatch_store
from app.cron.enrich import _split_send_backfill, backfill_dispatch_history

logger = get_logger("cron:dispatch")

# Centralized FCFS — single source of truth (app/services/fcfs.py). Re-export for callers that import from dispatch_mod.
from app.services.fcfs import (  # noqa: F401
    claimed_fcfs_keys as _claimed_titles,
    fcfs_key,
    normalize_chapter as _norm_chapter,
    normalize_title,
)

def raw_channel_id() -> str:
    """The channel every NEW chapter is announced on.

    `RAW_DISCORD_CHANNEL_ID` in the deploy env; per-guild override wins (see
    guild_setting()). Empty everywhere ⇒ raw announcements are off and only
    whitelisted series notify, which is the previous behaviour.
    """
    return str(getattr(settings, "RAW_DISCORD_CHANNEL_ID", "") or "").strip()


def whitelist_channel_id() -> str:
    """The channel whitelisted series are announced on.

    `WHITELIST_DISCORD_CHANNEL_ID` in the deploy env. When it is unset the
    whitelist feed is off rather than aliased to the raw channel, so enabling
    raw cannot silently start notifying a channel that never asked for it.
    """
    return str(getattr(settings, "WHITELIST_DISCORD_CHANNEL_ID", "") or "").strip()


def _set_feed_channel(guild_id: str, channel_id: str, feed: str) -> None:
    """Persist one feed's channel for a guild into guild_settings.

    `feed` is "raw" or "whitelist". Written as its own column rather than
    derived from channel_id, because the two feeds are identified by the
    channel they point at and a channel can be pointed at twice.
    """
    from app.db import q

    col = "raw_channel_id" if feed == "raw" else "whitelist_channel_id"
    # The row may not exist yet — upsert on guild_id.
    q(
        f"""INSERT INTO guild_settings (guild_id, {col})
            VALUES (%s, %s)
            ON CONFLICT (guild_id) DO UPDATE SET {col} = EXCLUDED.{col}""",
        [guild_id, channel_id],
    )


def guild_setting(guild_id: str, feed: str) -> str:
    """The configured channel for one feed on one guild, env fallback included.

    Returns "" when neither the guild row nor the env has a channel for that
    feed. The env is the fallback so a single-server deploy needs no DB row,
    while a guild that set its own channel is not overridden by a later env
    change.
    """
    try:
        from app.db import q

        col = "raw_channel_id" if feed == "raw" else "whitelist_channel_id"
        rows = q(f"SELECT {col} FROM guild_settings WHERE guild_id = %s", [str(guild_id)])
        val = str((rows[0].get(col) if rows else "") or "").strip()
        if val:
            return val
    except Exception:
        pass
    return raw_channel_id() if feed == "raw" else whitelist_channel_id()


def split_dispatch_targets(
    channel_ids: list[str],
) -> tuple[list[str], list[str]]:
    """Partition a channel list into (raw, whitelist).

    Dispatch used to send every chapter to every channel in `guild_settings`.
    With a raw feed that is wrong: the raw channel would carry the
    "Add to whitelist" button AND the whitelist's own notifications, so a
    series would appear on both feeds the moment it was subscribed.

    A channel is raw when it is the configured raw channel for its guild
    (guild_setting(guild, "raw"), env fallback included). Everything else —
    the configured whitelist channel, the legacy channel_id, or a channel with
    no configuration at all — stays on the whitelist half, which is what it
    received before the split.

    A channel the env names as raw is also raw even with no guild row: that is
    the single-server case, and it must not depend on a guild_settings row
    existing.
    """
    raw: list[str] = []
    wl: list[str] = []
    guilds = load_guild_settings()
    for ch in channel_ids:
        c = str(ch).strip()
        if not c:
            continue
        # A raw destination must never be included in retry's whitelist list.
        # The previous implementation put every channel in wl as well as raw;
        # retry_failed_dispatches() then re-sent a failed subscribed chapter to
        # the RAW channel. Route each channel to exactly one feed instead.
        is_raw = c == raw_channel_id()
        for g in guilds:
            if str(g.get("guild_id") or "") and c == guild_setting(str(g["guild_id"]), "raw"):
                is_raw = True
                break
        target = raw if is_raw else wl
        if c not in target:
            target.append(c)
    return raw, wl


def load_chapter_ceilings(pairs: list[tuple[str, str]]) -> dict[tuple[str, str], float]:
    """Max already-dispatched chapter per (title_key, source), cross-source.

    Cross-source on purpose: the ceiling is "how far has this series already
    been notified", and a series is one series regardless of which site it was
    read from. Scoping it per source meant a brand new source started at zero,
    so when one re-uploaded old chapters with a fresh release_date (ch 23/24/25
    of a series already shipped through ch330 on shinigami) all of them passed
    the ceiling and were notified.

    Extracted from dispatch() so the loader is testable. It was not, and that
    is exactly how `_row[0]` on a RealDictRow survived: the KeyError was caught
    by a bare `except: pass`, so _ceilings stayed empty and this guard blocked
    nothing for as long as it existed.

    Returns {} on any DB problem — a missing ceiling must never stop dispatch,
    because FCFS still covers the already-notified case.
    """
    out: dict[tuple[str, str], float] = {}
    if not pairs:
        return out
    try:
        from app.db import get_conn, put_conn

        cc = get_conn()
        try:
            cur = cc.cursor()
            for tk, src in pairs:
                # NULLIF discards non-numeric labels; max() then ignores them,
                # matching the float() guard in the sanity check.
                cur.execute(
                    "SELECT max(NULLIF(trim(chapter_title), '')::numeric) AS max_ch "
                    "FROM dispatch_history WHERE title_key = %s",
                    (tk,),
                )
                row = cur.fetchone()
                # The pool uses RealDictCursor, so a row is a DICT. Read by
                # column name; isinstance keeps a tuple cursor working too.
                if row is None:
                    val = None
                elif isinstance(row, dict):
                    val = row.get("max_ch")
                else:
                    val = row[0]
                if val is not None:
                    out[(tk, src)] = float(val)
        finally:
            # Return the borrowed connection — get_conn() holds a semaphore
            # slot; dropping it without put_conn starves the pool.
            try:
                put_conn(cc)
            except Exception:
                pass
    except Exception:
        pass
    return out


def is_implausible_chapter(
    chapter: object, ceiling: float | None, batch_count: int
) -> bool:
    """True when a chapter number is a bad label rather than a release.

    Observed live: shinigami served chapter_number '26596' for a series whose
    real chapters are 1..266 (its own chapter list shows 26596 sitting beside
    265), and it was dispatched — spamming the channel AND poisoning the
    ceiling to 26596, which then blocks every real chapter after it.

    Two ways out, so a genuine renumbering is not silently lost:
      * <= 2000 -> accept. Covers a normal jump and, more usefully, rejects a
        date-as-number slip like 20261008.
      * > 2000 and arriving as a ~3-chapter burst within 50 of the ceiling ->
        accept, because a renumber legitimately emits 4000/4001/4002 together.
    """
    if ceiling is None:
        return False
    try:
        n = float(str(chapter or 0))
    except (ValueError, TypeError):
        return False
    if n <= 2000:
        return False
    is_renumber = (
        batch_count == 3
        and 0 < (n - ceiling) <= 50
        and str(chapter or "").strip().isdigit()
    )
    return not is_renumber


def dispatch(items: list[dict], channel_ids: list[str], instance_id: str, dry_run: bool = False, force: bool = False,
    guild_rows: list[dict] | None = None,
    skip_ceiling: bool = False,
    bypass_window: bool = False,
) -> int:
    """Send Discord embeds for whitelisted chapters.

    Dedupe: FCFS via fcfs_key (normalized title+chapter) in dispatch_history.
    No ceiling check needed — once a chapter is recorded, it's never re-sent.

    force=True -> skip the in-run claim guard (dispatch_claims) and the
    permanent URL guard. It does NOT skip the ceiling: the claimed path in
    pipeline.py sets force=True on every normal run, so tying the ceiling to
    force meant chapters below the ceiling were always notified.

    skip_ceiling=True is a separate, explicit escape hatch for a manual
    backfill or resend of a chapter that is genuinely below the ceiling.

    bypass_window=True treats every item as a real send, skipping the strict
    24h split. Without it a chapter older than 24h lands in to_backfill and
    only gets a silent ledger row -- no Discord post -- which is exactly why
    /dispatch/undelivered showed chapters for days and could never resend
    them. Only the manual resend path sets it.
    """
    if not getattr(settings, "DISCORD_ENABLED", True):
        logger.info("dispatch: skipped (DISCORD_ENABLED=false)")
        return 0
    if not items or not channel_ids:
        return 0
    if guild_rows is None:
        guild_rows = load_guild_settings()
    from app.utils.text import normalize_title_key, slugify_title_key

    if bypass_window:
        to_send, to_backfill = list(items), []
    else:
        to_send, to_backfill = _split_send_backfill(items)

    # Sort: ascending chapter per series for ordered Discord delivery
    import re as _re
    to_send.sort(key=lambda it: (
        it.get("title_key") or it.get("title") or "",
        (lambda m: float(m.group(1)) if m else float("inf"))(_re.search(r"(\d+(?:\.\d+)?)", str(it.get("chapter") or "")))
    ))

    # NOTE: No cross-source dedup here — FCFS dedup against dispatch_history
    # handles duplicates. Cross-source dedup (keeping only latest chapter per
    # title_key) is wrong: when ch.9-25 are already dispatched, dedup keeps
    # ch.25, FCFS filters it, and ch.7-8 never get sent.

    # Backfill HTML-backlog items silently. Skipped on dry_run: it writes to
    # dispatch_history, so a dry run would mutate the very state it is meant
    # to leave untouched, and the rows would then be skipped as "already
    # dispatched" by the real run.
    if to_backfill and not dry_run:
        bf_urls = [it.get("url") or it.get("chapter_url") for it in to_backfill if (it.get("url") or it.get("chapter_url"))]
        already = set()
        if bf_urls:
            from app.storage import dispatch as _ds
            already = _ds._already_dispatched(bf_urls)
        truly_new = [it for it in to_backfill if (it.get("url") or it.get("chapter_url")) not in already]
        if truly_new:
            bf = backfill_dispatch_history(truly_new, instance_id)
            logger.info("dispatch backfill (silent)", count=bf, skipped=len(to_backfill) - len(truly_new))

    if not to_send:
        logger.info("dispatch: nothing to send")
        return 0

    # CEILING: skip chapters at or below the max already-dispatched chapter
    # per (title_key, source). Prevents re-dispatching old chapters when
    # a higher chapter was already sent (e.g. 125 sent, 110 re-appears).
    #
    # The max MUST be computed numerically, not by text ordering. Postgres
    # orders '9' > '20' as text, so a series that had shipped through
    # ch.20 resolved to a ceiling of 9 (observed on
    # the-crimson-dragon-martial-emperor). Every chapter from 10..20 then
    # passed the ceiling check on every run. FCFS still skipped them
    # because they are in dispatch_history, so nothing was double-sent —
    # but the guard was doing nothing for exactly the series that needed
    # it. A non-numeric chapter_title (e.g. 'OVA') is ignored rather than
    # raising, so it can never become a bogus ceiling.
    _ceilings: dict[tuple[str, str], float] = {}
    # How many items this batch carries per title_key. A legitimate renumbering
    # arrives as a small burst (e.g. 4000/4001/4002 together); a lone absurd
    # number is a bad label. Read by the sanity guard below.
    _counts: dict[str, int] = {}
    # All fcfs_keys already in dispatch_history — used by the ceiling guard
    # to distinguish "already sent, skip" from "never sent, allow through".
    _sent_keys_global: set[str] = set()
    try:
        from app.db import get_supabase as _sb_g
        _rows_g = _sb_g().table("dispatch_history").select("fcfs_key").execute().data or []
        for _r in _rows_g:
            _fk = _r.get("fcfs_key")
            if _fk:
                _sent_keys_global.add(str(_fk))
    except Exception:
        pass
    for _it in to_send:
        _k = str(_it.get("title_key") or "").strip()
        if _k:
            _counts[_k] = _counts.get(_k, 0) + 1
    _ceilings = load_chapter_ceilings(
        list({
            (str(it.get("title_key") or "").strip(), str(it.get("source") or "").strip())
            for it in to_send
            if it.get("title_key") and it.get("source")
        })
    )

    # FCFS dedupe: skip chapters ALREADY NOTIFIED (in dispatch_history).
    # NOTE: we intentionally do NOT consult dispatch_claims here. The deep-queue
    # claim in pipeline.py (claim_recent_chapters_for_dispatch) and the
    # claim_and_record call below both write to dispatch_claims for THIS run —
    # if we treated those as "already sent" we'd skip every item we just claimed
    # and send nothing (the bug where cron ran forever with sent:0). dispatch_history
    # is the single source of truth for "actually notified".
    # HOWEVER, we MUST still check dispatch_history even when force=True —
    # force=True only bypasses the in-run claim guard (dispatch_claims),
    # not the permanent notification record. A previously-sent chapter must
    # never be re-notified even with force=True.
    # Same key builder as the ledger write below and as dispatch_watchdog.py:
    # title_key with dashes -> spaces. Using the display title here made the
    # in-run dedupe set disagree with dispatch_history, so a chapter already
    # in the ledger could pass the dedupe and be re-sent.
    _all_keys: list[str] = [
        fcfs_key(str(it.get("title_key") or "").replace("-", " "), it.get("chapter", ""))
        for it in to_send
        if it.get("url")
    ]
    if force:
        # Bypass ONLY dispatch_claims claim guard (already claimed in deep queue).
        # Still load claimed_keys from dispatch_history to prevent re-notifying
        # chapters already permanently recorded as sent.
        claimed_keys: set[str] = set()
        try:
            from app.db import get_supabase as _gs2
            _sb2 = _gs2()
            _uniq2 = list(set(k for k in _all_keys if k))
            if _uniq2:
                _rows2 = _sb2.table("dispatch_history").select("fcfs_key").in_("fcfs_key", _uniq2).execute().data or []
                claimed_keys = {r["fcfs_key"] for r in _rows2 if r.get("fcfs_key")}
        except Exception:
            claimed_keys = set()
    else:
        from app.db import get_supabase as _gs3
        try:
            _sb3 = _gs3()
            _uniq3 = list(set(k for k in _all_keys if k))
            claimed_keys = set()
            if _uniq3:
                _rows3 = _sb3.table("dispatch_history").select("fcfs_key").in_("fcfs_key", _uniq3).execute().data or []
                claimed_keys = {r["fcfs_key"] for r in _rows3 if r.get("fcfs_key")}
        except Exception:
            claimed_keys = set()

    # Permanent URL guard (skipped when force=True). Only consult dispatch_history
    # (actually-notified), NOT dispatch_claims — the latter holds THIS run's
    # transient claims and must not suppress sending.
    _all_urls = [it.get("url", "") for it in to_send if it.get("url")]
    _claimed_urls_set = set() if force else (dispatch_store._already_dispatched(_all_urls) if _all_urls else set())
    _legacy_pairs: set[tuple[str, str]] = set()
    try:
        from app.db import get_supabase as _gs_leg
        _tk_list = list({str(it.get("title_key") or "") for it in to_send if it.get("title_key")})
        if _tk_list:
            _rows_leg = _gs_leg().table("dispatch_history").select("title_key,chapter_title").in_("title_key", _tk_list).execute().data or []
            for _r in _rows_leg:
                _tkh = str(_r.get("title_key") or "")
                _cth = str(_r.get("chapter_title") or "")
                if _tkh and _cth:
                    _legacy_pairs.add((_tkh, _cth))
                    try:
                        _cnorm = ("%.10g" % float(_cth))
                        _legacy_pairs.add((_tkh, _cnorm))
                    except (ValueError, TypeError):
                        pass
    except Exception:
        _legacy_pairs = set()

    # Reject junk URLs that don't match known source patterns
    _vor_pub = getattr(settings, "VORATOON_PUBLIC_BASE", "https://v4.voratoon.com") or "https://v4.voratoon.com"
    _ikiru_pub = getattr(settings, "IKIRU_PUBLIC_BASE", "https://09.ikiru.wtf") or "https://09.ikiru.wtf"
    _VALID_URL_PREFIXES = (
        f"{settings.SHINIGAMI_PUBLIC_BASE}{settings.SHINIGAMI_CHAPTER_PATH}",
        _vor_pub,
        "https://v4.voratoon.com",
        "https://voratoon.com",
        _ikiru_pub,
    )
    _junk_urls = {u for u in _all_urls if not any(u.startswith(p) for p in _VALID_URL_PREFIXES)}
    if _junk_urls:
        logger.debug("dispatch: filtering junk urls", count=len(_junk_urls), examples=list(_junk_urls)[:3])
        to_send = [it for it in to_send if it.get("url") not in _junk_urls]

    # Claim once before channel loop (skipped when force=True — onboarding
    # must send even if the URL was already claimed in a prior run)
    if force:
        _acq_map = {u: True for u in _all_urls}
    else:
        _all_tks = [it.get("title_key", "") for it in to_send if it.get("url")]
        _all_srcs = [it.get("source", "") for it in to_send if it.get("url")]
        _all_chtitles = [it.get("chapter", "") for it in to_send if it.get("url")]
        acquired = dispatch_store.claim_and_record(
            _all_urls, _all_tks, _all_srcs, instance_id,
            chapter_titles=_all_chtitles, fcfs_keys=_all_keys,
        )
        _acq_map = {u: ok for u, ok in zip(_all_urls, acquired)}
    _sent_urls: set[str] = set()

    logger.info("dispatch: send-pass start", to_send=len(to_send), claimed_db=len(claimed_keys))

    # Build title_key+source -> meta map from series_meta (rating/description/genres/type/cover)
    # rss_service does sm_map > it > wl; dispatch was only using it.cover → rating jadi 0/No rating
    _sm_map: dict[tuple[str, str], dict] = {}
    _wl_cover_map: dict[tuple[str, str], str] = {}
    try:
        from app.db import get_supabase
        _sb = get_supabase()
        _tks = list({str(it.get("title_key") or "").strip() for it in to_send if it.get("title_key")})
        if _tks:
            for i in range(0, len(_tks), 100):
                chunk = _tks[i:i+100]
                _rows = _sb.table("series_meta").select("title_key, source, cover, rating, description, genres, type").in_("title_key", chunk).execute().data or []
                for _r in _rows:
                    _tk = str(_r.get("title_key") or "").strip()
                    _src = str(_r.get("source") or "").strip()
                    if _tk and _src:
                        _sm_map[(_tk, _src)] = _r
                        _c = str(_r.get("cover") or "").strip()
                        if _c:
                            _wl_cover_map[(_tk, _src)] = _c
        # fallback: if no tks matched (empty title_key), load all cover map like before
        if not _wl_cover_map:
            _sm_rows = _sb.table("series_meta").select("title_key, source, cover").execute().data or []
            for _w in _sm_rows:
                _c = str(_w.get("cover") or "").strip()
                _tk = str(_w.get("title_key") or "").strip()
                _src = str(_w.get("source") or "").strip()
                if _c and _tk:
                    _wl_cover_map[(_tk, _src)] = _c
    except Exception as _e:
        logger.warn("dispatch: series_meta map build failed", err=str(_e)[:120])

    sent = 0
    # Two feeds, two channel sets. `to_send` carries `subscribed` per item from
    # collect()/split_raw_and_whitelisted(); dispatch re-derives it here from
    # the same (title_key, source) rule so an item that arrived without the tag
    # is still routed correctly. See split_dispatch_targets().
    _raw_ch, _wl_ch = split_dispatch_targets(channel_ids)
    # Raw announcements are opt-in: with no raw channel configured every
    # channel is a whitelist channel, which is the previous single-feed
    # behaviour. Otherwise a raw feed would start publishing on a deployment
    # that never asked for it.
    _has_raw = bool(_raw_ch)
    try:
        from app.storage import whitelist as wl_store
        _wl_rows = wl_store.load_whitelist()
    except Exception:
        _wl_rows = []
    _wl_pairs = {
        (slugify_title_key(w.get("title_key", "")), str(w.get("source") or "").lower())
        for w in _wl_rows
    }
    for _it in to_send:
        _it_tk_r = slugify_title_key(str(_it.get("title_key") or ""))
        _it_src_r = str(_it.get("source") or "").lower()
        if _it_tk_r and (_it_tk_r, _it_src_r) in _wl_pairs:
            _it["subscribed"] = True
            continue
        if "subscribed" in _it:
            continue
        # Untagged item: treat it as WHITELISTED, i.e. as it was before the raw
        # feed existed. Two reasons, and both are about not breaking a running
        # deployment:
        #
        #   * With no raw channel configured every channel is a whitelist
        #     channel, so routing untagged items to raw would send NOTHING at
        #     all — the failure test_dispatch_keys.py caught exactly that.
        #   * A caller that never heard of the split (an API endpoint, a manual
        #     resend, a backfill) passes items straight through; those are the
        #     same items the whitelist filter used to admit.
        #
        # The only way an item lands on raw is the raw feed's own tagging, which
        # is split_raw_and_whitelisted()/pipeline.py.
        _it["subscribed"] = True

    for ch in channel_ids:
        _is_raw_ch = _has_raw and ch in _raw_ch
        # Raw channel: only items NOT whitelisted (every new chapter, minus the
        # ones that already have a whitelist feed). Whitelist channel: the
        # opposite set. Splitting here rather than upstream means one batch and
        # one claim serve both feeds — a second pass would have to re-claim the
        # same URLs and fight the claim guard.
        #
        # `subscribed == (not _is_raw_ch)`: raw ⇒ subscribed is False,
        # whitelist ⇒ subscribed is True. Written as an equality rather than
        # "!= _is_raw_ch" because the two read the same but only this one is
        # obviously symmetric — the inverted form silently routes every
        # whitelisted chapter to raw and every stray one to whitelist.
        _feed = [
            it for it in to_send
            if bool(it.get("subscribed")) == (not _is_raw_ch)
        ]
        if not _feed:
            logger.info("dispatch: feed empty", channel=ch, feed="raw" if _is_raw_ch else "whitelist")
            continue
        # Per-guild filters (multi-server). Falls back to empty filters when
        # the channel has no guild_settings row (e.g. explicit channel_ids arg).
        _gs_row = next((g for g in guild_rows if str(g.get("channel_id")) == str(ch)), {})
        _type_f = {t.strip().lower() for t in str(_gs_row.get("type_filter") or "").split(",") if t.strip()}
        _excl_titles = {slugify_title_key(t) for t in (_gs_row.get("excluded_titles") or []) if t}
        seen_key_run: set[str] = set()
        _consec_fail = 0
        for it in _feed:
            url = it.get("url", "")
            if not url or not _acq_map.get(url):
                continue
            # per-guild type filter (by manhwa/manga/manhua)
            if _type_f:
                _item_type = str(it.get("type") or "").strip().lower()
                if not _item_type or _item_type not in _type_f:
                    continue
            # per-guild excluded titles
            if _excl_titles and slugify_title_key(str(it.get("title_key") or it.get("title") or "")) in _excl_titles:
                continue
            # Ceiling: skip chapters at or below the max already-dispatched
            # chapter. Only skip_ceiling=True bypasses this — force does not,
            # because pipeline.py passes force=True on the ordinary claimed
            # path and the ceiling has to hold there. The cross-source re-upload
            # case is what makes this matter: one source re-uploaded ch 23/24/25 of a
            # series already shipped through ch 330 on shinigami, and per-source
            # ceilings started that source at 0 so every one of them was notified.
            _it_tk = str(it.get("title_key") or "").strip()
            _it_src = str(it.get("source") or "").strip()
            _ceil = None if skip_ceiling else _ceilings.get((_it_tk, _it_src))
            if _ceil is not None:
                try:
                    _it_ch = float(it.get("chapter") or "0")
                    if _it_ch <= _ceil:
                        # Ceiling blocks re-sends, not first-sends. If this
                        # chapter was never delivered (no dispatch_history
                        # row), let it through — otherwise a high chapter
                        # shipped earlier permanently blocks every lower
                        # chapter that was never sent.
                        _fk = fcfs_key(_it_tk.replace("-", " "), it.get("chapter"))
                        if _fk not in _sent_keys_global:
                            pass  # never sent — allow
                        else:
                            continue
                except (ValueError, TypeError):
                    pass
            # Sanity: a chapter number far above everything the series has
            # shipped is a bad label, not a release. See is_implausible_chapter
            # for the live 26596 case and why a renumber burst still passes.
            if not skip_ceiling and is_implausible_chapter(
                it.get("chapter"), _ceil, _counts.get(_it_tk, 0)
            ):
                # debug, not warn: the upstream keeps serving this label, so the
                # row is re-scraped every cycle and a warn would repeat forever
                # for a condition that is already handled. Live case: one series
                # logged this 8x in 6h for a single chapter. The fact is still
                # recorded — /incidents and the dispatch ledger show the chapter
                # as never-sent — so nothing is lost by not paging on it.
                logger.debug(
                    "dispatch: implausible chapter number, skipped",
                    title_key=_it_tk, source=_it_src,
                    chapter=str(it.get("chapter")), ceiling=_ceil,
                )
                continue
            norm = fcfs_key(str(it.get("title_key") or "").replace("-", " "), it.get("chapter", ""))
            if norm in claimed_keys or norm in seen_key_run or url in _claimed_urls_set:
                continue
            # legacy title_key#chapter fallback
            _tk_l = str(it.get("title_key") or "")
            _ch_l = str(it.get("chapter") or "")
            try:
                _ch_n = ("%.10g" % float(_ch_l)) if _ch_l else _ch_l
            except (ValueError, TypeError):
                _ch_n = _ch_l
            if (_tk_l, _ch_l) in _legacy_pairs or (_tk_l, _ch_n) in _legacy_pairs:
                continue
            seen_key_run.add(norm)

            # Merge static fields from series_meta (canonical) — rss_service does sm > it
            _tk = str(it.get("title_key") or "").strip()
            _src = str(it.get("source") or "").strip()
            _sm = _sm_map.get((_tk, _src), {})
            _cover = str(it.get("cover") or _sm.get("cover") or "").strip()
            if not _cover:
                _cover = _wl_cover_map.get((_tk, _src), "") or _wl_cover_map.get((_tk, ""), "")
            _rating = it.get("rating") if it.get("rating") not in (None, "", 0, "0", 0.0) else _sm.get("rating")
            _desc = it.get("description") or _sm.get("description") or ""
            _genres = it.get("genres") or _sm.get("genres") or []
            _type = it.get("type") or _sm.get("type") or ""

            # NOTE: We intentionally do NOT fetch the cover as a file attachment.
            # The gateway fallback path (used because this VPS IP is banned at
            # Discord's REST API) cannot upload files, and an embed authored with
            # `attachment://` thumbnails fails to render there. Instead we let
            # build_chapter_embed set a real thumbnail URL (now served by the
            # public /api/reader/cover-img proxy), which renders in BOTH the REST
            # and gateway paths.

            embed = build_chapter_embed(
                title=it.get("title", ""),
                chapter=it.get("chapter", ""),
                url=it.get("url", ""),
                series_url=it.get("series_url", ""),
                source=it.get("source", ""),
                cover=_cover,
                rating=str(_rating if _rating not in (None, "") else ""),
                genres=_genres,
                description=_desc,
                updated_time=it.get("updated_time", ""),
            )
            content = f"🔔 New Release on **{html.unescape(it.get('title', 'Unknown'))}** — Chapter {it.get('chapter', '?')}"
            # Raw feed only: the button is what makes a raw announcement
            # actionable. A whitelisted series gets the same notification on the
            # whitelist feed, where the button would be a no-op.
            _components = None
            if _is_raw_ch:
                from app.discord.embeds import add_whitelist_button
                _components = add_whitelist_button(
                    source=str(it.get("source") or ""),
                    title_key=str(it.get("title_key") or ""),
                    title=str(it.get("title") or ""),
                    series_url=str(it.get("series_url") or ""),
                ) or None
            if dry_run:
                sent += 1
                continue
            try:
                resp = discord.send_channel_message(channel_id=ch, content=content, embeds=[embed], components=_components)
                if resp is None:
                    _consec_fail += 1
                    logger.warn("dispatch: send returned None", title=(it.get("title") or "")[:40], consecutive=_consec_fail, channel=ch)
                    dispatch_store.unclaim(url)
                    if _consec_fail >= 3:
                        try:
                            dispatch_store.record_failed(
                                chapter_url=url, title_key=it.get("title_key", ""),
                                source=it.get("source", ""), chapter_title=str(it.get("chapter", "")),
                                chapter_number=None, error_message="gateway burst threshold (3 consecutive None)",
                                error_code="DISCORD_GATEWAY_BURST",
                            )
                        except Exception:
                            pass
                        logger.error("dispatch: burst threshold hit, stopping channel", channel=ch)
                        time.sleep(0.8)
                        break
                    time.sleep(0.8)
                    continue
                _consec_fail = 0
                sent += 1
                _sent_urls.add(url)
                try:
                    from app.metrics_prometheus import track_dispatch
                    track_dispatch(source=it.get("source", "unknown"), status="sent", duration=0.8)
                except Exception:
                    pass
                # Outbound webhook (external integrations) — async, never blocks
                try:
                    from app.cron.outbound_webhook import fire_chapter_released
                    fire_chapter_released(it)
                except Exception:
                    pass
                # Telegram notification — async, never blocks
                try:
                    from app.cron.telegram_notifier import notify_chapter
                    notify_chapter(it)
                except Exception:
                    pass
                time.sleep(0.8)
            except Exception as derr:
                _consec_fail += 1
                try:
                    from app.metrics_prometheus import track_dispatch_error
                    track_dispatch_error(error_type=type(derr).__name__)
                except Exception:
                    pass
                dispatch_store.record_failed(
                    chapter_url=url, title_key=it.get("title_key", ""),
                    source=it.get("source", ""), chapter_title=str(it.get("chapter", "")),
                    chapter_number=None, error_message=str(derr)[:500],
                    error_code="DISCORD_SEND_FAILED",
                )
                dispatch_store.unclaim(url)
                if _consec_fail >= 3:
                    logger.error("dispatch: burst threshold hit (exception), stopping channel", channel=ch, consecutive=_consec_fail)
                    time.sleep(0.8)
                    break
                time.sleep(0.8)

    # Post-loop: flush dispatch_history + update whitelist markers
    # claim queue is FOR UPDATE SKIP LOCKED in app/services/claim.py — dispatch_claims is transient
    if _sent_urls and not dry_run:
        try:
            from app.storage import dispatch as _ds_flush
            _by_url = {it.get("url", ""): it for it in to_send if it.get("url")}
            _cover_by_url = {}
            for _it in to_send:
                _u = _it.get("url", "")
                if _u in _sent_urls:
                    # Recompute cover for this URL
                    _c = str(_it.get("cover") or "").strip()
                    if not _c:
                        _tk = str(_it.get("title_key") or "").strip()
                        _src = str(_it.get("source") or "").strip()
                        _c = _wl_cover_map.get((_tk, _src), "") or _wl_cover_map.get((_tk, ""), "")
                    _cover_by_url[_u] = _c
            for _u in _sent_urls:
                _it = _by_url.get(_u)
                if not _it:
                    continue
                # fcfs_key MUST be built from title_key (dashes), not the display
                # title. normalize_title() strips punctuation and uses spaces, so
                # display title "The Margrave's Worthless Mage" yields
                # "the margrave s worthless mage#31" while the watchdog
                # (dispatch_watchdog.py) builds from title_key and gets
                # "the-margrave-s-worthless-mage#31" — different keys, so chapters
                # get delivered but the watchdog reports them undelivered forever.
                # title_key -> spaces is the same input the watchdog uses.
                _norm = fcfs_key(str(_it.get("title_key") or "").replace("-", " "), _it.get("chapter", ""))
                try:
                    _ds_flush.complete_dispatch_claim(
                        chapter_url=_u, duplicate_url=None, instance_id=instance_id,
                        title_key=_it.get("title_key", ""), source=_it.get("source", ""),
                        fcfs_key=_norm, chapter_title=_it.get("chapter", ""),
                        cover=_cover_by_url.get(_u, ""), series_url=_it.get("series_url", "") or "",
                    )
                except Exception as _e_dup:
                    _msg = str(_e_dup).lower()
                    if "dispatch_history_uq" in _msg or "unique" in _msg or "duplicate" in _msg:
                        logger.info("dispatch: history duplicate skip (race)", url=_u[:60], err=str(_e_dup)[:120])
                        continue
                    logger.warn("dispatch: complete_claim failed", url=_u[:60], err=str(_e_dup)[:160])
                    continue
                # Update whitelist marker so gap detector doesn't false-positive
                try:
                    from app.services.dispatch_service import dispatch_service
                    _cn = float(_it.get("chapter", 0) or 0)
                    dispatch_service.update_latest_sent_chapter(
                        _it.get("title_key", ""), _it.get("source", ""), _cn
                    )
                except Exception:
                    pass
        except Exception as e:
            logger.warn("dispatch_history flush failed", err=str(e)[:160])

    logger.info("dispatch: send-pass done", sent=sent, dry_run=dry_run)
    if sent and not dry_run:
        try:
            from app.services.audit import log_action, AuditAction
            log_action(AuditAction.DISPATCH, resource="dispatch", resource_id=f"{instance_id}", metadata={"sent": sent, "channels": len(channel_ids)})
        except Exception:
            pass
    return sent

def _load_channels() -> list[str]:
    """Every channel dispatch should consider, one guild's feeds included.

    Used to return only `channel_id` with `.limit(1)` — the legacy single feed.
    With two feeds that silently drops the raw channel: a guild that ran
    /setrawchannel had a raw_channel_id row, and dispatch never saw it, so the
    raw feed never sent anything. The raw channel is what carries the
    "Add to whitelist" button, so this was the whole feature missing.

    Returns the de-duplicated union of channel_id, raw_channel_id and
    whitelist_channel_id. `channel_id` stays in the list so a guild that never
    configured either feed keeps getting its whitelist notifications.
    """
    try:
        from app.db import get_supabase

        res = (
            get_supabase()
            .table("guild_settings")
            .select("channel_id, raw_channel_id, whitelist_channel_id")
            .execute()
        )
        out: list[str] = []
        for r in res.data or []:
            for key in ("channel_id", "raw_channel_id", "whitelist_channel_id"):
                c = str(r.get(key) or "").strip()
                if c and c not in out:
                    out.append(c)
        return out
    except Exception:
        return []

def load_guild_settings() -> list[dict]:
    """Full per-guild rows: channel_id, type_filter, excluded_titles, label."""
    try:
        from app.db import get_supabase

        res = (
            get_supabase()
            .table("guild_settings")
            .select("guild_id, channel_id, type_filter, label")
            .execute()
        )
        rows = [r for r in (res.data or []) if r.get("channel_id")]
        # normalize missing optional cols
        for r in rows:
            r.setdefault("excluded_titles", [])
            r.setdefault("label", "")
        return rows
    except Exception:
        return []

_GUILD_NAME_CACHE: dict[str, tuple[float, str]] = {}
_GUILD_NAME_TTL = 3600  # 1h

def _guild_name(guild_id: str) -> str:
    """Fetch guild name via bot token (Discord API), 1h cache."""
    import time as _time
    cached = _GUILD_NAME_CACHE.get(guild_id)
    if cached and (_time.monotonic() - cached[0]) < _GUILD_NAME_TTL:
        return cached[1]
    token = getattr(settings, "DISCORD_BOT_TOKEN", "") or ""
    if not token:
        return ""
    import urllib.request
    req = urllib.request.Request(
        f"https://discord.com/api/v10/guilds/{guild_id}",
        headers={"Authorization": f"Bot {token}", "User-Agent": "manhwa-backend/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = _json.loads(r.read())
            name = str(data.get("name") or "")
            _GUILD_NAME_CACHE[guild_id] = (_time.monotonic(), name)
            return name
    except Exception:
        return ""
