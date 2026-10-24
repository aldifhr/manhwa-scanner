"""The "Add to whitelist" button must not claim a new add when the row exists.

Observed live: clicking the button on an already-subscribed series still wrote
the row again and answered "✅ X added to the whitelist", which reads as "I just
added something that already existed". The write is an idempotent upsert, so no
duplicate row is created — but the message is wrong.

    PYTHONPATH=. .venv/bin/python tests/test_wladd_already_subscribed.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def the_button_checks_the_row_before_writing():
    from app.discord.router import _route_whitelist_add

    src = inspect.getsource(_route_whitelist_add)
    assert "get_whitelist_entry" in src, "the button must check for an existing row"
    assert '"already": True' in src, "an existing row must be reported as already"
    # the check must precede the write, not follow it
    assert src.index("get_whitelist_entry") < src.index("add_whitelist_entries"), (
        "the existence check must run before the upsert"
    )


@case
def the_already_case_gets_its_own_message():
    from app.discord.router import _route_whitelist_add

    src = inspect.getsource(_route_whitelist_add)
    assert '.get("already")' in src, "the already-branch must be handled"
    assert "already in the whitelist" in src, (
        "an already-subscribed series must not be told it was just added"
    )


@case
def the_lookup_reads_the_db_not_the_snapshot_cache():
    from app.storage import whitelist as wl_store

    src = inspect.getsource(wl_store.get_whitelist_entry)
    # strip the docstring: it names the cache it deliberately avoids
    body = src.split('"""', 2)[-1]
    assert "load_whitelist" not in body, (
        "must not go through the 600s load_whitelist() snapshot — it predates the write"
    )
    assert '.eq("title_key"' in body and '.eq("source"' in body, (
        "the lookup must be scoped to the composite PK"
    )


@case
def the_lookup_fails_open():
    """A broken check must not block the write — None means "not found, write it"."""
    from app.storage import whitelist as wl_store

    assert wl_store.get_whitelist_entry("", "shinigami") is None
    assert wl_store.get_whitelist_entry("slug", "") is None


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
