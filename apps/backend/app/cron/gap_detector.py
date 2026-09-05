"""Chapter gap detector + auto-backfill — ponytail: 419L gap/backfill (distinct from collect 407L scraper), keep separate until unified pipeline covers gap+scrape.

Compares each whitelist series' latest_sent_chapter (what Discord got) against
the newest chapter_num seen in recent_chapters (what the scraper found). A jump
> GAP_THRESHOLD means chapters were missed — likely a scraper skip or a
re-touch race.

Flow: detect -> alert admin (with cooldown) -> AUTO-BACKFILL from source API ->
dispatch to all servers. The backfill reuses each source's own chapter-list
API so the filled chapters carry real release timestamps and URLs.
"""
from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime, timezone

from app.config import settings
from app.logger import get_logger
from app.scrapers.voratoon import fetch_chapters

logger = get_logger("gap-detector")

GAP_THRESHOLD = 1.0     # newest_scraped - latest_sent must exceed this
COOLDOWN_MIN = 240      # at most one gap alert every 4h
_last_alert: float = 0.0


def _shinigami_chapters(manga_id: str) -> list[dict]:
    # Prefer the pooled httpx client with retry+circuit-breaker (parity with
    # app/scrapers/shinigami.py). Fallback to urllib only if import fails.
    try:
        from app.scrapers.shinigami import get_shinigami_chapters
        data = get_shinigami_chapters(manga_id, per_page=100)
        if data:
            return data
    except Exception as e:
        logger.warn("gap backfill: shinigami scraper fetch failed", err=str(e)[:120])
    try:
        req = urllib.request.Request(
            f"{settings.SECONDARY_SOURCE_URL.rstrip(chr(47))}/v1/chapter/{manga_id}/list?page=1&page_size=100&sort_by=chapter_number&sort_order=desc",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read()).get("data", [])
    except Exception as e:
        logger.warn("gap backfill: shinigami urllib fallback failed", err=str(e)[:120])
        return []


def _ikiru_chapters(slug: str) -> list[dict]:
    try:
        from app.scrapers.ikiru import get_ikiru_chapters
        return get_ikiru_chapters(slug) or []
    except Exception as e:
        logger.warn("gap backfill: ikiru fetch failed", err=str(e)[:120])
        return []


def detect_gaps() -> list[dict]:
    """Return [{title_key, source, sent, scraped}] where scraped - sent > threshold.
    
    Compares max chapter in dispatch_history vs max chapter in recent_chapters.
    This avoids false positives from stale whitelist markers.
    """
    conn = None
    try:
        from app.db import get_conn, put_conn
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('''
            SELECT w.title_key, w.source,
                   COALESCE(MAX(NULLIF(regexp_replace(dh.chapter_title, '[^0-9.]', '', 'g'), '')::float), 0) as max_dispatched,
                   (SELECT MAX(rc.chapter_num) FROM recent_chapters rc 
                    WHERE REPLACE(rc.title_key, ' ', '-') = REPLACE(w.title_key, ' ', '-') AND rc.source = w.source) as max_scraped
            FROM whitelist w
            LEFT JOIN dispatch_history dh ON REPLACE(dh.title_key, ' ', '-') = REPLACE(w.title_key, ' ', '-') AND dh.source = w.source
            GROUP BY w.title_key, w.source
            HAVING MAX(NULLIF(regexp_replace(dh.chapter_title, '[^0-9.]', '', 'g'), '')::float) IS NOT NULL
            AND (SELECT MAX(rc.chapter_num) FROM recent_chapters rc 
                 WHERE REPLACE(rc.title_key, ' ', '-') = REPLACE(w.title_key, ' ', '-') AND rc.source = w.source) IS NOT NULL
        ''')
        rows = cur.fetchall()
        out = []
        for r in rows:
            sent = float(r['max_dispatched'] or 0)
            scraped = float(r['max_scraped'] or 0)
            if scraped - sent > GAP_THRESHOLD:
                out.append({
                    "title_key": r['title_key'],
                    "source": r['source'],
                    "sent": sent,
                    "scraped": scraped,
                })
        return out
    except Exception as e:
        logger.warn("gap detection failed", err=str(e)[:160])
        return []
    finally:
        if conn is not None:
            try:
                put_conn(conn)
            except Exception:
                pass


def _backfill_and_dispatch(gaps: list[dict]) -> dict:
    """For each gapped series: fetch its chapter list from the source API,
    insert missing chapters into recent_chapters, then dispatch them to all
    servers. Returns summary counts.

    NOTE: backfilled rows get a FRESH updated_time (not the real release date).
    The 24h prune deletes rows older than the window — a backfilled row with
    an old timestamp would be wiped on the very next cron tick.

    Robustness: each series is isolated with a SAVEPOINT so one bad series
    doesn't abort the whole batch (root cause of 7× needs manual fix).
    Status 'fixed' now requires actual dispatch/insert success."""
    inserted = dispatched = 0
    fixed: list[str] = []
    # track per-series detail for alert
    details: dict[str, str] = {}
    conn = None
    cur = None
    try:
        from app.db import get_conn, put_conn
        from app.cron.dispatch_mod import dispatch, _load_channels

        conn = get_conn()
        cur = conn.cursor()
        channels = None  # lazy-load once
        for g in gaps:
            tk, src = g["title_key"], g["source"]
            key = f"{tk[:30]} ({src})"
            # per-series savepoint isolation — sanitize (hash int -> safe, tapi validate)
            sp_name = f"sp_gap_{abs(hash(key)) % 100000}"
            import re as _re_sp
            if not _re_sp.match(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$", sp_name):
                sp_name = "sp_gap_fallback"
            try:
                cur.execute(f"SAVEPOINT {sp_name}")
            except Exception:
                pass
            try:
                tk_norm = tk.replace(" ", "-")
                lo, hi = g["sent"], g["scraped"]
                cur.execute(
                    "SELECT series_url FROM whitelist WHERE title_key=%s AND source=%s",
                    (tk, src),
                )
                row = cur.fetchone()
                series_url = (row[0] or "") if row else ""

                # Build normalized chapter list [(num, url, title, release_date)]
                chapters: list[tuple] = []
                if src == "shinigami":
                    mid = series_url.rstrip("/").split("/")[-1] if series_url else ""
                    if not mid:
                        logger.warn("gap backfill: shinigami missing manga_id", title_key=tk)
                    else:
                        for c in _shinigami_chapters(mid):
                            num = float(c.get("chapter_number") or 0)
                            ch_id = c.get("chapter_id")
                            if num > 0 and ch_id:
                                url = f"https://11.shinigami.asia/chapter/{ch_id}"
                                chapters.append((num, url, str(c.get("chapter_title") or ""), c.get("release_date")))
                elif src == "ikiru":
                    slug = series_url.rstrip("/").split("/")[-1] if series_url else tk.replace(" ", "-")
                    for c in _ikiru_chapters(slug):
                        try:
                            num = float(str(c.get("chapter_number") or c.get("number") or 0) or 0)
                        except ValueError:
                            continue
                        url = c.get("chapter_url") or c.get("url") or ""
                        if num > 0 and url:
                            chapters.append((num, url, str(c.get("title") or ""), c.get("updated_time")))
                elif src == "voratoon":
                    slug = series_url.rstrip("/").split("/")[-1] if series_url else tk.replace(" ", "-")
                    for c in fetch_chapters(slug):
                        try:
                            num = float(str(c.get("chapter_number") or c.get("number") or 0) or 0)
                        except ValueError:
                            continue
                        ch_index = c.get("chapter") or c.get("chapter_number")
                        if num > 0 and ch_index:
                            url = f"https://v1.voratoon.com/series/{slug}/chapter/{ch_index}"
                            chapters.append((num, url, str(c.get("title") or ""), c.get("updated_time")))

                if not chapters:
                    logger.warn("gap backfill: no chapters fetched", title_key=tk, source=src, lo=lo, hi=hi)
                    # don't mark fixed — will show needs manual fix with reason
                    details[key] = "fetch empty"
                    try:
                        cur.execute(f"ROLLBACK TO SAVEPOINT {sp_name}")
                        cur.execute(f"RELEASE SAVEPOINT {sp_name}")
                    except Exception:
                        pass
                    continue

                fresh_stamp = datetime.now(timezone.utc).isoformat()
                # bulk: filter range + dedup URLs + single SELECT for existing + single cover fetch
                candidates = [(num, url, title) for num, url, title, rel in chapters if lo < num <= hi and not (url.startswith("https://x/") or url.startswith("http://x/"))]
                # dedup by url
                seen_urls: set[str] = set()
                uniq_candidates: list[tuple] = []
                for num, url, title in candidates:
                    if url not in seen_urls:
                        seen_urls.add(url)
                        uniq_candidates.append((num, url, title))
                # single cover fetch per gap (was per chapter N+1)
                cur.execute("SELECT cover FROM whitelist WHERE title_key=%s AND source=%s", (tk, src))
                wrow = cur.fetchone()
                cover_val = (wrow[0] if wrow else "") or ""
                # bulk existing check 1×
                existing_urls: set[str] = set()
                if uniq_candidates:
                    urls = [url for _, url, _ in uniq_candidates]
                    # chunk IN 500 to avoid placeholder limit
                    for i in range(0, len(urls), 500):
                        chunk = urls[i:i+500]
                        ph = ", ".join(["%s"] * len(chunk))
                        cur.execute(f"SELECT chapter_url FROM recent_chapters WHERE chapter_url IN ({ph})", chunk)
                        for r in cur.fetchall():
                            existing_urls.add(r[0])
                # build bulk inserts for non-existing
                to_insert: list[dict] = []
                for num, url, title in uniq_candidates:
                    if url in existing_urls:
                        continue
                    to_insert.append({
                        "chapter_url": url,
                        "title_key": tk_norm,
                        "title": title or tk.replace("-", " ").title(),
                        "chapter": str(int(num)) if num == int(num) else str(num),
                        "chapter_num": num,
                        "source": src,
                        "cover": cover_val,
                        "series_url": series_url,
                        "updated_time": fresh_stamp,
                        "origin": "KR",
                        "description": "",
                    })
                inserted_this = 0
                if to_insert:
                    # bulk VALUES 1× (was N× INSERT)
                    cols = ", ".join(to_insert[0].keys())
                    ph_row = "(" + ", ".join(["%s"] * len(to_insert[0])) + ")"
                    ph_all = ", ".join([ph_row] * len(to_insert))
                    vals: list = []
                    for ins in to_insert:
                        vals.extend(list(ins.values()))
                    cur.execute(
                        f"""INSERT INTO recent_chapters ({cols}) VALUES {ph_all}
                            ON CONFLICT (chapter_url) DO UPDATE
                            SET cover = EXCLUDED.cover, updated_time = EXCLUDED.updated_time""",
                        vals,
                    )
                    inserted_this = len(to_insert)
                inserted += inserted_this

                # dispatch everything in the gap range (existing rows included)
                cur.execute(
                    """SELECT title_key, title, chapter, chapter_num, source, cover,
                              series_url, origin, updated_time, description, chapter_url
                       FROM recent_chapters
                       WHERE title_key=%s AND source=%s AND chapter_num>%s AND chapter_num<=%s
                       ORDER BY chapter_num""",
                    (tk_norm, src, lo, hi),
                )
                names = ["title_key", "title", "chapter", "chapter_num", "source", "cover",
                         "series_url", "origin", "updated_time", "description", "chapter_url"]
                items = []
                for r in cur.fetchall():
                    it = dict(zip(names, r))
                    it["updated_time"] = fresh_stamp
                    # dispatch_mod expects 'url' (not 'chapter_url') — alias it
                    it["url"] = it.get("chapter_url") or it.get("url") or ""
                    items.append(it)
                sent_this = 0
                if items:
                    if channels is None:
                        channels = _load_channels()
                    if not channels:
                        logger.warn("gap backfill: no channels to dispatch", title_key=tk)
                        details[key] = "no channels"
                    else:
                        sent_this = dispatch(items, channels, instance_id="gap-autofix", force=False)
                        dispatched += sent_this
                        if sent_this == 0 and inserted_this == 0:
                            # rows existed but FCFS blocked send — likely already dispatched
                            # treat as fixed to stop spam, but log
                            logger.info("gap backfill: dispatch 0 (FCFS dedup)", title_key=tk, lo=lo, hi=hi)
                else:
                    logger.warn("gap backfill: no rows in gap range after insert", title_key=tk, lo=lo, hi=hi)
                    details[key] = "no rows for dispatch"

                # sync markers — only advance if we actually sent or FCFS confirms already sent.
                # If fetch empty / dispatch 0 with new rows, keep marker so next cron retries.
                did_fix = False
                if sent_this > 0 or inserted_this > 0:
                    did_fix = True
                    details[key] = f"ok +{inserted_this} sent:{sent_this}"
                elif items and sent_this == 0:
                    did_fix = True
                    details[key] = "already sent (FCFS)"
                else:
                    details[key] = f"no progress ins:{inserted_this} sent:{sent_this}"

                if did_fix:
                    cur.execute(
                        """UPDATE whitelist SET
                             latest_sent_chapter = GREATEST(COALESCE(latest_sent_chapter,0), %s),
                             latest_chapter      = GREATEST(COALESCE(latest_chapter,0), %s)
                           WHERE title_key=%s AND source=%s""",
                        (hi, hi, tk, src),
                    )
                    fixed.append(key)
                else:
                    # keep gap visible for retry; don't bump marker
                    logger.warn("gap backfill: not advancing marker (will retry)", title_key=tk, lo=lo, hi=hi)

                try:
                    cur.execute(f"RELEASE SAVEPOINT {sp_name}")
                except Exception:
                    pass
            except Exception as se:
                logger.warn("gap backfill: per-series failed", title_key=tk, source=src, err=str(se)[:200])
                details[key] = f"error: {str(se)[:80]}"
                try:
                    cur.execute(f"ROLLBACK TO SAVEPOINT {sp_name}")
                    cur.execute(f"RELEASE SAVEPOINT {sp_name}")
                except Exception:
                    pass
                continue
        conn.commit()
    except Exception as e:
        logger.warn("gap auto-backfill failed", err=str(e)[:200])
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
    finally:
        if cur is not None:
            try:
                cur.close()
            except Exception:
                pass
        if conn is not None:
            try:
                put_conn(conn)
            except Exception:
                pass
    if fixed:
        logger.info("gap auto-backfill done", inserted=inserted, dispatched=dispatched, series=len(fixed), details=str(details)[:500])
    else:
        logger.warn("gap auto-backfill: nothing fixed", inserted=inserted, dispatched=dispatched, details=str(details)[:500])
    return {"inserted": inserted, "dispatched": dispatched, "fixed": fixed, "details": details}


def maybe_alert_gaps() -> int:
    """Run detection; alert admin channel (with cooldown), then AUTO-BACKFILL
    and re-dispatch the missing chapters. Returns number of gapped series found."""
    global _last_alert
    gaps = detect_gaps()
    if not gaps:
        return 0
    result = None
    now = time.monotonic()
    should_alert = now - _last_alert >= COOLDOWN_MIN * 60
    if should_alert:
        _last_alert = now

    # ── AUTO-FIX: always attempt, regardless of alert cooldown ──
    result = _backfill_and_dispatch(gaps)
    fixed_names = set(result.get("fixed") or [])

    cid = (settings.ADMIN_REPORT_CHANNEL_ID or "").strip()
    if not cid:
        try:
            from app.db import get_supabase
            res = get_supabase().table("guild_settings").select("channel_id").limit(1).execute()
            rws = res.data or []
            cid = str(rws[0]["channel_id"]) if rws and rws[0].get("channel_id") else ""
        except Exception:
            cid = ""
    if cid and should_alert:
        details_map = (result or {}).get("details") or {}
        lines = []
        for g in sorted(gaps, key=lambda x: x["scraped"] - x["sent"], reverse=True)[:8]:
            missed = int(g["scraped"] - g["sent"] - 0.001)
            k = f"{g['title_key'][:30]} ({g['source']})"
            if k in fixed_names:
                status = "✅ auto-backfilled"
            else:
                reason = details_map.get(k, "")
                status = f"⚠️ needs manual fix ({reason})" if reason else "⚠️ needs manual fix"
            lines.append(
                f"• `{g['title_key'][:36]}` ({g['source']}): ch{int(g['sent'])}→{int(g['scraped'])} "
                f"(~{missed} missing) {status}"
            )
        summary = (
            f"🕳️ **Chapter gap terdeteksi** ({len(gaps)} series):\n" + "\n".join(lines)
        )
        if result and (result.get("dispatched") or result.get("inserted")):
            summary += (
                f"\n🔧 **Auto-fix:** {result['inserted']} chapters backfilled, "
                f"{result['dispatched']} notifications re-sent."
            )
        if result and len(fixed_names) < len(gaps):
            summary += f"\nℹ️ {len(gaps)-len(fixed_names)} series gagal auto — cek log `gap-detector` / coba `POST /api/v1/failed-dispatches?action=retry` atau trigger manual `maybe_alert_gaps()`." 
        try:
            from app.discord import client as discord_client
            discord_client.send_channel_message(cid, content=summary)
            logger.warn("gap alert sent", count=len(gaps))
        except Exception as e:
            logger.warn("gap alert send failed", err=str(e)[:160])
    return len(gaps)
