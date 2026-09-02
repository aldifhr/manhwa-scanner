"""Fuzzy slug alias resolver.

Finds whitelist title_keys that differ only by dash/space formatting or minor
typos (SequenceMatcher >= threshold) and MERGES them into one canonical key,
preserving the row with more history (latest_sent_chapter) and merging
sources. Run manually:

    python -m app.cron.alias_resolver          # dry-run report
    python -m app.cron.alias_resolver --apply  # actually merge

Merging rule per cluster:
  canonical = key of the member with highest latest_sent_chapter (ties -> older row)
  Members moved onto the canonical keep their own source; their title_key is
  rewritten, and duplicate (title_key, source) pairs are deleted.
"""
from __future__ import annotations

import difflib
import sys


def _clusters(keys: list[str], threshold: float = 0.87) -> list[list[str]]:
    """Greedy clustering: sort keys, group keys similar to the cluster seed.
    Dash/space-normalized equality always clusters regardless of ratio."""
    def norm(k: str) -> str:
        return k.replace("-", " ").strip().lower()

    remaining = sorted(set(keys))
    out: list[list[str]] = []
    while remaining:
        seed = remaining.pop(0)
        cluster = [seed]
        nseed = norm(seed)
        rest = []
        for b in remaining:
            if norm(b) == nseed:
                cluster.append(b)
            elif difflib.SequenceMatcher(None, seed, b).ratio() >= threshold:
                cluster.append(b)
            else:
                rest.append(b)
        remaining = rest
        if len(cluster) > 1:
            out.append(cluster)
        # singletons are dropped (nothing to merge)
    return out


def resolve(dry_run: bool = True) -> dict:
    from app.db_adapter import get_conn, put_conn
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """SELECT id, title_key, source, latest_sent_chapter, created_at FROM whitelist"""
    )
    rows = cur.fetchall()

    by_key: dict[str, list[tuple]] = {}
    for r in rows:
        by_key.setdefault(r[1].strip(), []).append(r)

    clusters = _clusters(list(by_key.keys()))
    merged = 0
    deleted = 0
    report = []

    for cluster in clusters:
        members = [m for k in cluster for m in by_key.get(k, [])]
        if len(members) < 2:
            continue
        # canonical = highest latest_sent_chapter (None treated as -1), tie -> oldest created_at
        members_sorted = sorted(
            members,
            key=lambda m: (
                float(m[3]) if m[3] is not None else -1.0,
                -m[4].timestamp() if m[4] else 0,
            ),
            reverse=True,
        )
        keep = members_sorted[0]
        drop_rows = [m for m in members_sorted[1:]]
        # delete drops whose source duplicates the keeper's source; others get rekeyed
        report.append({
            "canonical": keep[1],
            "absorbed": [m[1] for m in drop_rows],
            "rekeyed": [],
            "deleted": [],
        })
        if dry_run:
            continue
        seen_sources = {keep[2]}
        for m in drop_rows:
            if m[2] in seen_sources:
                cur.execute("DELETE FROM whitelist WHERE id=%s", (m[0],))
                deleted += 1
                report[-1]["deleted"].append(f"{m[1]} ({m[2]})")
            else:
                cur.execute(
                    "UPDATE whitelist SET title_key=%s WHERE id=%s",
                    (keep[1], m[0]),
                )
                seen_sources.add(m[2])
                merged += 1
                report[-1]["rekeyed"].append(f"{m[1]} -> {keep[1]} ({m[2]})")

    if not dry_run:
        conn.commit()
    put_conn(conn)
    return {"clusters": len(report), "merged": merged, "deleted": deleted, "report": report}


if __name__ == "__main__":
    apply = "--apply" in sys.argv
    result = resolve(dry_run=not apply)
    print(f"mode: {'APPLY' if apply else 'DRY-RUN'}")
    print(f"clusters: {result['clusters']} | rekeyed: {result['merged']} | deleted: {result['deleted']}")
    for r in result["report"]:
        print(json.dumps(r, indent=1) if (json := __import__("json")) else r)
