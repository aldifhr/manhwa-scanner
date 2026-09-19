"""
debug_shinigami.py — Verifikasi scraper Shinigami bener / nggak.

Run:  python debug_shinigami.py
      python debug_shinigami.py --no-live   (tanpa hit API, cek kontrak lokal aja)

Cek:
 1) config BASE/API/PUBLIC
 2) SSRF allowlist
 3) Circuit breaker state
 4) Pydantic contract (models)
 5) Live API: /manga/list (mirror/project, is_update true/false), /manga/detail, /chapter/list, search
 6) Collector _collect_shinigami_source (apakah chapters embedded di latest?)

Bukan bagian dari pipeline — file debug standalone.
"""
import os
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", "postgresql://dummy:dummy@localhost/dummy")
os.environ.setdefault("CRON_SECRET", "dummy")
os.environ.setdefault("MONITOR_AUTH_TOKEN", "dummy")
os.environ.setdefault("AUTH_SECRET", "dummy-dummy-dummy-dummy-32chars!!")
os.environ.setdefault("DISCORD_BOT_TOKEN", "dummy")
os.environ.setdefault("DASHBOARD_PASSWORD", "dummy")

import sys
import json
import argparse
from pathlib import Path

# Ensure app importable
sys.path.insert(0, str(Path(__file__).parent))

parser = argparse.ArgumentParser()
parser.add_argument("--no-live", action="store_true", help="skip live HTTP calls")
parser.add_argument("--manga-id", default=None, help="force test manga_id (default: ambil dari latest)")
args = parser.parse_args()

def hdr(title):
    print("\n" + "="*72)
    print(f" {title}")
    print("="*72)

def ok(msg): print(f"  [OK] {msg}")
def warn(msg): print(f"  [WARN] {msg}")
def fail(msg): print(f"  [FAIL] {msg}")
def info(msg): print(f"  [INFO] {msg}")

# ── 1. Config ──────────────────────────────────────────────────
hdr("1) CONFIG — Shinigami BASE/API/PUBLIC")
try:
    from app.config import settings
    base = settings.SECONDARY_SOURCE_URL.rstrip("/")
    api = f"{base}/v1"
    pub = settings.SECONDARY_PUBLIC_BASE.rstrip("/")
    # lazy helpers
    from app.scrapers.shinigami import _base, _api, _public
    lazy_base = _base()
    lazy_api = _api()
    lazy_pub = _public()
    print(f"  settings.SECONDARY_SOURCE_URL : {settings.SECONDARY_SOURCE_URL}")
    print(f"  settings.SHINIGAMI_API_URL    : {settings.SHINIGAMI_API_URL}")
    print(f"  settings.SHINIGAMI_API_BASE   : {settings.SHINIGAMI_API_BASE}")
    print(f"  settings.SHINIGAMI_PUBLIC_BASE: {settings.SHINIGAMI_PUBLIC_BASE}")
    print(f"  computed API                  : {api}")
    print(f"  computed PUBLIC               : {pub}")
    print(f"  _base()                       : {lazy_base}")
    print(f"  _api()                        : {lazy_api}")
    print(f"  _public()                     : {lazy_pub}")
    # juga cek ikiru alias sync
    print(f"  IKIRU_BASE_URL                : {settings.IKIRU_BASE_URL}")
    if lazy_base != base or lazy_api != api:
        warn("lazy _base/_api mismatch computed vs helper — cek _sync_aliases")
    else:
        ok("BASE/API/PUBLIC konsisten")
    if not base.startswith("https://"):
        fail(f"BASE tidak https: {base}")
    if "shngm.io" not in base and "shinigami" not in base:
        warn(f"BASE tidak mengandung shngm.io/shinigami: {base}")
except Exception as e:
    fail(f"config error: {e}")
    import traceback; traceback.print_exc()

# ── 2. SSRF allowlist ─────────────────────────────────────────
hdr("2) SSRF — assert_allowed_url untuk Shinigami")
try:
    from app.utils.ssrf import assert_allowed_url, ALLOWED_SUFFIXES
    from app.scrapers.shinigami import _api as _api_fn
    test_urls = [
        f"{_api_fn()}/manga/list?type=mirror&page=1&page_size=10",
        f"{_api_fn()}/manga/detail/test123",
        f"{_api_fn()}/chapter/test123/list?page=1&page_size=10&sort_by=chapter_number&sort_order=desc",
        "https://api.shngm.io/v1/manga/list",
        "https://11.shinigami.asia/series/test",
    ]
    for u in test_urls:
        try:
            assert_allowed_url(u)
            ok(f"allowed: {u}")
        except Exception as ex:
            fail(f"blocked (harusnya allowed): {u} -> {ex}")
    # harusnya block
    try:
        assert_allowed_url("https://evil.com/v1/manga/list")
        fail("evil.com lolos SSRF — allowlist bocor!")
    except Exception:
        ok("evil.com correctly blocked")
    print(f"  ALLOWED_SUFFIXES: {ALLOWED_SUFFIXES}")
except Exception as e:
    fail(f"ssrf error: {e}")
    import traceback; traceback.print_exc()

# ── 3. Circuit breaker ────────────────────────────────────────
hdr("3) CIRCUIT BREAKER — cb_shinigami")
try:
    from app.services.resilience import cb_shinigami
    print(f"  name: {cb_shinigami.name}")
    print(f"  state: {cb_shinigami.state}")
    print(f"  failures: {cb_shinigami._failures} / threshold {cb_shinigami.failure_threshold}")
    print(f"  recovery_timeout: {cb_shinigami.recovery_timeout}s")
    print(f"  allow(): {cb_shinigami.allow()}")
    if cb_shinigami.state.value != "closed":
        warn(f"circuit tidak CLOSED: {cb_shinigami.state} — live call akan di-skip")
    else:
        ok("circuit CLOSED — live call allowed")
except Exception as e:
    fail(f"cb error: {e}")

# ── 4. Pydantic contracts ─────────────────────────────────────
hdr("4) PYDANTIC CONTRACTS — models.py vs tests")
try:
    from app.scrapers.shinigami.models import ShinigamiLatestResponse, ShinigamiDetailResponse
    # valid latest
    r = ShinigamiLatestResponse.model_validate({"data": [{"manga_id": "42"}]})
    assert r.data[0].manga_id == "42"
    ok("ShinigamiLatestResponse accepts {'data':[{'manga_id':'42'}]}")
    # invalid field name
    try:
        ShinigamiLatestResponse.model_validate({"results": []})
        fail("ShinigamiLatestResponse harus reject {'results':[]}")
    except Exception:
        ok("ShinigamiLatestResponse correctly rejects {'results':[]}")
    # detail rejects list
    try:
        ShinigamiDetailResponse.model_validate({"data": []})
        fail("ShinigamiDetailResponse harus reject {'data':[]}")
    except Exception:
        ok("ShinigamiDetailResponse correctly rejects list data")
    # detail accepts dict
    d = ShinigamiDetailResponse.model_validate({"data": {"manga_id": "x", "title":"T"}})
    ok(f"ShinigamiDetailResponse accepts dict data: keys={list(d.data.keys())[:5]}")
    # also cek path lama yang dipakai test (app.scrapers.shinigami_models) — ada symlink/shim?
    try:
        import importlib; importlib.import_module("app.scrapers.shinigami_models")
        warn("app.scrapers.shinigami_models exists (shim) — test import will use it")
    except ModuleNotFoundError:
        info("app.scrapers.shinigami_models TIDAK ada — test_shinigami_contract.py import akan FAIL (harus app.scrapers.shinigami.models)")
        # cek test file
        test_path = Path(__file__).parent / "tests" / "test_shinigami_contract.py"
        if test_path.exists():
            txt = test_path.read_text()
            if "shinigami_models" in txt:
                fail(f"test file {test_path} import 'app.scrapers.shinigami_models' — file tidak ada, pytest akan ModuleNotFoundError. Fix: ganti ke app.scrapers.shinigami.models")
    # extra fields allowed
    r2 = ShinigamiLatestResponse.model_validate({"data": [{"manga_id": 123, "country_id":"KR", "chapters":[]}], "extra":"x"})
    ok(f"extra fields allowed: manga_id type={type(r2.data[0].manga_id).__name__}, data len={len(r2.data)}")
except Exception as e:
    fail(f"contract error: {e}")
    import traceback; traceback.print_exc()

# ── 5 & 6 Live API ────────────────────────────────────────────
if args.no_live:
    print("\n[SKIP] Live API checks (--no-live)")
    sys.exit(0)

hdr("5) LIVE API — direct _get() + raw httpx")
try:
    import httpx, time, random
    from app.scrapers.shinigami import _get, _api as _api2, _CLIENT, TIMEOUT
    from app.scrapers.shinigami.models import ShinigamiLatestResponse
    print(f"  API base: {_api2()}")
    print(f"  TIMEOUT: {TIMEOUT}s, CLIENT: {_CLIENT}")

    def raw_get(path):
        """raw httpx tanpa circuit, untuk lihat status nyata"""
        url = f"{_api2()}{path}"
        try:
            r = _CLIENT.get(url)
            print(f"    RAW GET {path} -> {r.status_code} (elapsed ?) body_len={len(r.text)}")
            if r.status_code == 200:
                try:
                    j = r.json()
                    keys = list(j.keys())[:8] if isinstance(j, dict) else f"list len={len(j) if isinstance(j, list) else '?'}"
                    print(f"           json keys: {keys}")
                    if isinstance(j, dict) and "data" in j:
                        data = j["data"]
                        if isinstance(data, list) and data:
                            first = data[0]
                            print(f"           first item keys: {list(first.keys())[:15]}")
                            # cek chapters embedded?
                            if "chapters" in first:
                                print(f"           chapters field: {type(first['chapters']).__name__} len={len(first['chapters']) if isinstance(first['chapters'], list) else '?'}")
                                if isinstance(first["chapters"], list) and first["chapters"]:
                                    print(f"           first chapter keys: {list(first['chapters'][0].keys())[:10]}")
                            else:
                                warn("           'chapters' TIDAK ada di list item — collector yang expect chapters akan hasil 0!")
                            # cek field penting
                            for f in ["manga_id","title","manga_name","country_id","cover_image_url","latest_chapter_time","updated_at"]:
                                if f in first:
                                    v = str(first[f])[:80]
                                    print(f"             {f}: {v}")
                        else:
                            warn(f"           data empty or not list: {type(data)}")
                    return j
                except Exception as je:
                    print(f"           json parse fail: {je} body[:400]={r.text[:400]}")
                    return None
            else:
                print(f"           body[:400]={r.text[:400]}")
                return None
        except Exception as e:
            print(f"    RAW GET {path} exception: {e}")
            return None

    # a) list with is_update=true mirror
    print("\n  [a] /manga/list?type=mirror&is_update=true")
    j_a = raw_get("/manga/list?type=mirror&page=1&page_size=5&is_update=true&sort=latest&sort_order=desc")
    # b) without is_update
    print("\n  [b] /manga/list?type=mirror (tanpa is_update)")
    j_b = raw_get("/manga/list?type=mirror&page=1&page_size=5&sort=latest&sort_order=desc")
    # c) project type
    print("\n  [c] /manga/list?type=project&is_update=true")
    j_c = raw_get("/manga/list?type=project&page=1&page_size=5&is_update=true&sort=latest&sort_order=desc")
    # d) via _get (circuit + retry)
    print("\n  [d] via _get() wrapper (circuit-aware)")
    d_data = _get("/manga/list?type=mirror&page=1&page_size=5&is_update=true&sort=latest&sort_order=desc")
    if d_data is None:
        warn("  _get returned None — circuit OPEN atau HTTP error (lihat log di _get)")
    else:
        ok(f"  _get ok: type={type(d_data).__name__} keys={list(d_data.keys())[:5] if isinstance(d_data, dict) else 'list'}")
        try:
            parsed = ShinigamiLatestResponse.model_validate(d_data)
            ok(f"  ShinigamiLatestResponse validated: {len(parsed.data)} items")
        except Exception as ve:
            fail(f"  ShinigamiLatestResponse validation fail: {ve}")
            print(f"       raw: {str(d_data)[:600]}")

    # e) pick manga_id
    picked_id = args.manga_id
    if not picked_id:
        for j in [j_a, j_b, j_c, d_data]:
            if isinstance(j, dict) and isinstance(j.get("data"), list) and j["data"]:
                picked_id = str(j["data"][0].get("manga_id") or j["data"][0].get("id") or "")
                if picked_id: break
    if picked_id:
        print(f"\n  [e] picked manga_id={picked_id} — test /manga/detail + /chapter/list")
        # detail
        print(f"\n  [e1] /manga/detail/{picked_id}")
        j_detail = raw_get(f"/manga/detail/{picked_id}")
        if isinstance(j_detail, dict):
            # try model + meta
            try:
                from app.scrapers.shinigami import get_shinigami_series, get_shinigami_series_meta
                det = get_shinigami_series(picked_id)
                if det is None:
                    warn("  get_shinigami_series returned None")
                else:
                    ok(f"  get_shinigami_series ok: keys={list(det.keys())[:12]}")
                    if "taxonomy" in det:
                        tax = det["taxonomy"]
                        print(f"       taxonomy type: {type(tax).__name__} keys={list(tax.keys())[:8] if isinstance(tax, dict) else 'list'}")
                meta = get_shinigami_series_meta(picked_id)
                if meta is None:
                    warn("  get_shinigami_series_meta returned None")
                else:
                    ok(f"  get_shinigami_series_meta ok: {json.dumps({k: (str(v)[:80] if isinstance(v,str) else v) for k,v in meta.items()}, ensure_ascii=False, indent=2)[:800]}")
            except Exception as me:
                fail(f"  detail/meta error: {me}")
                import traceback; traceback.print_exc()
        # chapters
        print(f"\n  [e2] /chapter/{picked_id}/list")
        j_ch = raw_get(f"/chapter/{picked_id}/list?page=1&page_size=10&sort_by=chapter_number&sort_order=desc")
        try:
            from app.scrapers.shinigami import get_shinigami_chapters
            chaps = get_shinigami_chapters(picked_id, per_page=50)
            if not chaps:
                warn(f"  get_shinigami_chapters returned 0 for {picked_id}")
            else:
                ok(f"  get_shinigami_chapters: {len(chaps)} chapters")
                print(f"       first chapter keys: {list(chaps[0].keys())[:12]}")
                print(f"       first chapter: {json.dumps({k: str(v)[:60] for k,v in chaps[0].items()}, ensure_ascii=False)}")
        except Exception as ce:
            fail(f"  get_shinigami_chapters error: {ce}")
            import traceback; traceback.print_exc()
        # search
        print(f"\n  [e3] search_shinigami_api('solo')")
        try:
            from app.scrapers.shinigami import search_shinigami_api
            sres = search_shinigami_api("solo", per_page=5)
            ok(f"  search 'solo': {len(sres)} results")
            if sres:
                print(f"       first result keys: {list(sres[0].keys())[:12]}")
                print(f"       first: manga_id={sres[0].get('manga_id')} title={sres[0].get('title') or sres[0].get('manga_name')}")
        except Exception as se:
            fail(f"  search error: {se}")
    else:
        warn("  tidak bisa pick manga_id — semua list kosong / None, skip detail/chapter test")

    # f) get_shinigami_latest_updates end-to-end
    print("\n  [f] get_shinigami_latest_updates(page=1, per_page=10, max_pages=2)")
    try:
        from app.scrapers.shinigami import get_shinigami_latest_updates
        import time
        t0 = time.time()
        all_items = get_shinigami_latest_updates(page=1, per_page=10, max_pages=2)
        dt = time.time()-t0
        ok(f"  get_shinigami_latest_updates: {len(all_items)} items in {dt:.2f}s")
        if all_items:
            first = all_items[0]
            print(f"       first keys: {list(first.keys())[:15]}")
            has_ch = "chapters" in first
            print(f"       has 'chapters' field: {has_ch}")
            if has_ch:
                print(f"       chapters len: {len(first['chapters']) if isinstance(first['chapters'], list) else type(first['chapters'])}")
            else:
                warn("       TIDAK ada 'chapters' di item — cek collector logic!")
            # distribution by country
            from collections import Counter
            c = Counter(str(x.get("country_id") or "?") for x in all_items)
            print(f"       country_id dist: {dict(c)}")
    except Exception as fe:
        fail(f"  get_shinigami_latest_updates error: {fe}")
        import traceback; traceback.print_exc()

except Exception as e:
    fail(f"live error: {e}")
    import traceback; traceback.print_exc()

# ── 6. Collector simulation ───────────────────────────────────
hdr("6) COLLECTOR — _collect_shinigami_source (simulasi tanpa DB)")
try:
    from app.cron.collectors.shinigami import _collect_shinigami_source
    print("  collector function exists, signature ok")
    # jangan panggil dengan fetch_meta=True jika DB tidak ada — pakai False
    print("  try _collect_shinigami_source(latest_sent={}, disabled=set(), fetch_meta=False)")
    try:
        items = _collect_shinigami_source({}, set(), fetch_meta=False)
        print(f"  collector returned {len(items)} chapter-items")
        if items:
            ok(f"  collector produced {len(items)} items")
            print(f"       sample[0] keys: {list(items[0].keys())}")
            print(f"       sample[0]: {json.dumps({k: str(v)[:70] for k,v in items[0].items()}, ensure_ascii=False, indent=2)[:900]}")
            # cek jika collector benar-benar butuh 'chapters' di list item
            if len(items) == 0:
                warn("  collector 0 items — kemungkinan 'chapters' tidak embedded di /manga/list, collector loop tidak jalan")
        else:
            warn("  collector returned 0 items — cek apakah /manga/list memang tidak embed chapters (bug collector)")
            # jelaskan bug potensial
            print("       -> Hypothesis: shinigami collector iterates m.get('chapters') but API /manga/list tidak return chapters.")
            print("       -> Pipeline asli butuh batch chapter fetch terpisah atau rely on single chapter per series (latest_chapter_time).")
            print("       -> Cek apakah collector seharusnya fetch chapters per manga atau memang expect chapters di list.")
    except Exception as ce:
        # jika DB error karena _cached_series_meta, tetap count sebagai info
        warn(f"  collector raised: {ce}")
        import traceback; traceback.print_exc()
        # coba lagi dengan no DB — info only
        print("  (collector fetch_meta=False seharusnya tidak butuh DB, error di atas mungkin dari attach_confidence atau lain)")
except Exception as e:
    fail(f"collector import error: {e}")
    import traceback; traceback.print_exc()

hdr("SUMMARY")
print("""
Diagnosis checklist:
 - Jika 5[a-d] semua 200 + parsed ok  => API & contract BENER.
 - Jika 5[a-d] warn chapters missing   => API tidak embed chapters; collector 6 akan 0 items = BUG (perlu fetch /chapter per manga).
 - Jika _get None tapi RAW 200         => circuit OPEN atau ssrf block.
 - Jika test_shinigami_contract import fail => fix import path ke app.scrapers.shinigami.models
 - Jika collector 0 tapi live list ada items => bug confirmed di collectors/shinigami.py:32-48

Next: jalankan juga `pytest tests/test_shinigami_contract.py -v` untuk cek kontrak offline.
""")
