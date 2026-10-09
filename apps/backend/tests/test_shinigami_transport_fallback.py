"""Regression: shinigami's curl_cffi fallback never ran on a transport error.

httpx raised ConnectTimeout/ReadTimeout out of _CLIENT.get(). The old
_fetch only had a `try` around curl_cffi for the non-200 case, so the
exception propagated straight past the fallback and the caller saw a
failure — the TLS-fingerprint bypass that exists specifically to get past
Cloudflare was never attempted. Live symptom: one shinigami collect per
cycle took 10.3s (exactly the old TIMEOUT) while the next took 290ms.

These run with no network: _CLIENT is replaced by a stub that raises, and
the curl_cffi module by one that records the call.
"""
import sys
import types

sys.path.insert(0, ".")

from app.scrapers import shinigami as sg


def test_transport_error_falls_back_to_curl_cffi():
    calls = []

    class Boom:
        def get(self, url, **kw):
            raise TimeoutError("read timeout")

    fake_cffi = types.SimpleNamespace(
        get=lambda url, **kw: (calls.append(url), types.SimpleNamespace(status_code=200))[1]
    )
    orig_client, orig_cffi = sg._CLIENT, sg.cffi_req
    sg._CLIENT, sg.cffi_req = Boom(), fake_cffi
    try:
        r = sg._fetch("https://example.test/v1/manga/list")
    finally:
        sg._CLIENT, sg.cffi_req = orig_client, orig_cffi

    assert r.status_code == 200, "curl_cffi fallback must run on transport error"
    assert calls == ["https://example.test/v1/manga/list"]


def test_non_200_still_falls_back():
    calls = []

    class Forbidden:
        def get(self, url, **kw):
            return types.SimpleNamespace(status_code=403)

    fake_cffi = types.SimpleNamespace(
        get=lambda url, **kw: (calls.append(url), types.SimpleNamespace(status_code=200))[1]
    )
    orig_client, orig_cffi = sg._CLIENT, sg.cffi_req
    sg._CLIENT, sg.cffi_req = Forbidden(), fake_cffi
    try:
        r = sg._fetch("https://example.test/v1/manga/list")
    finally:
        sg._CLIENT, sg.cffi_req = orig_client, orig_cffi

    assert r.status_code == 200
    assert len(calls) == 1


def test_200_short_circuits_no_curl_cffi():
    """The fast path must not pay for the fallback client."""
    calls = []

    class Ok:
        def get(self, url, **kw):
            return types.SimpleNamespace(status_code=200)

    fake_cffi = types.SimpleNamespace(
        get=lambda url, **kw: (calls.append(url), types.SimpleNamespace(status_code=200))[1]
    )
    orig_client, orig_cffi = sg._CLIENT, sg.cffi_req
    sg._CLIENT, sg.cffi_req = Ok(), fake_cffi
    try:
        sg._fetch("https://example.test/v1/manga/list")
    finally:
        sg._CLIENT, sg.cffi_req = orig_client, orig_cffi

    assert calls == [], "curl_cffi must not be called when httpx already returned 200"


def test_timeout_is_bounded():
    """TIMEOUT was 10.0, which is what a stalled socket cost per collect."""
    assert sg.TIMEOUT <= 5.0, f"TIMEOUT regressed to {sg.TIMEOUT}; a hung socket stalls the pipeline"


for _name, _fn in sorted(list(globals().items())):
    if _name.startswith("test_") and callable(_fn):
        _fn()
        print(f"PASS {_name}")