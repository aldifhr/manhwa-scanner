"""Embed thumbnail URLs must be distinct per chapter, and still resolve.

Motivation: two chapters of one series dispatched 8ms apart rendered with the
SAME thumbnail URL, and Discord showed the image on one embed and a blank space
on the other. Discord fetches an embed thumbnail asynchronously after accepting
the message, so two concurrent fetches of a byte-identical URL can leave one
empty with no retry.

The cache buster must go BEFORE `url=` in the query. reader_proxy() takes the
raw remainder when the query starts with "url=" (to preserve S3 encoding), so a
param appended after it leaks into the upstream URL and S3 rejects the
signature — which returns a 1x1 transparent PNG placeholder, i.e. a silently
broken cover instead of a distinct one.

    PYTHONPATH=. .venv/bin/python tests/test_embed_thumbnail_buster.py
"""
import sys

sys.path.insert(0, ".")

PASSED = []
FAILED = []


def case(fn):
    try:
        fn()
        PASSED.append(fn.__name__)
    except AssertionError as e:
        FAILED.append((fn.__name__, str(e)))
    except Exception as e:  # noqa: BLE001
        FAILED.append((fn.__name__, f"{type(e).__name__}: {e}"))
    return fn


_COVER = (
    "https://cvr.voratoon.id/prod/series/king-account-at-the-start/cover/"
    "cover-king-account-at-the-start.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Signature=deadbeef"
)


def _embed(chapter: str) -> dict:
    from app.discord.embeds import build_chapter_embed

    return build_chapter_embed(
        title="King Account At The Start",
        chapter=chapter,
        url=f"https://v4.voratoon.com/series/king-account-at-the-start/chapter/{chapter}",
        series_url="https://v4.voratoon.com/series/king-account-at-the-start",
        source="voratoon",
        cover=_COVER,
        rating="7.0",
        genres=["Action"],
        description="x" * 50,
        updated_time="2026-10-08T13:29:58+00:00",
    )


@case
def two_chapters_get_distinct_thumbnail_urls():
    """The whole point: no two embeds may share a thumbnail URL."""
    a = _embed("345")["thumbnail"]["url"]
    b = _embed("346")["thumbnail"]["url"]
    assert a != b, "identical thumbnail URLs -> concurrent fetch -> one blank cover"


@case
def the_buster_comes_before_url_not_after():
    """reader_proxy() keeps the raw remainder when the query starts with 'url=',
    so a param after it leaks upstream and breaks the S3 signature."""
    u = _embed("345")["thumbnail"]["url"]
    qs = u.split("?", 1)[1]
    assert qs.startswith("v="), (
        f"query must start with the buster, got {qs[:30]!r} — appending after "
        "url= corrupts the upstream URL"
    )
    assert "url=" in qs, "url= must still be present"


@case
def the_buster_does_not_leak_into_the_upstream_url():
    """The decoded url= value must be the bare presigned URL."""
    from urllib.parse import parse_qs, urlparse

    u = _embed("345")["thumbnail"]["url"]
    inner = parse_qs(urlparse(u).query).get("url", [""])[0]
    assert inner == _COVER, f"url= was altered: {inner[:120]!r}"
    assert "v=345" not in inner, "buster leaked into the upstream URL"


@case
def the_buster_is_the_chapter_number():
    u = _embed("346")["thumbnail"]["url"]
    assert "v=346" in u, u[:140]


@case
def no_cover_means_no_thumbnail():
    """A series without a cover must not grow a thumbnail key."""
    from app.discord.embeds import build_chapter_embed

    e = build_chapter_embed(
        title="No Cover Series", chapter="1", url="u", series_url="s",
        source="voratoon", cover="", rating="", genres=[], description="",
        updated_time="",
    )
    assert "thumbnail" not in e, e.keys()


@case
def multi_chapter_embed_uses_the_latest_chapter_as_the_buster():
    """build_multi_chapter_embed groups chapters; the tag must be the latest."""
    from app.discord.embeds import build_multi_chapter_embed

    e = build_multi_chapter_embed(
        title="King Account At The Start",
        chapters=["345", "346"],
        chapter_urls=["u345", "u346"],
        series_url="s",
        source="voratoon",
        cover=_COVER,
        rating="7.0",
        genres=["Action"],
        description="x",
        updated_time="",
    )
    assert "v=346" in e["thumbnail"]["url"], e["thumbnail"]["url"][:140]


if __name__ == "__main__":
    for name, err in FAILED:
        print(f"FAIL {name}: {err}")
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
