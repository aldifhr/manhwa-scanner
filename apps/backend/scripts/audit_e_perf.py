import os, json, subprocess, time
from dotenv import load_dotenv
load_dotenv("/root/projects/manhwa-backend/.env")
res = []
def check(n, ok, d=""):
    res.append((n, "PASS" if ok else "FAIL", d))

# PM2 process health
out = subprocess.run(["pm2", "jlist"], capture_output=True, text=True).stdout
apps = {a["name"]: a for a in json.loads(out)}
mb = apps.get("manhwa-backend")
if mb:
    status = mb["pm2_env"]["status"]
    restarts = mb["pm2_env"]["restart_time"]
    mem = mb["monit"]["memory"] // 1048576
    uptime_min = (time.time() * 1000 - mb["pm2_env"]["pm_uptime"]) / 60000
    check("PM2: backend online", status == "online", status)
    check("PM2: stable uptime >60min", uptime_min > 60, f"{uptime_min:.0f} min")
    check("PM2: mem sane (<400mb)", 0 < mem < 400, f"{mem} mb")
else:
    check("PM2: backend exists", False, "not found")

# DB connection pool + latency
t0 = time.time()
import psycopg2
conn = psycopg2.connect(os.getenv("DATABASE_URL"))
cur = conn.cursor()
latency_ms = (time.time() - t0) * 1000
check("DB: connect latency <200ms", latency_ms < 200, f"{latency_ms:.0f} ms")

cur.execute("SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()")
conns = cur.fetchone()[0]
check("DB: connections sane (<20)", conns < 20, f"{conns}")

# API latency spot-checks
import urllib.request
def timed(path):
    t = time.time()
    try:
        req = urllib.request.Request("http://127.0.0.1:3000" + path)
        urllib.request.urlopen(req, timeout=30).read()
        return (time.time() - t) * 1000
    except Exception:
        return 99999

for p in ["/healthz", "/api/rss?limit=50", "/api/public/stats"]:
    ms = timed(p)
    check(f"latency {p.split('?')[0]} <2s", ms < 2000, f"{ms:.0f} ms")

print(f"{'CHECK':40s} RESULT  DETAIL")
print("-" * 90)
fails = 0
for n, r, d in res:
    if r == "FAIL":
        fails += 1
    print(f"{n[:40]:40s} {r:5s}   {d[:42]}")
print(f"\nTOTAL {len(res)} | PASS {len(res)-fails} | FAIL {fails}")
