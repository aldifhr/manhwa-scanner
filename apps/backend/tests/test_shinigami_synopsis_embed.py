"""Shinigami chapter descriptions must render as actual synopsis text."""
from app.discord.embeds import build_chapter_embed


def test_shinigami_synopsis_is_not_dropped_as_a_slug():
    embed = build_chapter_embed(
        title="Return Of Frozen Player",
        chapter="230",
        url="https://11.shinigami.asia/chapter/5854f9e5-f571-4aa6-ad65-40e80422f28e",
        series_url="https://11.shinigami.asia/series/e4e70fb1-c2eb-4b84-be6a-42c1cbe5220c",
        source="shinigami",
        description="Pemain Beku",
    )
    assert "Pemain Beku" in embed.get("description", "")


if __name__ == "__main__":
    test_shinigami_synopsis_is_not_dropped_as_a_slug()
    print("PASS")
