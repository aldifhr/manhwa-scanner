"""Dispatch claim — moved from storage/recent_chapters.py (679L split).

Single seam: SELECT ... FOR UPDATE SKIP LOCKED + FCFS dedup + claim.
Storage keeps batch_insert + fetch helpers; this owns orchestration.
"""
from datetime import datetime, timezone, timedelta

from app.db import get_conn, put_conn, get_supabase
from app.logger import get_logger
from app.services.fcfs import fcfs_key

logger = get_logger("services:claim")


def _norm_chapter_num(v) -> str | None:
    try:
        return ("%.10g" % float(v))
    except (ValueError, TypeError):
        return None


def _row_to_item(r: dict) -> dict:
    from app.utils.text import normalize_shinigami_url

    item = {
        "id": r.get("id"),
        "title": r.get("title", ""),
        "title_key": r.get("title_key", ""),
        "chapter": str(r.get("chapter") or ""),
        "chapter_num": r.get("chapter_num") or 0,
        "url": r.get("chapter_url") or r.get("url", ""),
        "chapter_url": r.get("chapter_url") or r.get("url", ""),
        "source": r.get("source", ""),
        "cover": r.get("cover") or "",
        "series_url": r.get("series_url") or "",
        "origin": r.get("origin") or "",
        "updated_time": r.get("updated_time") or "",
        "description": r.get("description") or "",
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


def claim_recent_chapters_for_dispatch(
    whitelist: list[dict] | None = None, hours: int = 24, limit: int = 500
) -> list[dict]:
    """Deep queue claim — see storage/recent_chapters.py docstring."""
    if not whitelist:
        return []
    now = datetime.now(timezone.utc).isoformat()

    allowed: set[tuple[str, str]] = set()
    _latest_sent: dict[tuple[str, str], float] = {}
    for w in whitelist:
        from app.utils.text import normalize_title_key as _ntk

        tk = _ntk(str(w.get("title_key") or ""))
        src = str(w.get("source") or "")
        if tk:
            allowed.add((tk, src))
        try:
            _ls = float(w.get("latest_sent_chapter") or 0)
        except (ValueError, TypeError):
            _ls = 0
        if tk and _ls:
            _latest_sent[(tk, src)] = max(_latest_sent.get((tk, src), 0), _ls)

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    conn = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM recent_chapters WHERE updated_time >= %s ORDER BY id DESC LIMIT %s FOR UPDATE SKIP LOCKED",
            (cutoff, limit),
        )
        rows = cur.fetchall()
        candidates: list[dict] = []
        for r in rows:
            tk = str(r.get("title_key") or "")
            src = str(r.get("source") or "")
            from app.utils.text import normalize_title_key as _ntk2

            ntk = _ntk2(tk)
            if (tk, src) not in allowed and (ntk, src) not in allowed:
                continue
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
            ph3 = ",".join(["%s"] * len(uniq_fk))
            cur.execute(f"SELECT fcfs_key FROM dispatch_claims WHERE fcfs_key IN ({ph3}) AND expires_at >= %s", uniq_fk + [now])
            already_fcfs |= {row["fcfs_key"] for row in cur.fetchall() if row.get("fcfs_key")}  # type: ignore
        _legacy_pairs: set[tuple[str, str]] = set()
        try:
            _tk_list = list({str(c.get("title_key") or "") for c in candidates if c.get("title_key")})
            if _tk_list:
                ph_tk = ",".join(["%s"] * len(_tk_list))
                cur.execute(f"SELECT title_key, chapter_title FROM dispatch_history WHERE title_key IN ({ph_tk})", _tk_list)
                for _r in cur.fetchall():
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

        to_claim: list[dict] = []
        for c in candidates:
            u = c.get("chapter_url")
            fk = fcfs_key(c.get("title") or "", c.get("chapter") or "")
            if u in already_urls or fk in already_fcfs:
                continue
            _tk_c = str(c.get("title_key") or "")
            _ch_c = str(c.get("chapter") or c.get("chapter_num") or "")
            try:
                _ch_norm = ("%.10g" % float(_ch_c)) if _ch_c else _ch_c
            except (ValueError, TypeError):
                _ch_norm = _ch_c
            if _tk_c and _ch_c and ((_tk_c, _ch_c) in _legacy_pairs or (_tk_c, _ch_norm) in _legacy_pairs):
                continue
            try:
                _cn = float(str(c.get("chapter") or c.get("chapter_num") or 0) or 0)
            except (ValueError, TypeError):
                _cn = 0
            if _cn:
                _tk2 = str(c.get("title_key") or "")
                from app.utils.text import normalize_title_key as _ntk3

                _ntk_c = _ntk3(_tk2)
                _src2 = str(c.get("source") or "")
                _ceil = _latest_sent.get((_ntk_c, _src2), 0) or _latest_sent.get((_tk2, _src2), 0)
                if _ceil and _cn <= _ceil:
                    continue
            to_claim.append(c)

        if to_claim:
            try:
                _seen_fcfs: set[str] = set()
                _claim_rows: list[tuple] = []
                _claim_expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
                for c in to_claim:
                    _fk = fcfs_key(c.get("title") or "", c.get("chapter") or "")
                    if _fk in _seen_fcfs:
                        continue
                    _seen_fcfs.add(_fk)
                    _claim_rows.append(
                        (
                            c.get("title_key"),
                            c.get("chapter_url"),
                            _fk,
                            datetime.now(timezone.utc).isoformat(),
                            _claim_expires,
                            "pending",
                        )
                    )
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
                try:
                    conn.rollback()
                except Exception:
                    pass
                conn.commit()
                return []

        conn.commit()
        return [_row_to_item(r) for r in to_claim]
    except Exception:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        try:
            from app.storage.recent_chapters import get_recent_chapters as _fallback

            return _fallback(hours=hours)
        except Exception:
            return []
    finally:
        if conn:
            try:
                put_conn(conn)
            except Exception:
                pass
