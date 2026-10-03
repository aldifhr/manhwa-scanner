"""Record the watchdog's stalled-chapter metrics once a day.

The 2h urgent threshold (watchdog._URGENT_AGE_H) was chosen from seven log
samples, which is too thin to tell whether it silences the one-cycle noise
without also silencing a genuinely stuck queue. Only runtime data settles it.

Runs a fixed probe -- not the live dispatcher -- so it never claims rows or
marks anything sent. Writes one JSON line per run to a log file.

Run from cron daily, or by hand:
    PYTHONPATH=. .venv/bin/python tools/watchdog_probe.py
"""
import json
import os
from datetime import datetime, timezone

OUT = "/root/.hermes/cache/scratch/watchdog_daily.jsonl"
THRESHOLD = 2


def main() -> int:
    from app.cron import watchdog as w

    stalled = w._stalled_chapters(24)
    urgent = [c for c in stalled if c["age_h"] >= w._URGENT_AGE_H]

    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "stalled": len(stalled),
        "urgent": len(urgent),
        "threshold_h": w._URGENT_AGE_H,
        "oldest_h": round(max((c["age_h"] for c in stalled), default=0.0), 2),
        "by_source": {},
    }
    for c in stalled:
        src = c.get("source") or "?"
        record["by_source"][src] = record["by_source"].get(src, 0) + 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "a") as fh:
        fh.write(json.dumps(record) + "\n")

    print(json.dumps(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())