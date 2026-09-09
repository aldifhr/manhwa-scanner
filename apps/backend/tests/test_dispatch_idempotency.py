"""Integration tests for dispatch idempotency.

Verifies:
1. Concurrent claim_recent_chapters_for_dispatch() calls produce exactly one
   claim per chapter (fcfs_key) — no duplicate Discord sends.
2. dispatch_history insert is idempotent via ON CONFLICT (upsert semantics).

Concurrency is simulated with threading + a fake connection that tracks state
and enforces DB semantics (ON CONFLICT raises on duplicate fcfs_key).
"""
import threading
from unittest.mock import MagicMock, patch

import pytest

from app.services.claim import claim_recent_chapters_for_dispatch
from app.services.shared import fcfs_key


# ── Fake DB layer ────────────────────────────────────────────────────────────

class FakeCursor:
    """Simulates a psycopg2 cursor with real-ish dispatch table semantics.

    Tracks inserted claims and raises on duplicate fcfs_key (ON CONFLICT
    simulation) so we can verify idempotency without a real PostgreSQL.
    """

    def __init__(self, recent_chapters, dispatched_urls=None,
                 dispatched_fcfs=None, claimed_fcfs=None):
        self.recent_chapters = list(recent_chapters or [])
        self.dispatched_urls = set(dispatched_urls or [])
        self.dispatched_fcfs = set(dispatched_fcfs or [])
        self.claimed_fcfs = set(claimed_fcfs or [])
        self.inserted_fcfs = set()  # tracks successful INSERT ... ON CONFLICT
        self._last_result = []

    def execute(self, sql, params=None):
        s = sql.upper()
        if "SELECT * FROM RECENT_CHAPTERS" in s:
            self._last_result = list(self.recent_chapters)
        elif "SELECT CHAPTER_URL FROM DISPATCH_HISTORY" in s:
            urls = [p for p in (params or []) if isinstance(p, str) and p.startswith("http")]
            self._last_result = [{"chapter_url": u} for u in urls if u in self.dispatched_urls]
        elif "SELECT FCFS_KEY FROM DISPATCH_HISTORY" in s:
            keys = [p for p in (params or []) if isinstance(p, str) and "#" in p]
            self._last_result = [{"fcfs_key": k} for k in keys if k in self.dispatched_fcfs]
        elif "SELECT FCFS_KEY FROM DISPATCH_CLAIMS" in s:
            keys = [p for p in (params or []) if isinstance(p, str) and "#" in p]
            self._last_result = [{"fcfs_key": k} for k in keys if k in self.claimed_fcfs]
        elif "SELECT TITLE_KEY, CHAPTER_TITLE FROM DISPATCH_HISTORY" in s:
            self._last_result = []
        elif "INSERT INTO DISPATCH_CLAIMS" in s:
            # Simulate ON CONFLICT (fcfs_key): raise if already inserted
            vals = list(params or [])
            row_sz = 6  # title_key, chapter_url, fcfs_key, created_at, expires_at, status
            for i in range(0, len(vals), row_sz):
                fk = vals[i + 2]  # fcfs_key is 3rd column
                if fk in self.inserted_fcfs:
                    raise Exception(
                        'duplicate key value violates unique constraint '
                        '"dispatch_claims_fcfs_key_key"'
                    )
                self.inserted_fcfs.add(fk)
            self._last_result = []
        else:
            self._last_result = []

    def fetchall(self):
        return list(self._last_result)


class FakeConn:
    """Simulates a psycopg2 connection for the claim path."""

    def __init__(self, cursor):
        self.cursor_inst = cursor
        self.committed = False
        self.rolled_back = False
        self.autocommit = True

    def cursor(self):
        return self.cursor_inst

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    @property
    def closed(self):
        return False


# ── Test data builders ────────────────────────────────────────────────────────

def _rows(title_key, source, chapters=(1, 2, 3)):
    """Build recent_chapters rows."""
    out = []
    for ch in chapters:
        out.append({
            "id": len(out) + 1,
            "title": title_key.replace("-", " ").title(),
            "title_key": title_key,
            "source": source,
            "chapter": str(ch),
            "chapter_num": ch,
            "chapter_url": f"https://{source}.example/{title_key}/ch{ch}",
            "series_url": f"https://{source}.example/series/{title_key}",
            "origin": "KR",
            "cover": f"https://cover.example/{title_key}.webp",
            "updated_time": "2026-09-08T12:00:00Z",
        })
    return out


def _whitelist(title_key, source, latest=0):
    return [{"title_key": title_key, "source": source, "latest_sent_chapter": latest}]


# ── Test: exactly-one-claim under concurrency ────────────────────────────────

class TestClaimConcurrency:
    """Concurrent claim_recent_chapters_for_dispatch → exactly one claim/chapter."""

    def _run_concurrent(self, n_threads, shared_cursor, barrier):
        """Launch n_threads that each call claim_recent_chapters_for_dispatch."""
        results = []
        results_lock = threading.Lock()
        errors = []

        def worker():
            conn = FakeConn(shared_cursor)
            try:
                # claim.py imports get_conn at module level — must patch at usage site
                with patch("app.services.claim.get_conn", return_value=conn), \
                     patch("app.services.claim.put_conn"):
                    barrier.wait(timeout=5)
                    r = claim_recent_chapters_for_dispatch(
                        whitelist=_whitelist("tower", "shinigami"),
                        hours=24,
                        limit=500,
                    )
                    with results_lock:
                        results.append(r)
            except Exception as e:
                with results_lock:
                    errors.append(e)

        threads = [threading.Thread(target=worker) for _ in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        return results, errors

    def test_two_threads_shared_cursor_exactly_three_claims(self):
        """Two threads sharing one cursor → exactly 3 unique fcfs_keys inserted."""
        rows = _rows("tower", "shinigami")
        cursor = FakeCursor(rows)
        barrier = threading.Barrier(2, timeout=5)

        results, errors = self._run_concurrent(2, cursor, barrier)

        assert not errors, f"Unexpected errors: {errors}"
        # The DB-level ON CONFLICT prevents duplicate inserts even if both
        # threads independently decide to claim the same fcfs_key.
        assert len(cursor.inserted_fcfs) == 3, (
            f"Expected 3 unique claims, got {len(cursor.inserted_fcfs)}: "
            f"{cursor.inserted_fcfs}"
        )

    def test_three_threads_shared_cursor_no_duplicate_inserts(self):
        """Three threads → still exactly 3 unique fcfs_keys."""
        rows = _rows("tower", "shinigami")
        cursor = FakeCursor(rows)
        barrier = threading.Barrier(3, timeout=5)

        results, errors = self._run_concurrent(3, cursor, barrier)

        assert not errors
        assert len(cursor.inserted_fcfs) == 3

    def test_duplicate_fcfs_in_batch_deduped_by_seen_set(self):
        """Two rows with same title+chapter (different URLs) → one claim."""
        rows = [
            {"id": 1, "title": "Tower", "title_key": "tower", "source": "shinigami",
             "chapter": "1", "chapter_num": 1, "chapter_url": "https://a/x",
             "series_url": "https://s/tower", "origin": "KR",
             "cover": "https://c/t.webp", "updated_time": "2026-09-08T12:00:00Z"},
            {"id": 2, "title": "Tower", "title_key": "tower", "source": "shinigami",
             "chapter": "1", "chapter_num": 1, "chapter_url": "https://b/y",
             "series_url": "https://s/tower", "origin": "KR",
             "cover": "https://c/t.webp", "updated_time": "2026-09-08T12:00:00Z"},
        ]
        cursor = FakeCursor(rows)

        def mock_get_conn():
            return FakeConn(cursor)

        with patch("app.services.claim.get_conn", side_effect=mock_get_conn), \
             patch("app.services.claim.put_conn"):
            result = claim_recent_chapters_for_dispatch(
                whitelist=_whitelist("tower", "shinigami"),
                hours=24,
                limit=500,
            )

        # _seen_fcfs in Python dedups before INSERT → only 1 unique claim
        assert len(cursor.inserted_fcfs) == 1
        # The returned list may have both rows (to_claim includes both candidates)
        # but the claim insert is deduped.
        assert len(result) == 2

    def test_already_dispatched_in_history_skipped(self):
        """Chapters already in dispatch_history must not be re-claimed."""
        rows = _rows("tower", "shinigami")
        dispatched_urls = {rows[0]["chapter_url"]}
        dispatched_fcfs = {fcfs_key(rows[0]["title"], rows[0]["chapter"])}
        cursor = FakeCursor(rows, dispatched_urls=dispatched_urls,
                           dispatched_fcfs=dispatched_fcfs)

        def mock_get_conn():
            return FakeConn(cursor)

        with patch("app.services.claim.get_conn", side_effect=mock_get_conn), \
             patch("app.services.claim.put_conn"):
            result = claim_recent_chapters_for_dispatch(
                whitelist=_whitelist("tower", "shinigami"),
                hours=24,
                limit=500,
            )

        assert len(result) == 2
        assert len(cursor.inserted_fcfs) == 2

    def test_already_claimed_in_claims_skipped(self):
        """Chapters already in dispatch_claims must not be re-claimed."""
        rows = _rows("tower", "shinigami")
        claimed_fcfs = {fcfs_key(rows[0]["title"], rows[0]["chapter"])}
        cursor = FakeCursor(rows, claimed_fcfs=claimed_fcfs)

        def mock_get_conn():
            return FakeConn(cursor)

        with patch("app.services.claim.get_conn", side_effect=mock_get_conn), \
             patch("app.services.claim.put_conn"):
            result = claim_recent_chapters_for_dispatch(
                whitelist=_whitelist("tower", "shinigami"),
                hours=24,
                limit=500,
            )

        assert len(result) == 2
        assert len(cursor.inserted_fcfs) == 2

    def test_lock_contention_second_thread_gets_no_rows(self):
        """Simulate SKIP LOCKED: second SELECT returns empty (rows held by first thread)."""
        rows = _rows("tower", "shinigami")
        call_count = [0]

        class LockContentionCursor(FakeCursor):
            def execute(self, sql, params=None):
                if "SELECT * FROM RECENT_CHAPTERS" in sql.upper():
                    call_count[0] += 1
                    if call_count[0] == 1:
                        self._last_result = list(rows)
                    else:
                        # SKIP LOCKED: rows are locked, return nothing
                        self._last_result = []
                else:
                    super().execute(sql, params)

        cursor = LockContentionCursor(rows)
        barrier = threading.Barrier(2, timeout=5)

        results, errors = self._run_concurrent(2, cursor, barrier)

        assert not errors
        # At most 3 claims (the thread that got the rows)
        assert len(cursor.inserted_fcfs) <= 3


# ── Test: dispatch_history idempotency ───────────────────────────────────────

class TestDispatchHistoryIdempotency:
    """complete_dispatch_claim() must be idempotent (upsert, not insert)."""

    def test_duplicate_call_does_not_raise(self):
        """Two calls with same fcfs_key → no exception (upsert semantics)."""
        from app.storage.dispatch import complete_dispatch_claim

        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            for _ in range(2):
                complete_dispatch_claim(
                    chapter_url="https://x/ch1",
                    duplicate_url=None,
                    instance_id="test",
                    title_key="tower",
                    source="shinigami",
                    fcfs_key="tower#1",
                    chapter_title="Ch 1",
                    cover="https://c/1.webp",
                    series_url="https://s/x",
                )

        assert mock_sb.table.return_value.upsert.call_count == 2

    def test_fallback_to_chapter_url_on_invalid_column(self):
        """If ON CONFLICT (fcfs_key) raises InvalidColumnReference, fall back to chapter_url."""
        from app.storage.dispatch import complete_dispatch_claim

        mock_sb = MagicMock()
        first = MagicMock()
        first.execute.side_effect = Exception(
            'column "fcfs_key" referenced in ON CONFLICT does not exist'
        )
        second = MagicMock()
        second.execute.return_value = MagicMock()
        mock_sb.table.return_value.upsert.side_effect = [first, second]

        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            # Must not raise
            complete_dispatch_claim(
                chapter_url="https://x/ch1",
                duplicate_url=None,
                instance_id="test",
                title_key="tower",
                fcfs_key="tower#1",
            )

        assert mock_sb.table.return_value.upsert.call_count == 2

    def test_dispatch_history_uq_duplicate_is_noop(self):
        """Duplicate dispatch_history_uq error must be swallowed (already-sent)."""
        from app.storage.dispatch import complete_dispatch_claim

        mock_sb = MagicMock()
        err_call = MagicMock()
        err_call.execute.side_effect = Exception(
            'duplicate key value violates unique constraint "dispatch_history_uq"'
        )
        ok_call = MagicMock()
        ok_call.execute.return_value = MagicMock()
        # First call fails with history_uq, second is never reached (caught by outer fallback)
        mock_sb.table.return_value.upsert.side_effect = [err_call]

        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            # Must not raise
            complete_dispatch_claim(
                chapter_url="https://x/ch1",
                duplicate_url=None,
                instance_id="test",
                title_key="tower",
                source="shinigami",
                fcfs_key="tower#1",
            )
