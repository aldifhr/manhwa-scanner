"""Discord dispatch + channel loading + failed-retry.

This module has been consolidated: heavy logic now lives in
app/services/dispatch_service.py and app/services/shared.py. The symbols
here remain exported for backward compatibility with existing call sites.
"""
from __future__ import annotations

import html

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
    claimed_titles as _claimed_titles,
    fcfs_key,
    normalize_chapter as _norm_chapter,
    normalize_title,
)


def dispatch(items: list[dict], channel_ids: list[str], instance_id: str, dry_run: bool = False, force: bool = False, guild_rows: list[dict] | None = None) -> int:
    """Send Discord embeds for whitelisted chapters.

    Dedupe: FCFS via fcfs_key (normalized title+chapter) in dispatch_history.
    No ceiling check needed — once a chapter is recorded, it's never re-sent.

    force=True → skip the FCFS guard (used to bypass dedupe when an explicit
    re-send is required, e.g. manual backfill or operator-triggered resend).
    """
    if not items or not channel_ids:
        return 0
    if guild_rows is None:
        guild_rows = load_guild_settings()
    from app.utils.text import normalize_title_key as _normalize_title_key

    to_send, to_backfill = _split_send_backfill(items)

    # Sort: ascending chapter per series for ordered Discord delivery
    import re as _re
    to_send.sort(key=lambda it: (
        it.get("title_key") or it.get("title") or "",
        (lambda m: float(m.group(1)) if m else float("inf"))(_re.search(r"(\d+(?:\.\d+)?)", str(it.get("chapter") or "")))
    ))

    # Backfill HTML-backlog items silently
    if to_backfill:
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
    _all_keys: list[str] = [fcfs_key(it.get("title", ""), it.get("chapter", "")) for it in to_send if it.get("url")]
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
                ", ".join(["%s"] * len(_uniq3))
                _rows3 = _sb3.table("dispatch_history").select("fcfs_key").in_("fcfs_key", _uniq3).execute().data or []
                claimed_keys = {r["fcfs_key"] for r in _rows3 if r.get("fcfs_key")}
        except Exception:
            claimed_keys = set()

    # Permanent URL guard (skipped when force=True). Only consult dispatch_history
    # (actually-notified), NOT dispatch_claims — the latter holds THIS run's
    # transient claims and must not suppress sending.
    _all_urls = [it.get("url", "") for it in to_send if it.get("url")]
    _claimed_urls_set = set() if force else (dispatch_store._already_dispatched(_all_urls) if _all_urls else set())

    # Reject junk URLs that don't match known source patterns
    _VALID_URL_PREFIXES = ("https://11.shinigami.asia/chapter/", "https://v1.voratoon.com/series/", "https://07.ikiru.wtf/manga/")
    _junk_urls = {u for u in _all_urls if not any(u.startswith(p) for p in _VALID_URL_PREFIXES)}
    if _junk_urls:
        logger.warn("dispatch: filtering junk urls", count=len(_junk_urls), examples=list(_junk_urls)[:3])
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

    # Build a title_key+source -> cover map from the whitelist so we can
    # fall back to the whitelist cover when recent_chapters.cover is empty
    # (ikiru chapters frequently arrive without a cover in the scrape).
    _wl_cover_map: dict[tuple[str, str], str] = {}
    try:
        from app.db import get_supabase
        _sb = get_supabase()
        _wl_rows = _sb.table("whitelist").select("title_key, source, cover").execute().data or []
        for _w in _wl_rows:
            _c = str(_w.get("cover") or "").strip()
            _tk = str(_w.get("title_key") or "").strip()
            _src = str(_w.get("source") or "").strip()
            if _c and _tk:
                _wl_cover_map[(_tk, _src)] = _c
    except Exception as _e:
        logger.warn("dispatch: whitelist cover map build failed", err=str(_e)[:120])

    sent = 0
    for ch in channel_ids:
        # Per-guild filters (multi-server). Falls back to empty filters when
        # the channel has no guild_settings row (e.g. explicit channel_ids arg).
        _gs_row = next((g for g in guild_rows if str(g.get("channel_id")) == str(ch)), {})
        _origin_f = {o.strip().upper() for o in str(_gs_row.get("origin_filter") or "").split(",") if o.strip()}
        _excl_titles = {_normalize_title_key(t) for t in (_gs_row.get("excluded_titles") or []) if t}
        seen_key_run: set[str] = set()
        for it in to_send:
            url = it.get("url", "")
            if not url or not _acq_map.get(url):
                continue
            # per-guild origin filter
            if _origin_f and str(it.get("origin") or "").upper() not in _origin_f:
                continue
            # per-guild excluded titles
            if _excl_titles and _normalize_title_key(str(it.get("title_key") or it.get("title") or "")) in _excl_titles:
                continue
            norm = fcfs_key(it.get("title", ""), it.get("chapter", ""))
            if norm in claimed_keys or norm in seen_key_run or url in _claimed_urls_set:
                continue
            seen_key_run.add(norm)

            # Cover: prefer recent_chapters cover, fall back to whitelist cover.
            _cover = str(it.get("cover") or "").strip()
            if not _cover:
                _tk = str(it.get("title_key") or "").strip()
                _src = str(it.get("source") or "").strip()
                _cover = _wl_cover_map.get((_tk, _src), "") or _wl_cover_map.get((_tk, ""), "")

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
                rating=str(it.get("rating", "")),
                genres=it.get("genres", []),
                description=it.get("description", ""),
                updated_time=it.get("updated_time", ""),
            )
            content = f"🔔 New Release on **{html.unescape(it.get('title', 'Unknown'))}** — Chapter {it.get('chapter', '?')}"
            if dry_run:
                sent += 1
                continue
            try:
                resp = discord.send_channel_message(channel_id=ch, content=content, embeds=[embed])
                if resp is None:
                    logger.warn("dispatch: send returned None", title=it.get("title", "")[:40])
                    dispatch_store.unclaim(url)
                    import time as _time
                    _time.sleep(0.4)
                    continue
                sent += 1
                _sent_urls.add(url)
                # Outbound webhook (external integrations) — async, never blocks
                try:
                    from app.cron.outbound_webhook import fire_chapter_released
                    fire_chapter_released(it)
                except Exception:
                    pass
                import time as _time
                _time.sleep(0.4)
            except Exception as derr:
                dispatch_store.record_failed(
                    chapter_url=url, title_key=it.get("title_key", ""),
                    source=it.get("source", ""), chapter_title=str(it.get("chapter", "")),
                    chapter_number=None, error_message=str(derr)[:500],
                    error_code="DISCORD_SEND_FAILED",
                )
                dispatch_store.unclaim(url)

    # Post-loop: flush dispatch_history + update whitelist markers
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
                _norm = fcfs_key(_it.get("title", ""), _it.get("chapter", ""))
                _ds_flush.complete_dispatch_claim(
                    chapter_url=_u, duplicate_url=None, instance_id=instance_id,
                    title_key=_it.get("title_key", ""), source=_it.get("source", ""),
                    fcfs_key=_norm, chapter_title=_it.get("chapter", ""),
                    cover=_cover_by_url.get(_u, ""), series_url=_it.get("series_url", "") or "",
                )
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
    return sent


def _load_channels() -> list[str]:
    """Load target channels from guild_settings (simplified)."""
    try:
        from app.db import get_supabase

        res = (
            get_supabase()
            .table("guild_settings")
            .select("channel_id")
            .execute()
        )
        return [r["channel_id"] for r in (res.data or []) if r.get("channel_id")]
    except Exception:
        return []


def load_guild_settings() -> list[dict]:
    """Full per-guild rows: channel_id, origin_filter, excluded_titles, label."""
    try:
        from app.db import get_supabase

        res = (
            get_supabase()
            .table("guild_settings")
            .select("guild_id, channel_id, origin_filter, excluded_titles, label")
            .execute()
        )
        return [r for r in (res.data or []) if r.get("channel_id")]
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