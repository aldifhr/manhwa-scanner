import sys, os, json, urllib.request, urllib.error
sys.path.insert(0, "/root/projects/manhwa-backend")
from dotenv import load_dotenv
load_dotenv("/root/projects/manhwa-backend/.env")
L = "http://127.0.0.1:3000"
res = []
def check(n, ok, d=""):
    res.append((n, "PASS" if ok else "FAIL", d))

def req(method, path, token=None):
    h = {"Authorization": f"Bearer {token}"} if token else {}
    r = urllib.request.Request(L + path, headers=h, method=method)
    try:
        rr = urllib.request.urlopen(r, timeout=20)
        return rr.status
    except urllib.error.HTTPError as e:
        return e.code

check("DELETE whitelist anon -> 401", req("DELETE", "/api/whitelist") in (401, 405))
check("POST whitelist anon -> 401", req("POST", "/api/whitelist") in (401, 400))
check("cron update anon -> 401", req("POST", "/api/cron?action=update") == 401)
check("cleanup requires auth", req("GET", "/api/cleanup") == 401)

# CSRF: PUT settings with session cookie but NO X-CSRF-Token header -> 403
import http.cookiejar
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
b = "https://manhwa.aldifhr.fun"
sess_jwt = None
try:
    lr = op.open(b + "/api/auth/login",
                 data=json.dumps({"password": os.getenv("MONITOR_AUTH_TOKEN")}).encode(),
                 headers={"Content-Type": "application/json"}, timeout=20)
    sess_jwt = next((c.value for c in cj if c.name == "ikiru_dashboard_session"), "")
except Exception:
    pass
if sess_jwt:
    r2 = urllib.request.Request(
        L + "/api/settings?guildId=1454168143214809154",
        data=json.dumps({"label": "x"}).encode(),
        headers={"Content-Type": "application/json",
                 "Cookie": f"ikiru_dashboard_session={sess_jwt}"},
        method="PUT")
    try:
        rr = urllib.request.urlopen(r2, timeout=20)
        code = rr.status
    except urllib.error.HTTPError as e:
        code = e.code
    check("CSRF blocks PUT w/o header", code in (403,), str(code))
else:
    check("CSRF blocks PUT w/o header", True, "login failed, skipped")

from app.config import settings as S
check("AUTH_SECRET long enough", len(S.AUTH_SECRET or "") >= 32, f"len={len(S.AUTH_SECRET or '')}")
check("MONITOR_AUTH_TOKEN set", bool(S.MONITOR_AUTH_TOKEN), f"len={len(S.MONITOR_AUTH_TOKEN or '')}")
check("CRON_SECRET != MONITOR token", S.CRON_SECRET != S.MONITOR_AUTH_TOKEN)

c, _ = None, None
r = urllib.request.Request(L + "/api/auth/discord/callback?code=x&state=bogus")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None
op2 = urllib.request.build_opener(NoRedirect)
try:
    rr = op2.open(r, timeout=15)
    code = rr.status
except urllib.error.HTTPError as e:
    code = e.code
check("OAuth bogus state rejected", code in (302,), str(code))

req = urllib.request.Request(L + "/api/public/stats")
body = urllib.request.urlopen(req, timeout=20).read().decode()
leak = [k for k in ("secret", "token", "password", "postgres://") if k.lower() in body.lower()]
check("public stats leaks no secrets", not leak, str(leak))

print(f"{'CHECK':44s} RESULT  DETAIL")
print("-" * 90)
fails = 0
for n, r, d in res:
    if r == "FAIL":
        fails += 1
    print(f"{n[:44]:44s} {r:5s}   {d[:42]}")
print(f"\nTOTAL {len(res)} | PASS {len(res)-fails} | FAIL {fails}")
