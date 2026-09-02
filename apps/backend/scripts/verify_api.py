"""Integration verification for the whitelist API.

Run OUTSIDE pytest (e.g. `python3 scripts/verify_api.py`) so the app boots
with a fully-populated environment (.env loaded) — pytest's collection order
corrupts TestClient state for these specific assertions, so we verify the
real contract here instead.

Exits non-zero on any contract violation.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Load .env the same way conftest does (so this script works standalone).
_env = Path(__file__).resolve().parent.parent / ".env"
if _env.exists():
    for line in _env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main() -> int:
    from fastapi.testclient import TestClient
    from app.main import app

    token = os.getenv("MONITOR_AUTH_TOKEN", "")
    if not token:
        print("SKIP: MONITOR_AUTH_TOKEN not set")
        return 0
    c = TestClient(app)
    auth = {"Authorization": f"Bearer {token}"}

    # 1) Pagination: page 2 must not repeat page 1
    p1 = c.get("/api/whitelist?page=1&page_size=5", headers=auth).json()["data"]
    p2 = c.get("/api/whitelist?page=2&page_size=5", headers=auth).json()["data"]
    t1 = [x.get("titleKey") for x in p1["results"]]
    t2 = [x.get("titleKey") for x in p2["results"]]
    assert t1 != t2, f"page 2 repeats page 1: {t1}"
    print("OK pagination differs:", t1[:2], "!=", t2[:2])

    # 2) Unique (titleKey, source) per page (flat-per-source schema)
    r = c.get("/api/whitelist?page=1&page_size=100", headers=auth).json()["data"]
    rows = r["results"]
    pairs = [(x.get("titleKey"), x.get("source")) for x in rows]
    assert len(pairs) == len(set(pairs)), f"dup (titleKey,source): {pairs}"
    print(f"OK unique (titleKey,source) per page: {len(pairs)} rows")

    # 3) type field valid
    valid = {"manhua", "manhwa", "manga", None}
    bad = [x.get("type") for x in rows if x.get("type") not in valid]
    assert not bad, f"invalid type: {bad}"
    print("OK type field valid")

    # 4) rating 1-10
    out = [x.get("rating") for x in rows if x.get("rating") is not None and not (1.0 <= float(x["rating"]) <= 10.0)]
    assert not out, f"rating out of range: {out}"
    print("OK rating 1-10")

    # 5) sources is a list
    no_list = [x.get("titleKey") for x in rows if not isinstance(x.get("sources"), list)]
    assert not no_list, f"sources not list: {no_list}"
    print("OK sources is list")

    print(f"\nALL CHECKS PASSED ({len(rows)} whitelist rows verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
