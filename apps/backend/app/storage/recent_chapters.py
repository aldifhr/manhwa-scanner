"""Recent chapters storage (parity with lib/services/storage/recent-chapters.ts)."""
from datetime import datetime, timezone, timedelta

from app.db import get_supabase
from app.logger import get_logger
from app.utils.text import normalize_shinigami_url
from app.utils.origin import normalize_origin

logger = get_logger("storage:recent-chapters")


def prune_older_than(hours: int = 24) -> int:
    """Delete rows whose updated_time is older than `hours`.

    Keeps the feed strictly within the rolling window (user requirement:
    "24 jam doang"). Called at the start of every cron run so backlog never
    accumulates. Returns the number of deleted rows.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    try:
        sb = get_supabase()
        res = sb.table("recent_chapters").delete().lt("updated_time", cutoff).execute()
        n = len(res.data or [])
        if n:
            logger.info("pruned recent_chapters older than window", hours=hours, deleted=n)
        return n
    except Exception as e:
        logger.error("prune_older_than failed", exc=e)
        return 0

def _norm_chapter_num(v) -> str | None:
    """Canonical string form of a chapter number (46 vs 46.0 -> '46')."""
    try:
        return ("%.10g" % float(v))
    except (ValueError, TypeError):
        return None


def _composite_key(r: dict) -> tuple[str, str, str] | None:
    """(title_key, source, chapter_num) — the WITHIN-source unique key.

    ikiru re-touches an old chapter by renewing its <time> AND often rotating
    the chapter URL (new cid). The composite key stays stable across that, so a
    re-touch can't insert a duplicate row that floods the 24h RSS as "new".
    Returns None for unnumbered chapters (one-shots) — those are never deduped.
    """
    tk = r.get("title_key") or ""
    src = r.get("source") or ""
    cn = _norm_chapter_num(r.get("chapter_num"))
    if not tk or not src or cn is None:
        return None
    return (tk, src, cn)


def _load_existing_rc(rows: list[dict]) -> tuple[set[str], set[tuple[str, str, str]]]:
    """Existing recent_chapters rows for this batch.

    Returns (chapter_urls already present, composite (title_key, source,
    chapter_num) keys already present) so callers can (a) skip re-inserting
    rows whose URL already exists and (b) skip URL-rotated re-touches of a
    chapter that already exists under a different URL.
    """
    existing_urls: set[str] = set()
    existing_ch: set[tuple[str, str, str]] = set()
    tks = sorted({(r.get("title_key") or "") for r in rows if r.get("title_key")})
    if not tks:
        return existing_urls, existing_ch
    _cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        for i in range(0, len(tks), 100):
            chunk = tks[i:i + 100]
            res = (
                get_supabase()
                .table("recent_chapters")
                .select("chapter_url, title_key, source, chapter_num")
                .in_("title_key", chunk)
                .gte("updated_time", _cutoff)
                .execute()
            )
            for er in (res.data or []):
                u = er.get("chapter_url") or ""
                if u:
                    existing_urls.add(u)  # type: ignore
                _tk = er.get("title_key") or ""
                _src = er.get("source") or ""
                _cn = _norm_chapter_num(er.get("chapter_num"))
                if _tk and _src and _cn:
                    existing_ch.add((_tk, _src, _cn))  # type: ignore
    except Exception as e:
        logger.error("batchInsertRecentChapters existing lookup failed", exc=e)
    return existing_urls, existing_ch


def batch_insert_recent_chapters(rows: list[dict]) -> None:
    if not rows:
        return
    # Keep only columns that exist in recent_chapters table
    # (html_backlog is derived from updated_time="" at read time,
    #  no separate column needed)
    allowed = {
        "chapter_url",
        "title_key",
        "title",
        "chapter",
        "chapter_num",
        "source",
        "cover",
        "series_url",
        "updated_time",
        "origin",
        "description",
        "type",
        "genres",
        "status",
        "rating",
    }
    cleaned = []
    for row in rows:
        # skip rows without chapter_url (not-null constraint)
        if not row.get("chapter_url"):
            continue
        # Normalize origin. ikiru/shinigami are MIXED-origin scanlation sites
        # (they host manga=JP, manhwa=KR, manhua=CN), so the source NAME is NOT
        # a reliable country. Precedence: explicit origin -> series type
        # (manga->JP, manhwa->KR, manhua->CN via normalize_origin) -> source
        # name (last-resort KR only when there is genuinely no type signal).
        _raw_origin = row.get("origin") or row.get("type") or ""
        _src = row.get("source") or ""
        _norm = normalize_origin(_raw_origin)
        if not _norm and _src:
            _norm = normalize_origin(_src)
        if not _norm:
            _norm = "KR" if _src in ("ikiru", "shinigami") else ""
        # Ensure every allowed column is present so the upsert payload is
        # complete. Missing keys cause Supabase (pooler/transaction mode) to
        # reject the whole chunk with "row missing columns" — which silently
        # drops unrelated chapters from RSS. Default empties keep rows valid.
        _r = {k: row.get(k) for k in allowed}
        # Guard NOT-NULL columns: wrapper items may omit status/rating/etc
        # (ikiru/shinigami don't emit status), leaving None which Postgres
        # rejects as NULL and silently drops the whole upsert chunk.
        for _k in ("status", "rating", "description", "type", "origin"):
            if _r.get(_k) is None:
                _r[_k] = ""
        if _r.get("genres") is None:
            _r["genres"] = []
        # Coerce nullable numeric columns to 0.0 so Postgres numeric/double
        # doesn't reject the upsert chunk on "" or None.
        for _k in ("chapter_num", "rating"):
            _v = _r.get(_k)
            if _v is None or _v == "":
                _r[_k] = 0.0
            else:
                try:
                    _r[_k] = float(_v)
                except (TypeError, ValueError):
                    _r[_k] = 0.0
        _r["chapter_url"] = row["chapter_url"]
        _r["origin"] = _norm
        cleaned.append(_r)
    # Note: we do NOT dedupe ACROSS sources here because the design is
    # flat-per-source — the same chapter on ikiru AND shinigami must both
    # survive. WITHIN a source, (title_key, source, chapter_num) is unique:
    # ikiru re-touches an old chapter by renewing its <time> AND often rotating
    # the chapter URL (new cid) — without this composite dedup a re-touch would
    # insert a SECOND row that floods the 24h RSS as "new".
    try:
        # Dedup within the batch itself (ikiru feed can return the same
        # chapter_url multiple times across its duplicated pages; the feed
        # pass and whitelist pass may also emit the same chapter).
        _seen_url: set[str] = set()
        _seen_ch: set[tuple[str, str, str]] = set()
        _uniq: list[dict] = []
        for r in cleaned:
            u = r.get("chapter_url")
            if u in _seen_url:
                continue
            _ck = _composite_key(r)
            if _ck and _ck in _seen_ch:
                continue
            _seen_url.add(u)
            if _ck:
                _seen_ch.add(_ck)
            _uniq.append(r)
        to_upsert = _uniq
        if to_upsert:
            # Cross-check against rows already in recent_chapters (the 24h
            # window; prune runs before this in the pipeline):
            #  - same chapter_url present → keep the ORIGINAL updated_time
            #    (ikiru renewing an old chapter's <time> must NOT re-fresh the
            #    feed entry); only non-time metadata is refreshed below.
            #  - same (title_key, source, chapter_num) with a DIFFERENT
            #    chapter_url → URL-rotated re-touch / duplicate release → skip
            #    entirely (no second RSS row).
            existing_urls, existing_ch = _load_existing_rc(to_upsert)
            new_rows: list[dict] = []
            touch_rows: list[dict] = []
            for r in to_upsert:
                if r["chapter_url"] in existing_urls:
                    touch_rows.append(r)
                elif _composite_key(r) in existing_ch:
                    continue
                else:
                    new_rows.append(r)
            # Chunk upserts: Supabase/PostgREST returns HTTP 400
            # ("JSON could not be generated") on a single large .insert() call
            # (~150+ rows). Insert genuinely-new rows (with their real
            # updated_time).
            CHUNK = 50
            inserted = 0
            for i in range(0, len(new_rows), CHUNK):
                chunk_rows = new_rows[i : i + CHUNK]
                try:
                    get_supabase().table("recent_chapters").upsert(
                        chunk_rows, on_conflict="chapter_url"
                    ).execute()
                    inserted += len(chunk_rows)
                except Exception as e:
                    logger.warn(
                        "batchInsertRecentChapters chunk failed",
                        exc=e,
                        range=f"{i}-{i+len(chunk_rows)}",
                    )
            # Existing rows: refresh NON-time metadata only — never
            # updated_time — so an ikiru re-touch (renewed <time>) can't keep
            # an old chapter pinned to the top of the 24h feed. PostgREST
            # upsert only writes the provided columns on conflict, so omitting
            # updated_time preserves the original release time.
            if touch_rows:
                _touch_rows = []
                for r in touch_rows:
                    _t = {"chapter_url": r["chapter_url"]}
                    for k in ("title_key", "title", "chapter", "chapter_num", "source", "cover", "series_url", "origin", "description"):
                        v = r.get(k)
                        if v:
                            _t[k] = v
                    _touch_rows.append(_t)
                # db_adapter requires every row in a batch to share the same
                # column set; a row missing chapter_num (sparse touch) fails
                # the whole 50-row chunk. Group by column-set signature so
                # each batch is uniform — no NULL-filling (an upsert with
                # explicit None would overwrite real values on conflict).
                _sig_groups: dict[frozenset, list[dict]] = {}
                for r in _touch_rows:
                    _sig_groups.setdefault(frozenset(r.keys()), []).append(r)
                _uniform_chunks = [
                    rows[i : i + CHUNK]
                    for rows in _sig_groups.values()
                    for i in range(0, len(rows), CHUNK)
                ]
                for chunk_rows in _uniform_chunks:
                    try:
                        get_supabase().table("recent_chapters").upsert(
                            chunk_rows, on_conflict="chapter_url"
                        ).execute()
                    except Exception as e:
                        logger.warn(
                            "batchInsertRecentChapters touch chunk failed",
                            exc=e,
                            range=f"{len(chunk_rows)} rows",
                        )
            if len(to_upsert) < len(cleaned):
                logger.info("batchInsertRecentChapters dedup", before=len(rows), after=len(to_upsert))
            if len(new_rows) < len(to_upsert):
                logger.info(
                    "batchInsertRecentChapters re-touch/dupe skipped",
                    total=len(to_upsert),
                    inserted=inserted,
                )
        else:
            logger.info("batchInsertRecentChapters: nothing to upsert")
        # FIX: backfill origin for existing rows that have EMPTY origin
        # (older rows inserted before origin was populated).
        # P2: do this as a single bulk upsert, not N individual .update() calls
        # (avoids the N+1 query anti-pattern when hundreds of rows qualify).
        try:
            # Chunk the .in_() lookup (same 100-URL limit as the existing-check
            # above) to avoid "URL component 'query' too long" on large batches.
            existing_rows: list[dict] = []
            all_urls = [r["chapter_url"] for r in cleaned if r.get("chapter_url")]
            for i in range(0, len(all_urls), 100):
                chunk_urls = all_urls[i : i + 100]
                try:
                    res = (
                        get_supabase()
                        .table("recent_chapters")
                        .select("chapter_url, origin")
                        .in_("chapter_url", chunk_urls)
                        .execute()
                    )
                    existing_rows.extend(res.data or [])
                except Exception as e:
                    logger.error("origin backfill lookup chunk failed", exc=e)
            # map url -> incoming origin (from deduped cleaned rows)
            incoming_origin: dict[str, str] = {}
            for d in cleaned:
                if d.get("origin"):
                    incoming_origin[d["chapter_url"]] = d["origin"]
            updates = [
                {"chapter_url": er["chapter_url"], "origin": incoming_origin[er["chapter_url"]]}
                for er in existing_rows
                if not er.get("origin") and er.get("chapter_url") in incoming_origin
            ]
            # Bulk upsert in chunks (reuse the 50-row safe chunk size)
            CHUNK = 50
            for i in range(0, len(updates), CHUNK):
                chunk_rows = updates[i : i + CHUNK]
                if chunk_rows:
                    get_supabase().table("recent_chapters").upsert(
                        chunk_rows, on_conflict="chapter_url"
                    ).execute()
        except Exception as e:
            logger.error("batchInsertRecentChapters backfill failed", exc=e)
    except Exception as e:
        logger.error("batchInsertRecentChapters failed", exc=e)
    # P1 cache-share: invalidate RSS cache across api/cron via Redis pub key
    try:
        from app.tasks import _get_redis as _gr
        _gr().setex("rss:invalidate", 30, "1")
    except Exception:
        pass


def get_trending(hours: int = 24, limit: int = 25) -> list[dict]:
    """Trending series = those releasing the MOST chapters within `hours`.

    Aggregates recent_chapters (flat, per-source) by (title_key, source),
    counts chapters in the window (release velocity = 'naik daun'),
    joins rating from whitelist. Returns newest-first by
    chapter_count then last activity.
    """
    try:
        from app.db import q
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        sql = """
            SELECT
                rc.title_key,
                rc.source,
                rc.title,
                rc.origin,
                rc.cover,
                rc.series_url,
                COUNT(*) AS chapter_count,
                MAX(rc.updated_time) AS last_update,
                w.rating AS rating
            FROM recent_chapters rc
            LEFT JOIN whitelist w
                ON w.title_key = rc.title_key AND w.source = rc.source
            WHERE rc.updated_time >= %s
            GROUP BY
                rc.title_key, rc.source, rc.title, rc.origin,
                rc.cover, rc.series_url, w.rating
            ORDER BY chapter_count DESC, last_update DESC
            LIMIT %s
        """
        rows = q(sql, [cutoff, limit]) or []
        out = []
        for r in rows:
            if not (r.get("series_url") or "").strip():
                continue
            try:
                rating = float(r.get("rating") or 0) or 0.0
            except (ValueError, TypeError):
                rating = 0.0
            out.append({
                "title_key": r.get("title_key", ""),
                "source": r.get("source", ""),
                "title": r.get("title", ""),
                "origin": r.get("origin") or "",
                "cover": r.get("cover") or "",
                "series_url": r.get("series_url") or "",
                "chapter_count": int(r.get("chapter_count") or 0),
                "last_update": r.get("last_update") or "",
                "rating": rating,
                "score": round(int(r.get("chapter_count") or 0) + rating / 2.0, 2),
            })
        return out
    except Exception as e:
        logger.error("get_trending failed", exc=e)
        return []


def get_recent_chapters(hours: int = 24) -> list[dict]:
    """Load ALL chapters found within the last `hours` (used by dispatch /
    dashboard callers that need the full set). For web pagination use
    get_recent_chapters_paginated() instead."""
    rows = _fetch_recent_rows(hours=hours, limit=1500, offset=0)
    return [_row_to_item(r) for r in rows]


def claim_recent_chapters_for_dispatch(
    whitelist: list[dict] | None = None, hours: int = 24, limit: int = 500
) -> list[dict]:
    """Deep queue claim: atomically SELECT whitelisted recent chapters FOR UPDATE SKIP LOCKED and claim them.

    Concentrates 24h window + whitelist match + FCFS dedup + claim in one seam.
    Uses single DB transaction so concurrent dispatch workers skip locked rows.
    Returns raw items (before enrich) that this worker owns — caller enriches & sends.
    If whitelist is None/empty, returns [].
    """
    if not whitelist:
        return []
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc).isoformat()
    from app.db import get_conn, put_conn
    from app.services.fcfs import fcfs_key

    # Build whitelist lookup for fast filtering
    allowed: set[tuple[str, str]] = set()
    for w in whitelist:
        from app.utils.text import normalize_title_key as _ntk
        tk = _ntk(str(w.get("title_key") or ""))
        src = str(w.get("source") or "")
        if tk:
            allowed.add((tk, src))

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    conn = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        # Lock recent_chapters rows for update, skip those already locked by concurrent dispatch
        # We select with FOR UPDATE SKIP LOCKED to avoid double-send.
        # Use raw SQL because builder doesn't support FOR UPDATE.
        cur.execute(
            "SELECT * FROM recent_chapters WHERE updated_time >= %s ORDER BY id DESC LIMIT %s FOR UPDATE SKIP LOCKED",
            (cutoff, limit),
        )
        rows = cur.fetchall()
        # Filter to whitelisted and not yet sent/claimed (check dispatch_history/claims in same tx)
        # Collect candidate fcfs_keys and urls for batch check
        candidates: list[dict] = []
        for r in rows:
            tk = str(r.get("title_key") or "")  # type: ignore
            src = str(r.get("source") or "")  # type: ignore
            from app.utils.text import normalize_title_key as _ntk2
            ntk = _ntk2(tk)
            if (tk, src) not in allowed and (ntk, src) not in allowed:
                continue
            # BUG1 guard: reject junk/placeholder rows before they reach dispatch.
            _cu = str(r.get("chapter_url") or "")
            _su = str(r.get("series_url") or "")
            _orig = str(r.get("origin") or "")
            _cov = r.get("cover")
            if _cu.startswith("https://x/") or _cu.startswith("http://x/"):
                continue
            if len(_su) < 10:
                continue
            if not _orig and not _cov:
                continue
            candidates.append(dict(r))

        if not candidates:
            conn.commit()
            return []

        # Check already sent/claimed in same transaction (consistent snapshot)
        urls = [c.get("chapter_url") for c in candidates if c.get("chapter_url")]
        fcfs_keys = [fcfs_key(c.get("title") or "", c.get("chapter") or "") for c in candidates]
        already_urls: set[str] = set()
        already_fcfs: set[str] = set()
        if urls:
            ph = ",".join(["%s"] * len(urls))
            cur.execute(f"SELECT chapter_url FROM dispatch_history WHERE chapter_url IN ({ph})", urls)
            already_urls |= {row["chapter_url"] for row in cur.fetchall()}  # type: ignore
        if fcfs_keys:
            uniq_fk = list(set(fcfs_keys))
            ph2 = ",".join(["%s"] * len(uniq_fk))
            cur.execute(f"SELECT fcfs_key FROM dispatch_history WHERE fcfs_key IN ({ph2})", uniq_fk)
            already_fcfs |= {row["fcfs_key"] for row in cur.fetchall() if row.get("fcfs_key")}  # type: ignore
            # Also check live dispatch_claims (short-TTL) — concurrent runs may have
            # claimed the same title+chapter but NOT yet written to dispatch_history.
            # Without this, concurrent cron fires can both claim+send the same release.
            ph3 = ",".join(["%s"] * len(uniq_fk))
            cur.execute(f"SELECT fcfs_key FROM dispatch_claims WHERE fcfs_key IN ({ph3}) AND expires_at >= %s", uniq_fk + [now])
            already_fcfs |= {row["fcfs_key"] for row in cur.fetchall() if row.get("fcfs_key")}  # type: ignore

        # Filter candidates to not yet sent
        to_claim: list[dict] = []
        for c in candidates:
            u = c.get("chapter_url")
            fk = fcfs_key(c.get("title") or "", c.get("chapter") or "")
            if u in already_urls or fk in already_fcfs:
                continue
            to_claim.append(c)

        # C1 Fix: Write dispatch_claims in the SAME transaction as the row lock
        # (use `cur` on `conn`, NOT a separate Supabase connection). This makes
        # the claim atomic with the FOR UPDATE SKIP LOCKED select — if conn.commit()
        # fails, the claim is rolled back too (no orphaned claim → no double-send).
        if to_claim:
            try:
                # Dedupe by fcfs_key: two chapters with different chapter_urls but
                # the SAME normalized title+chapter (URL rotation) collide on the
                # unique fcfs_key. Postgres ON CONFLICT DO UPDATE cannot affect the
                # same row twice in one multi-row INSERT → "cannot affect row a
                # second time" warning. Keep first occurrence per fcfs_key.
                _seen_fcfs: set[str] = set()
                _claim_rows: list[tuple] = []
                _claim_expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
                for c in to_claim:
                    _fk = fcfs_key(c.get("title") or "", c.get("chapter") or "")
                    if _fk in _seen_fcfs:
                        continue
                    _seen_fcfs.add(_fk)
                    _claim_rows.append((
                        c.get("title_key"),
                        c.get("chapter_url"),
                        _fk,
                        datetime.now(timezone.utc).isoformat(),
                        _claim_expires,
                        "pending",
                    ))
                if not _claim_rows:
                    conn.commit()
                    return [_row_to_item(r) for r in to_claim]
                _claim_ph = ",".join(["(%s,%s,%s,%s,%s,%s)"] * len(_claim_rows))
                _claim_vals: list = []
                for _r in _claim_rows:
                    _claim_vals.extend(_r)
                cur.execute(
                    f"INSERT INTO dispatch_claims (title_key, chapter_url, fcfs_key, created_at, expires_at, status) "
                    f"VALUES {_claim_ph} ON CONFLICT (fcfs_key) DO UPDATE SET "
                    f"chapter_url=EXCLUDED.chapter_url, created_at=EXCLUDED.created_at, "
                    f"expires_at=EXCLUDED.expires_at, status=EXCLUDED.status",
                    _claim_vals,
                )
            except Exception as e:
                logger.warn("dispatch_claims insert failed", err=str(e)[:120])
                # Roll back the whole transaction — do NOT leave a partial claim
                try:
                    conn.rollback()
                except Exception:
                    pass
                conn.commit()  # end the aborted tx
                return []

        conn.commit()
        return [_row_to_item(r) for r in to_claim]
    except Exception:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        # Fallback to non-locking path if FOR UPDATE not supported (e.g. pooler)
        try:
            return get_recent_chapters(hours=hours)  # fallback
        except Exception:
            return []
    finally:
        if conn:
            try:
                put_conn(conn)
            except Exception:
                pass


def get_recent_chapters_paginated(
    page: int = 1, limit: int = 24, hours: int = 24, source: str | None = None
) -> tuple[list[dict], int, int]:
    """Server-side paginated recent chapters for the web RSS feed.

    Only fetches the single page requested (page*limit rows) so infinite
    scroll stays cheap — no loading of all 1500 rows + enriching them just
    to return 24. `source` (if given) is filtered DB-side so pagination
    stays correct per-source. Returns (items, total, total_pages).
    """
    total = _count_recent_rows(hours=hours, source=source)
    total_pages = (total + limit - 1) // limit if limit else 1
    offset = max(0, (page - 1) * limit)
    rows = _fetch_recent_rows(hours=hours, limit=limit, offset=offset, source=source)
    return [_row_to_item(r) for r in rows], total, total_pages


def _count_recent_rows(hours: int = 24, source: str | None = None) -> int:
    try:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        q = (
            get_supabase()
            .table("recent_chapters")
            .select("*", count="exact")
            .gte("updated_time", cutoff)
        )
        if source:
            q = q.eq("source", source)
        res = q.execute()
        return res.count or 0
    except Exception as e:
        logger.error("count recent_chapters failed", exc=e)
        return 0


def _fetch_recent_rows(
    hours: int = 24, limit: int = 1500, offset: int = 0, source: str | None = None
) -> list[dict]:
    try:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        q = (
            get_supabase()
            .table("recent_chapters")
            .select("*")
            .gte("updated_time", cutoff)
            # Sort by PK (id) descending — insertion order ≈ chronological,
            # and critically STABLE across pages. Ordering by updated_time
            # alone is unstable (many rows share the same timestamp) which
            # made offset pagination return overlapping rows on page 1/2.
            .order("id", desc=True)
            .limit(limit)
            .offset(offset)
        )
        if source:
            q = q.eq("source", source)
        res = q.execute()
        return res.data or []  # type: ignore
    except Exception as e:
        logger.error("fetch recent_chapters failed", exc=e)
        return []


def _row_to_item(r: dict) -> dict:
    item = {
        "id": r.get("id"),
        "title": r.get("title", ""),
        "title_key": r.get("title_key", ""),
        "chapter": str(r.get("chapter") or ""),
        "chapter_num": r.get("chapter_num") or 0,
        "url": r.get("chapter_url") or r.get("url", ""),
        "chapter_url": r.get("chapter_url") or r.get("url", ""),
        "source": r.get("source", ""),
        # Return a short same-origin cover ref (BE-3c) instead of the raw
        # (often very long MinIO) URL. The DB keeps the raw URL; this only
        # rewrites on read so the backend proxy resolves it server-side.
        "cover": r.get("cover") or "",
        "series_url": r.get("series_url") or "",
        "origin": r.get("origin") or "",
        "updated_time": r.get("updated_time") or "",
        "description": r.get("description") or "",
        # Carry rating + genres through to dispatch embeds. Previously dropped
        # here, so voratoon (and all sources via the claim path) rendered empty
        # rating/genre in Discord. DB stores them; the embed builder consumes them.
        "rating": r.get("rating") or "",
        "genres": r.get("genres") or [],
    }
    su = item.get("series_url")
    if su:
        item["series_url"] = normalize_shinigami_url(su) or su
    for fld in ("url", "chapter_url", "cover"):
        v = item.get(fld)
        if isinstance(v, str) and "shinigami.asia" in v:
            item[fld] = normalize_shinigami_url(v) or v
    return item