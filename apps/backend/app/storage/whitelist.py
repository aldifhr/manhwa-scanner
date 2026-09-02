"""Whitelist storage (parity with lib/services/storage/whitelist.ts)."""
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.db import get_supabase
from app.logger import get_logger
from app.utils.text import normalize_title_key, normalize_shinigami_url
from app.utils.cache import ttl_cache

logger = get_logger("storage:whitelist")

# Canonical sources (keep in sync with settings.SOURCE_KEYS).
_VALID_SOURCES = ("ikiru", "shinigami", "voratoon")


class WhitelistRow(BaseModel):
    """Validated + normalized whitelist row.

    The whitelist table is FLAT-per-source (composite PK
    title_key+source). This model is the single source of truth
    for the row *shape* — every read path gets a normalized
    instance (so .get() on a str field can't surprise callers),
    and every write path serializes via to_db() (so a malformed
    dict from the FE / cron can't pollute the DB schema).

    Replaces the previous "raw dict, .get() everywhere" pattern that
    was the root cause of 5 audit bugs (#1-#5): missing fields,
    wrong types, and nested sources[] assumptions that never matched
    the real flat schema.
    """

    model_config = {"extra": "ignore"}  # tolerate legacy columns

    title_key: str
    source: str
    title: Optional[str] = None
    url: Optional[str] = None
    permalink: Optional[str] = None
    series_url: Optional[str] = None
    cover: Optional[str] = None
    rating: Optional[float] = None
    genres: list[str] = Field(default_factory=list)
    description: Optional[str] = None
    status: Optional[str] = None
    origin: Optional[str] = None
    latest_chapter: Optional[float] = None
    latest_sent_chapter: Optional[float] = None
    created_at: Optional[str] = None

    @field_validator("title_key", mode="before")
    @classmethod
    def _norm_tk(cls, v):
        if not v:
            return ""
        return normalize_title_key(str(v))

    @field_validator("source", mode="before")
    @classmethod
    def _norm_src(cls, v):
        s = str(v or "").strip().lower()
        if s not in _VALID_SOURCES:
            # Tolerate legacy/unknown source but normalize casing.
            return s
        return s

    @field_validator("genres", mode="before")
    @classmethod
    def _coerce_genres(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            # Some rows store "a,b,c"; normalize to list.
            return [g.strip() for g in v.split(",") if g.strip()]
        if isinstance(v, list):
            return [str(g) for g in v if g]
        return []

    def to_db(self) -> dict:
        """Serialize for upsert (only non-None fields)."""
        d = self.model_dump(exclude_none=True)
        # ensure composite PK fields are always present
        d.setdefault("title_key", self.title_key)
        d.setdefault("source", self.source)
        # Backward compat: whitelist.created_at is NOT NULL with default now(),
        # but older call sites/fixtures may omit it.
        if not d.get("created_at"):
            from datetime import datetime, timezone
            d["created_at"] = datetime.now(timezone.utc).isoformat()
        return d

# Cache decorator applied to load_whitelist() below.


def _norm_row(r: dict) -> dict:
    out = dict(r)
    su = out.get("series_url")
    if su:
        out["series_url"] = normalize_shinigami_url(su) or su
    for fld in ("url", "permalink", "cover"):
        v = out.get(fld)
        if isinstance(v, str) and "shinigami.asia" in v:
            out[fld] = normalize_shinigami_url(v) or v
    return out


@ttl_cache(ttl=30.0, maxsize=1)
def load_whitelist(force: bool = False) -> list[dict]:
    try:
        res = (
            get_supabase()
            .table("whitelist")
            .select("*")
            .order("created_at", desc=True)
            .execute()
        )
        return [_norm_row(r) for r in (res.data or [])]
    except Exception as e:
        logger.error("Failed to load whitelist", exc=e)
        return []


def add_whitelist_entries(rows: list[dict]) -> dict:
    """Upsert whitelist rows via direct adapter (NOT the sync_whitelist RPC).

    The old RPC path (parity lib/services/storage/whitelist.ts) was the
    root cause of migration 005's duplicate whitelist rows — it didn't
    honor the composite PK (title_key+source) cleanly. We now upsert
    validated WhitelistRow models directly (on_conflict=title_key,source)
    so a re-add is idempotent, never a dup.
    """
    if not rows:
        return {"status": "ok", "whitelist": []}
    try:
        models = [WhitelistRow.model_validate(r) for r in rows]
        payload = [m.to_db() for m in models]
        get_supabase().table("whitelist").upsert(
            payload, on_conflict="title_key,source"
        ).execute()
        # Invalidate cache so next load picks up the new rows.
        load_whitelist.invalidate()
        return {"status": "ok", "whitelist": payload}
    except Exception as e:
        logger.error("add_whitelist_entries failed", exc=e)
        return {"status": "error", "whitelist": []}


def auto_cleanup_stale_whitelist(days: int = 30, dry_run: bool = False) -> dict:
    """Remove whitelist entries that were added >`days` ago AND have NEVER
    been notified (no dispatch_history row at all).

    IMPORTANT: we must NOT use recent_chapters as the "still active" signal.
    recent_chapters is pruned to 48h by the retention worker, so any title not
    scraped in the last 48h would look "stale" and get deleted every hour —
    that was deleting user subscriptions (title_key+source pairs) within hours
    of being added. A whitelist entry is a user subscription; it persists until
    the user removes it. We only drop entries that have never produced a single
    notification AND are older than `days`, which is safe (never useful) and
    does not destroy actively-followed series.
    """
    try:
        from datetime import datetime, timedelta, timezone
        from app.db import q
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

        # Stale = added before cutoff AND zero dispatch_history rows ever.
        sql = """
            SELECT w.title_key, w.source, w.title
            FROM whitelist w
            WHERE w.created_at < %s
              AND NOT EXISTS (
                SELECT 1 FROM dispatch_history dh
                WHERE dh.title_key = w.title_key
                  AND dh.source = w.source
              )
        """
        stale = q(sql, [cutoff])
        if not stale:
            return {"status": "ok", "removed": 0, "total": 0}


        if not dry_run and stale:
            # L3 FIX: Use VALUES clause instead of unnest for composite key DELETE
            # unnest on two arrays produces element-wise rows which may not match correctly
            from app.db_adapter import get_conn, put_conn
            conn = None
            cur = None
            try:
                conn = get_conn()
                cur = conn.cursor()
                values_clause = ", ".join(["(%s, %s)"] * len(stale))
                params = []
                for r in stale:
                    params.extend([r["title_key"], r["source"]])
                cur.execute(
                    f"DELETE FROM whitelist WHERE (title_key, source) IN ({values_clause})",
                    params
                )
                conn.commit()
                load_whitelist.invalidate()
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

        return {"status": "ok", "removed": len(stale) if not dry_run else 0, "stale": len(stale), "dry_run": dry_run}
    except Exception as e:
        logger.error("auto_cleanup_stale_whitelist failed", exc=e)
        return {"status": "error", "error": str(e)[:200]}
