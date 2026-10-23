"""Signed Ikiru cover URLs must not be rewritten or query-busted."""
from app.discord.embeds import build_chapter_embed


def test_ikiru_thumbnail_preserves_signed_url():
    cover = "https://cdn.ikiru.id/featured/1000336965.png?md5=abc&expires=123"
    embed = build_chapter_embed(
        title="Petualangan Kim Ohjin Bersama Hewan-Hewan Aneh",
        chapter="67",
        url="https://09.ikiru.wtf/manga/petualangan-kim-ohjin-bersama-hewan-hewan-aneh/chapter-67",
        series_url="https://09.ikiru.wtf/manga/petualangan-kim-ohjin-bersama-hewan-hewan-aneh",
        source="ikiru",
        cover=cover,
    )
    from urllib.parse import parse_qs, urlparse

    thumb = embed["thumbnail"]["url"]
    assert thumb.startswith("https://scanner.aldifhr.my.id/api/v1/reader/cover-img?")
    assert parse_qs(urlparse(thumb).query)["url"][0] == cover
    assert "v=67" in thumb


def test_shinigami_cover_still_uses_proxy_and_cache_buster():
    cover = "https://assets.shngm.id/thumbnail/cover.jpg"
    embed = build_chapter_embed(
        title="Test Series", chapter="12",
        url="https://11.shinigami.asia/chapter/abc",
        series_url="https://11.shinigami.asia/series/abc",
        source="shinigami", cover=cover,
    )
    thumbnail = embed["thumbnail"]["url"]
    from urllib.parse import parse_qs, urlparse

    assert "/api/v1/reader/cover-img" in thumbnail
    assert "v=12" in thumbnail
    assert parse_qs(urlparse(thumbnail).query)["url"][0] == cover


if __name__ == "__main__":
    test_ikiru_thumbnail_preserves_signed_url()
    test_shinigami_cover_still_uses_proxy_and_cache_buster()
    print("2/2 passed")
