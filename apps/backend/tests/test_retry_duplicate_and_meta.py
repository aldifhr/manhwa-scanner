"""Retry must not re-send a chapter that was already delivered, and must carry
the same series metadata as a normal dispatch.

Live failure (2026-10-24): "The Mysterious World's Greatest Martial Artist
Little Prince" ch 139 appeared TWICE on the whitelist channel. The second
message had no description, no genres and "Released: Unknown".

Cause: the chapter sent fine on the live channel, but the legacy (deleted)
`channel_id` recorded a burst failure next to it. `retry_failed_dispatches()`
then rebuilt the embed from `recent_chapters` only — which holds no
genres/description/rating and no updated_time — and re-posted it.

    PYTHONPATH=. .venv/bin/python tests/test_retry_duplicate_and_meta.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def retry_never_resends_a_chapter_already_in_dispatch_history():
    from app.services.dispatch import retry as retry_mod

    src = inspect.getsource(retry_mod.retry_failed_dispatches)
    assert "dispatch_history" in src, "retry must consult dispatch_history"
    assert "already_sent" in src, "retry must skip chapters already notified"
    # the guard must run BEFORE the send attempt
    assert src.index("already_sent") < src.index("Attempt send"), (
        "the duplicate guard must run before any send"
    )


@case
def retry_embed_carries_series_meta_not_only_recent_chapters():
    from app.services.dispatch import retry as retry_mod

    src = inspect.getsource(retry_mod.retry_failed_dispatches)
    assert "series_meta" in src, "retry must merge static series metadata"
    assert 'sm_by_key.get(' in src, "retry must look the metadata up per (title_key, source)"
    assert 'meta.get("description") or _sm.get("description")' in src, (
        "retry dropped the description"
    )
    assert 'meta.get("genres") or _sm.get("genres")' in src, "retry dropped the genres"
    assert 'meta.get("cover") or _sm.get("cover")' in src, "retry dropped the cover"
    assert "updated_time=item[\"updated_time\"]" in src, (
        "retry dropped updated_time -> 'Released: Unknown'"
    )


@case
def dead_channels_are_pruned_from_the_channel_list():
    from app.cron import dispatch_mod as dm

    dm._DEAD_CHANNELS.clear()
    dm._DEAD_CHANNELS["dead-channel"] = __import__("time").monotonic()
    try:
        kept = dm._prune_dead_channels(["dead-channel", "live-channel"])
        assert kept == ["live-channel"], f"dead channel must be pruned, got {kept}"
    finally:
        dm._DEAD_CHANNELS.clear()


@case
def dead_channel_block_expires():
    import time as _t

    from app.cron import dispatch_mod as dm

    dm._DEAD_CHANNELS.clear()
    dm._DEAD_CHANNELS["old"] = _t.monotonic() - (dm._DEAD_CHANNEL_TTL + 1)
    try:
        kept = dm._prune_dead_channels(["old"])
        assert kept == ["old"], "an expired block must not keep the channel out"
    finally:
        dm._DEAD_CHANNELS.clear()


@case
def load_channels_filters_dead_channels():
    from app.cron import dispatch_mod as dm

    import app.db as _db

    dm._DEAD_CHANNELS.clear()
    dm._DEAD_CHANNELS["111"] = __import__("time").monotonic()

    class _Q:
        def select(self, _c):
            return self

        def execute(self):
            return type("D", (), {"data": [
                {"channel_id": "111", "raw_channel_id": "222", "whitelist_channel_id": "333"}
            ]})()

    class _SB:
        def table(self, _t):
            return _Q()

    _db.__dict__["get_supabase"] = lambda: _SB()
    try:
        assert dm._load_channels() == ["222", "333"], dm._load_channels()
    finally:
        _db.__dict__.pop("get_supabase", None)
        dm._DEAD_CHANNELS.clear()


def main():
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  pass  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {e}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
