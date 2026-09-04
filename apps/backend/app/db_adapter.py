"""
Direct PostgreSQL access layer (replaces PostgREST/Supabase client).

Backend now connects to Supabase via the TRANSACTION POOLER (IPv4, reachable
from the VPS) using psycopg2. The old `supabase` PostgREST client is removed.

We keep a builder-style API (`get_supabase().table(...).select(...).eq(...)`
) that mirrors the PostgREST surface the rest of the codebase uses, so the
~67 call sites do NOT need rewriting. Each builder compiles to parameterized
SQL and runs through a thread-local psycopg2 connection borrowed from a pool.

Connection: DATABASE_URL env (transaction pooler, sslmode=require).
"""
from __future__ import annotations

import os
import threading
import psycopg2
import psycopg2.pool
from psycopg2.extras import RealDictCursor

from app.config import settings
from app.logger import get_logger
from app.services.resilience import cb_db

logger = get_logger("db")

DATABASE_URL = os.environ.get("DATABASE_URL") or getattr(settings, "DATABASE_URL", "") or ""

_pool: psycopg2.pool.ThreadedConnectionPool | None = None
_pool_lock = threading.Lock()
# Bounded semaphore so we never exceed pool capacity; get_conn() blocks
# (queues) instead of raising PoolError under burst load.
_conn_sem: threading.Semaphore | None = None
_POOL_MAX = 15


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool, _conn_sem
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                if not DATABASE_URL:
                    raise RuntimeError("DATABASE_URL not set (transaction pooler DSN required)")
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    minconn=2,
                    maxconn=_POOL_MAX,
                    dsn=DATABASE_URL,
                    cursor_factory=RealDictCursor,
                )
                _conn_sem = threading.Semaphore(_POOL_MAX)
                logger.info("psycopg2 pool created", dsn_masked=DATABASE_URL.split("@")[0] + "@***")
    return _pool


def get_pool_stats() -> dict:
    """Return connection pool utilization. -1 if pool not initialized."""
    p = _pool
    if p is None:
        return {"active": -1, "idle": -1, "max": _POOL_MAX}
    # Prefer public stats when available; fall back to internal dicts.
    try:
        # psycopg2 ThreadedConnectionPool has no public stats API; we inspect
        # _used / _rused as best-effort but guard against future renames.
        used = 0
        for attr in ("_used", "_rused", "_used_connections", "_pool"):
            v = getattr(p, attr, None)
            if isinstance(v, dict):
                used += len(v)
            elif isinstance(v, (list, set, tuple)):
                used += len(v)
            elif v is not None and attr == "_used":
                # _used is dict keyed by connection id in newer psycopg2
                try:
                    used += len(v)
                except Exception:
                    pass
        # If we couldn't infer, report -1 instead of lying.
        if used == 0:
            # double-check: if pool is truly empty, distinguish from unknown
            # by checking if _used exists at all
            if not any(hasattr(p, a) for a in ("_used", "_rused")):
                return {"active": -1, "idle": -1, "max": _POOL_MAX}
        return {"active": used, "idle": max(0, _POOL_MAX - used), "max": _POOL_MAX}
    except Exception:
        return {"active": -1, "idle": -1, "max": _POOL_MAX}


def get_conn():
    """Borrow a connection, blocking (queued) if the pool is saturated.
    Retries once on a stale/closed connection (transaction poolers drop
    idle conns) instead of surfacing SSL-closed errors to the caller."""
    if not cb_db.allow():
        raise RuntimeError("circuit db OPEN — fast fail")
    sem = _get_pool() and _conn_sem
    if sem is None:
        _get_pool()
        sem = _conn_sem
    sem.acquire()
    last_err = None
    for _ in range(2):
        try:
            conn = _get_pool().getconn()
            # Lazy validation: only run SELECT 1 if the connection is
            # explicitly marked closed (cheap local attribute check, no
            # network round-trip). psycopg2's ThreadedConnectionPool already
            # keeps connections alive between borrows; the full SELECT 1 was
            # a per-borrow network hit on every get_conn() call. If a conn is
            # silently SSL-dropped, the real query will raise and the caller's
            # retry / circuit breaker handles it.
            if getattr(conn, "closed", 0):
                raise psycopg2.OperationalError("connection marked closed")
            # autocommit=True: psycopg2 defaults to autocommit=False, so the
            # first query on a borrowed pooled connection opens a transaction
            # whose MVCC snapshot PERSISTS across borrows (get_conn/put_conn
            # never commit/rollback). Long-lived API/cron connections then see
            # a frozen snapshot from process start and silently MISS every row
            # inserted after that (cron scrapes, whitelist adds, gap backfills)
            # — e.g. The Villain Of Destiny shinigami never appearing in /recent.
            # autocommit makes every statement see committed data (READ
            # COMMITTED), eliminating the stale-snapshot bug.
            try:
                conn.autocommit = True
            except Exception:
                pass
            # Force UTC on every borrowed connection. The DB default session
            # TZ is Asia/Shanghai (+08:00), which makes tz-naive/string
            # `updated_time >= cutoff` comparisons shift by 8h and silently
            # drop rows from RSS/cron windows. UTC makes all comparisons
            # unambiguous regardless of how the param is bound.
            try:
                with conn.cursor() as _tzcur:
                    _tzcur.execute("SET TIME ZONE UTC")
            except Exception:
                pass
            cb_db.record_success()
            return conn
        except Exception as e:
            last_err = e
            cb_db.record_failure()
            try:
                # DISCARD (close=True) — do NOT recycle a broken
                # connection back into the pool. Recycling a stale/
                # SSL-closed socket lets the next getconn() pull the
                # same dead conn and fail again (retry spin). psycopg2's
                # putconn(close=True) actually closes it.
                _get_pool().putconn(conn, close=True)
            except Exception:
                pass
    # Both attempts failed: if the pool has multiple broken conns
    # we can't easily detect them all, but recreating on repeated
    # failure would be overkill for a single-instance bot. Log + raise.
    sem.release()
    raise last_err


def put_conn(conn):
    try:
        _get_pool().putconn(conn)
    except Exception:
        pass
    finally:
        if _conn_sem is not None:
            _conn_sem.release()


def close_pool() -> None:
    """Close all connections in the pool."""
    global _pool, _conn_sem
    if _pool is not None:
        try:
            _pool.closeall()
        except Exception:
            pass
        _pool = None
        _conn_sem = None


# ---------------------------------------------------------------------------
# Builder that mimics the PostgREST client surface
# ---------------------------------------------------------------------------


class _Query:
    def __init__(self, table: str, op: str):
        self.table = table
        self.op = op  # select|insert|update|delete|upsert
        self._cols = "*"
        self._values = None          # dict for insert/update/upsert
        self._on_conflict = None      # column name(s) for upsert
        self._where: list[tuple] = [] # (sql_fragment, [params])
        self._or_groups: list[list[tuple]] = []  # list of and-groups
        self._order: list[tuple] = [] # (col, desc)
        self._limit = None
        self._offset = 0
        self._single = False
        self._maybe_single = False
        self._want_count = False

    # ---- WHERE builders ----
    def _w(self, frag, params):
        self._where.append((frag, params))

    def eq(self, col, val):
        self._w(f"{col} = %s", [val]); return self

    def neq(self, col, val):
        self._w(f"{col} <> %s", [val]); return self

    def gt(self, col, val):
        self._w(f"{col} > %s", [val]); return self

    def lt(self, col, val):
        self._w(f"{col} < %s", [val]); return self

    def gte(self, col, val):
        self._w(f"{col} >= %s", [val]); return self

    def lte(self, col, val):
        self._w(f"{col} <= %s", [val]); return self

    def like(self, col, pat):
        self._w(f"{col} LIKE %s", [pat]); return self

    def ilike(self, col, pat):
        self._w(f"{col} ILIKE %s", [pat]); return self

    def is_(self, col, val):
        self._w(f"{col} IS {val}", []); return self

    def in_(self, col, vals):
        if not vals:
            # PostgREST .in_([ ]) => no rows
            self._w("1 = 0", []); return self
        ph = ",".join(["%s"] * len(vals))
        self._w(f"{col} IN ({ph})", list(vals)); return self

    # Known JSONB columns (so .contains()/@> compiles correctly). Anything
    # not in this set is treated as TEXT (substring match via LIKE) — the old
    # code hardcoded `::jsonb` which crashed on TEXT columns (operator does
    # not exist: text @> jsonb). Callers that hit a TEXT column with
    # .contains() now get a safe LIKE instead of a 500.
    _JSONB_COLS = {
        "dashboard_snapshot.payload",
        "failed_dispatches.metadata",
        "whitelist.genres",
        "recent_chapters.genres",
        "series_meta.genres",
        "series_meta.payload",
    }

    def contains(self, col, val):
        import json
        full = f"{self.table}.{col}"
        if full in self._JSONB_COLS:
            import json as _json
            if isinstance(val, str):
                try:
                    _parsed = _json.loads(val)
                except Exception:
                    _parsed = None
            else:
                _parsed = val
            # PostgREST .contains() on a jsonb ARRAY column expects an array
            # value (e.g. '["Action"]'), not a bare scalar. Wrap scalars so
            # `genres @> 'Action'` becomes `genres @> '["Action"]'::jsonb`.
            if not isinstance(_parsed, (list, dict)):
                _parsed = [val]
            self._w(f"{col} @> %s::jsonb", [_json.dumps(_parsed)])
        else:
            # TEXT containment → substring match (PostgREST .contains on text)
            like = val if isinstance(val, str) else json.dumps(val)
            self._w(f"{col} LIKE %s", [f"%{like}%"])
        return self

    def filter(self, col, op, val):
        # generic: op in eq,neq,gt,lt,gte,lte,like,ilike,cs(contains),cd
        full = f"{self.table}.{col}"
        if op in ("cs", "cd") and full not in self._JSONB_COLS:
            # TEXT column: PostgREST maps cs/cd on text to substring match
            self._w(f"{col} LIKE %s", [f"%{val}%"]); return self
        m = {
            "eq": f"{col} = %s", "neq": f"{col} <> %s",
            "gt": f"{col} > %s", "lt": f"{col} < %s",
            "gte": f"{col} >= %s", "lte": f"{col} <= %s",
            "like": f"{col} LIKE %s", "ilike": f"{col} ILIKE %s",
            "cs": f"{col} @> %s::jsonb", "cd": f"{col} <@ %s::jsonb",
        }.get(op)
        if not m:
            raise ValueError(f"unsupported filter op {op}")
        self._w(m, [val]); return self

    def or_(self, *chains):
        """loosely emulate .or_(): each chain is a callable that applies
        filters to a cloned builder; we OR the resulting AND-groups."""
        group = []
        for ch in chains:
            b = _Query(self.table, self.op)
            b._cols = self._cols
            ch(b)
            for frag, params in b._where:
                group.append((frag, params))
        if group:
            self._or_groups.append(group)
        return self

    # ---- modifiers ----
    def select(self, cols="*", count=None):
        self._cols = cols
        if count:
            self._want_count = True
        return self

    def order(self, col, desc=False, ascending=None):
        if ascending is not None:
            desc = not ascending
        self._order.append((col, desc)); return self

    def limit(self, n):
        self._limit = n; return self

    def offset(self, n):
        self._offset = n; return self

    def single(self):
        # NOTE: do NOT set self._limit = 1 here. Supabase's
        # .single() does NOT cap the fetch — it expects the query
        # to return exactly 1 row and 406s on multiple. If we
        # LIMIT 1, the DB returns 1 row and our >1 guard
        # can never trip (silent wrong-data path). We fetch
        # ALL matched rows and the .execute() guard rejects >1.
        self._single = True
        return self

    def maybe_single(self):
        self._maybe_single = True
        return self

    # ---- data setters ----
    def insert(self, row):
        self.op = "insert"; self._values = row; return self

    def update(self, row):
        self.op = "update"; self._values = row; return self

    def upsert(self, row, on_conflict=None):
        self.op = "upsert"; self._values = row
        if on_conflict:
            self._on_conflict = on_conflict
        return self

    def delete(self):
        self.op = "delete"; return self
    def _compile_write(self, upsert: bool):
        """Build INSERT / INSERT..ON CONFLICT for either a single dict
        or a list of dicts (batch). All rows must share the same columns;
        we take columns from the first row and validate the rest match.
        """
        # --- Defense-in-depth: column-name allowlist ---
        # Values are parameterized (%s), but column NAMES are interpolated
        # into the SQL string. They come from dict KEYS in app code
        # today (never request body), so there's no live injection — but
        # a future endpoint that does ``entry = dict(request.json())``
        # would open a column-name SQLi. Reject any identifier that
        # isn't a safe Postgres identifier (letters/digits/underscore,
        # <=63 chars) so a bad key can never reach the SQL string.
        import re as _re
        _ID_RE = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
        rows = self._values if isinstance(self._values, list) else [self._values]
        if not rows:
            raise ValueError("upsert/insert called with empty values")
        cols = list(rows[0].keys())
        for c in cols:
            if not _ID_RE.match(c):
                raise ValueError(f"invalid column name (rejected): {c!r}")
        # multi-row VALUES
        val_rows = []
        params: list = []
        import json as _json
        for r in rows:
            missing = [c for c in cols if c not in r]
            if missing:
                raise ValueError(f"row missing columns: {missing}")
            # jsonb columns: a list/dict value must be cast ::jsonb, not
            # sent as a Postgres ARRAY (psycopg2 would emit text[] and
            # Postgres rejects "column X is of type jsonb but expression
            # is of type text[]"). Serialize to JSON + cast.
            _ph = []
            for c in cols:
                v = r[c]
                if isinstance(v, (list, dict)):
                    _ph.append("%s::jsonb")
                    params.append(_json.dumps(v))
                else:
                    _ph.append("%s")
                    params.append(v)
            val_rows.append("(" + ", ".join(_ph) + ")")
        sql = (
            f"INSERT INTO {self.table} ({', '.join(cols)}) VALUES "
            + ", ".join(val_rows)
        )
        if upsert:
            if self._on_conflict:
                oc = self._on_conflict
                parts = [p.strip() for p in oc.split(",") if p.strip()]
                if not parts or not all(_ID_RE.match(p) for p in parts):
                    raise ValueError(f"invalid on_conflict spec: {oc!r}")
                ucols = [c for c in cols if c not in parts]
                if ucols:
                    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in ucols)
                    sql += f" ON CONFLICT ({oc}) DO UPDATE SET {upd}"
                else:
                    sql += f" ON CONFLICT ({oc}) DO NOTHING"
            else:
                sql += " ON CONFLICT DO NOTHING"
        sql += " RETURNING *"
        return sql, params

    # ---- compile ----
    def _build_where(self):
        clauses = []
        params: list = []
        for frag, p in self._where:
            clauses.append(f"({frag})")
            params.extend(p)
        for grp in self._or_groups:
            sub = " OR ".join(f"({frag})" for frag, _ in grp)
            clauses.append(f"({sub})")
            for _, p in grp:
                params.extend(p)
        return (" WHERE " + " AND ".join(clauses)) if clauses else "", params

    def _col_list(self):
        if self._cols in ("*", None):
            return "*"
        return ", ".join(c.strip() for c in self._cols.split(","))

    def compile(self):
        w, p = self._build_where()
        if self.op == "select":
            sql = f"SELECT {self._col_list()} FROM {self.table}{w}"
            for col, desc in self._order:
                sql += f" ORDER BY {col} {'DESC' if desc else 'ASC'}"
            if self._limit is not None:
                sql += f" LIMIT {int(self._limit)}"
            if self._offset:
                sql += f" OFFSET {int(self._offset)}"
            return sql, p
        if self.op == "insert":
            return self._compile_write(False)
        if self.op == "update":
            import json as _json
            sets = []
            params = []
            for c, v in self._values.items():
                if isinstance(v, (list, dict)):
                    sets.append(f"{c} = %s::jsonb")
                    params.append(_json.dumps(v))
                else:
                    sets.append(f"{c} = %s")
                    params.append(v)
            # FAIL-CLOSED: an UPDATE without a WHERE predicate would
            # mutate the ENTIRE table (full-table wipe). Supabase's
            # PostgREST forbids this; the builder must too. Callers
            # that build .eq() inside an `if` (optional filter) are
            # exactly the danger — a None filter silently drops
            # the WHERE and wipes the table.
            if not (self._where or self._or_groups):
                raise ValueError(
                    f"Refusing UPDATE on '{self.table}' without a WHERE "
                    f"filter (would mutate every row)"
                )
            sql = f"UPDATE {self.table} SET {', '.join(sets)}{w} RETURNING *"
            return sql, params + p
        if self.op == "upsert":
            return self._compile_write(True)
        if self.op == "delete":
            sql = f"DELETE FROM {self.table}{w} RETURNING *"
            return sql, p
        raise ValueError(f"unknown op {self.op}")

    # ---- execute ----
    def execute(self):
        sql, params = self.compile()
        conn = get_conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, params)
            if self.op == "select":
                rows = cur.fetchall()
                if self._single:
                    if not rows:
                        raise Exception("JSON object requested, but 0 rows returned")
                    if len(rows) > 1:
                        # Supabase's .single() hard-fails (406) on multiple
                        # rows; mirror that so a caller that assumes a
                        # unique row can't silently read the WRONG one.
                        raise Exception(
                            f"JSON object requested, but {len(rows)} rows returned "
                            f"(expected exactly 1)"
                        )
                    data = _row_to_jsonable(rows[0])
                elif self._maybe_single:
                    if len(rows) > 1:
                        # .maybe_single() allows 0 or 1, but >1 is
                        # ambiguous — fail closed like Supabase.
                        raise Exception(
                            f"maybe_single got {len(rows)} rows (expected 0 or 1)"
                        )
                    data = _row_to_jsonable(rows[0]) if rows else None
                else:
                    data = [_row_to_jsonable(r) for r in rows]
            else:
                rows = cur.fetchall()
                data = [_row_to_jsonable(r) for r in rows]
            conn.commit()
            res = _Result(data)
            if self.op == "select" and self._want_count:
                # separate count (respects WHERE, ignores LIMIT/OFFSET)
                # C3 FIX: Run count query on the SAME connection to avoid
                # deadlock when pool is saturated (2nd get_conn() would block)
                try:
                    cc = conn.cursor()
                    csql, cparams = self._build_where()
                    cc.execute(f"SELECT count(*) AS count FROM {self.table}{csql}", cparams)
                    row = cc.fetchone()
                    res.count = row.get("count", 0) if row else 0
                    # Don't commit twice — same transaction
                except Exception as e:
                    logger.warn("count query failed", err=str(e)[:160])
                    res.count = 0
            return res
        except Exception:
            conn.rollback()
            raise
        finally:
            put_conn(conn)


def _jsonable(val):
    """Convert Postgres/Python types that json.dumps can't handle."""
    from datetime import datetime, date, time
    from decimal import Decimal
    import uuid
    if isinstance(val, (datetime, date, time)):
        return val.isoformat()
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, uuid.UUID):
        return str(val)
    if isinstance(val, (bytes, bytearray)):
        return val.decode("utf-8", "replace")
    return val


def _row_to_jsonable(row):
    return {k: _jsonable(v) for k, v in dict(row).items()}


class _Result:
    def __init__(self, data):
        self.data = data
        self.count = 0


class _Table:
    def __init__(self, name):
        self.name = name

    def select(self, cols="*", count=None):
        return _Query(self.name, "select").select(cols, count=count)

    def insert(self, row):
        return _Query(self.name, "insert").insert(row)

    def update(self, row):
        return _Query(self.name, "update").update(row)

    def upsert(self, row, on_conflict=None):
        return _Query(self.name, "upsert").upsert(row, on_conflict)

    def delete(self):
        return _Query(self.name, "delete").delete()


class _Client:
    """Mirrors supabase.Client surface used in the codebase."""

    def table(self, name):
        return _Table(name)

    def rpc(self, name, params=None):
        return _RpcCall(name, params or {})


class _RpcCall:
    def __init__(self, name, params):
        self.name = name
        self.params = params

    def execute(self):
        conn = get_conn()
        try:
            cur = conn.cursor()
            # psycopg2 calls function with kwargs via SELECT * FROM fn(p=>v)
            keys = list(self.params.keys())
            if keys:
                args = ", ".join(f"{k} => %s" for k in keys)
                sql = f"SELECT * FROM {self.name}({args})"
                cur.execute(sql, [self.params[k] for k in keys])
            else:
                cur.execute(f"SELECT * FROM {self.name}()")
            rows = cur.fetchall()
            conn.commit()
            # rpc returns rows; .data = list of dicts
            return _Result([dict(r) for r in rows])
        except Exception:
            conn.rollback()
            raise
        finally:
            put_conn(conn)


_client: _Client | None = None
_client_lock = threading.Lock()


def get_supabase() -> _Client:
    """Backwards-compatible name. Returns the direct-DB client."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                # touch pool to validate config at first use
                _get_pool()
                _client = _Client()
    return _client


def q(sql: str, params: list | None = None) -> list[dict]:
    """Run a raw parameterized SQL statement and return rows.

    Convenience for DDL / aggregates that the builder doesn't cover
    (e.g. ``CREATE TABLE``, ``count(*) WHERE ...``). Reuses the
    pooled connection so callers don't touch get_conn()/put_conn()
    directly. NEVER interpolate values into ``sql`` — pass them via
    ``params`` (psycopg2 %s placeholders).
    """
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(sql, params or [])
        try:
            rows = cur.fetchall()
        except Exception:
            rows = []
        conn.commit()
        return [_row_to_jsonable(r) for r in rows]
    except Exception:
        conn.rollback()
        raise
    finally:
        put_conn(conn)
