"""Guard the two invariants /api/v1/undelivered depends on.

Both are silent-failure risks, not crashes: if either broke, the page would
either under-report real misses or offer to resend chapters the reader
already got.

Run: PYTHONPATH=. .venv/bin/python tests/test_undelivered_invariants.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

FAILED: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


SRC = Path(__file__).resolve().parents[1] / "app" / "api" / "dispatch" / "undelivered.py"
src = SRC.read_text()

print("1. cross-source FCFS dedupe")

# The whole reason this endpoint is not just `NOT EXISTS dispatch_history`:
# a chapter sent from shinigami has no ledger row for the voratoon (title_key,
# source) pair, yet the reader received it. Resending would double-post.
check(
    "query uses dispatch_history dedupe",
    "NOT EXISTS" in src and "dispatch_history" in src,
)
check(
    "cross-source dedupe via fcfs_key, not just title_key+chapter",
    "fcfs_key(" in src and "skipped_already_sent" in src,
    "must subtract chapters already sent from another source",
)
check(
    "sends the fcfs_key built the same way dispatch() does",
    # canonical form is title_key with dashes; fcfs_key slugifies internally
    "tk.replace(\"-\", \" \")" in src,
    "fcfs_key() must receive the same normalization the writer used",
)

print("\n2. resend cannot double-post")
check(
    "resend goes through the real dispatch path",
    "_dispatch(" in src and "dispatch_mod import dispatch" in src,
    "hand-rolled embeds would bypass the whitelist and dedupe guards",
)
check(
    "force + skip_ceiling are explicit and paired",
    "force=True" in src and "skip_ceiling=True" in src,
    "skip_ceiling is the escape hatch this feature exists to use",
)
check(
    "bypass_window=True is set (else old chapters only get a silent ledger row)",
    "bypass_window=True" in src,
    "without it _split_send_backfill routes >24h items to to_backfill, which "
    "writes dispatch_history but sends no Discord post -- verified sent:0",
)
check(
    "chapter rows are re-read from the DB, not taken from the request",
    '.table("recent_chapters")' in src,
    "trusting caller-supplied title/cover would allow an injected embed",
)

print("\n3. no phantom columns")
# recent_chapters has no `url` column; selecting it raised UndefinedColumn
# which the broad except collapsed into a bare "lookup failed".
m = re.search(r'\.select\("([^"]+)"\)', src)
cols = m.group(1).split(",") if m else []
check(
    "no `url` column in the recent_chapters select",
    "url" not in cols,
    f"select={cols}",
)
check("chapter_url is selected", "chapter_url" in cols)

print("\n4. custom logger: fields, never %-style")
# Logger.warn(msg, **fields) does not %-format. A %s printed literally and
# silently dropped the value; this bit the whole codebase once already.
bad = re.findall(r'logger\.\w+\("[^"]*%[sdf]', src)
check("no %-style placeholders in logger calls", not bad, f"found {len(bad)}: {bad[:3]}")

print("\n5. auth")
check("GET is monitor-auth gated", src.count("require_monitor_auth") >= 2)
check("POST is monitor-auth gated", "require_monitor_auth" in src.split("resend_undelivered")[1])

print()
if FAILED:
    print(f"FAILED: {len(FAILED)} -> {', '.join(FAILED)}")
    sys.exit(1)
print("All undelivered invariants hold.")