"""Chapter gap detector + auto-backfill.

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
    try:
        req = urllib.request.Request(
            f"{settings.SECONDARY_SOURCE_URL.rstrip(chr(47))}/v1/chapter/{manga_id}/list?page=1&page_size=100&sort_by=chapter_number&sort_order=desc",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read()).get("data", [])
    except Exception as e:
        logger.warn("gap backfill: shinigami fetch failed", err=str(e)[:120])
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
    an old timestamp would be wiped on the very next cron tick."""
    inserted = dispatched = 0
    fixed: list[str] = []
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
            # Normalize to slug form so backfilled rows match the scraper's
            # recent_chapters key (ikiru/voratoon use slug; shinigami uses
            # spaced, which REPLACE(' ','-') also produces). Whitelist lookups
            # below still use the raw tk (whitelist stores spaced keys).
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
                mid = series_url.rstrip("/").split("/")[-1]
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

            fresh_stamp = datetime.now(timezone.utc).isoformat()
            for num, url, title, rel in chapters:
                if not (lo < num <= hi):
                    continue
                # Skip junk/placeholder URLs
                if url.startswith("https://x/") or url.startswith("http://x/"):
                    continue
                cur.execute(
                    "SELECT 1 FROM recent_chapters WHERE chapter_url=%s",
                    (url,),
                )
                if cur.fetchone():
                    continue  # already indexed — just wasn't dispatched; force-send below anyway
                cur.execute("SELECT cover FROM whitelist WHERE title_key=%s AND source=%s", (tk, src))
                wrow = cur.fetchone()
                ins = {
                    "chapter_url": url,
                    "title_key": tk_norm,
                    "title": title or tk.replace("-", " ").title(),
                    "chapter": str(int(num)) if num == int(num) else str(num),
                    "chapter_num": num,
                    "source": src,
                    "cover": (wrow[0] if wrow else "") or "",
                    "series_url": series_url,
                    # FRESH timestamp, NOT the real release date: the 24h prune
                    # would delete a backfilled row with an old release date on
                    # the next cron tick (this exact bug wiped ch127-129).
                    "updated_time": fresh_stamp,
                    "origin": "KR",
                    "description": "",
                }
                cols = ", ".join(ins.keys())
                ph = ", ".join(["%s"] * len(ins))
                cur.execute(
                    f"""INSERT INTO recent_chapters ({cols}) VALUES ({ph})
                        ON CONFLICT (chapter_url) DO UPDATE
                        SET cover = EXCLUDED.cover, updated_time = EXCLUDED.updated_time""",
                    list(ins.values()),
                )
                inserted += 1

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
                # fresh timestamp: strict-24h window treats backfill as sendable now
                it["updated_time"] = fresh_stamp
                items.append(it)
            if items:
                if channels is None:
                    channels = _load_channels()
                # Do NOT use force=True — gap backfill must respect FCFS dedup
                # so we don't re-notify chapters already sent. force=True was
                # causing duplicate Discord notifications for the same chapter.
                sent = dispatch(items, channels, instance_id="gap-autofix", force=False)
                dispatched += sent

            # sync markers
            cur.execute(
                """UPDATE whitelist SET
                     latest_sent_chapter = GREATEST(COALESCE(latest_sent_chapter,0), %s),
                     latest_chapter      = GREATEST(COALESCE(latest_chapter,0), %s)
                   WHERE title_key=%s AND source=%s""",
                (hi, hi, tk, src),
            )
            fixed.append(f"{tk[:30]} ({src})")
        conn.commit()
    except Exception as e:
        logger.warn("gap auto-backfill failed", err=str(e)[:200])
        # Roll back any partial transaction so the connection isn't left dirty
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
        logger.info("gap auto-backfill done", inserted=inserted, dispatched=dispatched, series=len(fixed))
    return {"inserted": inserted, "dispatched": dispatched, "fixed": fixed}


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
    if cid:
        lines = []
        for g in sorted(gaps, key=lambda x: x["scraped"] - x["sent"], reverse=True)[:8]:
            missed = int(g["scraped"] - g["sent"] - 0.001)
            status = "✅ auto-backfilled" if f"{g['title_key'][:30]} ({g['source']})" in fixed_names else "⚠️ needs manual fix"
            lines.append(
                f"• `{g['title_key'][:36]}` ({g['source']}): ch{int(g['sent'])}→{int(g['scraped'])} "
                f"(~{missed} missing) {status}"
            )
        summary = (
            f"🕳️ **Chapter gap terdeteksi** ({len(gaps)} series):\n" + "\n".join(lines)
        )
        if result and result.get("dispatched"):
            summary += (
                f"\n🔧 **Auto-fix:** {result['inserted']} chapters backfilled, "
                f"{result['dispatched']} notifications re-sent."
            )
        try:
            from app.discord import client as discord_client
            discord_client.send_channel_message(cid, content=summary)
            logger.warn("gap alert sent", count=len(gaps))
        except Exception as e:
            logger.warn("gap alert send failed", err=str(e)[:160])
    return len(gaps)
