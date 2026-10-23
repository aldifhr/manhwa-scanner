"""The "Add to whitelist" button must honour WHITELIST_ROLE_IDS.

An empty list keeps the open behaviour; a non-empty list is authoritative.

    PYTHONPATH=. python3 tests/test_wladd_role_gate.py
"""
CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _payload(*roles):
    return {"member": {"roles": list(roles)}}


@case
def empty_config_allows_everyone():
    from app.config import settings
    from app.discord.router import _wl_add_allowed

    old = settings.WHITELIST_ROLE_IDS
    object.__setattr__(settings, "WHITELIST_ROLE_IDS", "")
    try:
        assert _wl_add_allowed(_payload()) is True
    finally:
        object.__setattr__(settings, "WHITELIST_ROLE_IDS", old)


@case
def a_listed_role_passes():
    from app.config import settings
    from app.discord.router import _wl_add_allowed

    old = settings.WHITELIST_ROLE_IDS
    object.__setattr__(settings, "WHITELIST_ROLE_IDS", "111,222")
    try:
        assert _wl_add_allowed(_payload("999", "222")) is True
    finally:
        object.__setattr__(settings, "WHITELIST_ROLE_IDS", old)


@case
def an_unlisted_role_is_rejected():
    from app.config import settings
    from app.discord.router import _wl_add_allowed

    old = settings.WHITELIST_ROLE_IDS
    object.__setattr__(settings, "WHITELIST_ROLE_IDS", "111,222")
    try:
        assert _wl_add_allowed(_payload("999")) is False
        assert _wl_add_allowed(_payload()) is False
        assert _wl_add_allowed({}) is False
    finally:
        object.__setattr__(settings, "WHITELIST_ROLE_IDS", old)


@case
def the_gate_runs_before_the_db_write():
    import inspect

    from app.discord import router

    src = inspect.getsource(router._route_whitelist_add)
    assert src.index("_wl_add_allowed(payload)") < src.index("add_whitelist_entries"), (
        "role check sits after the write — a rejected user would still be added"
    )


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
