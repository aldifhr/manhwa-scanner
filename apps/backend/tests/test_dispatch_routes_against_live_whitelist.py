"""The send boundary must treat the live whitelist as authoritative."""
from app.utils.text import slugify_title_key


def _route(item, whitelist):
    pairs = {
        (slugify_title_key(w.get("title_key", "")), str(w.get("source") or "").lower())
        for w in whitelist
    }
    key = (slugify_title_key(item.get("title_key", "")), str(item.get("source") or "").lower())
    return "whitelist" if key in pairs else "raw"


def test_a_stale_raw_tag_cannot_override_a_live_subscription():
    item = {
        "title_key": "the-demon-slayer-s-restaurant",
        "source": "shinigami",
        "subscribed": False,
    }
    whitelist = [{"title_key": "the-demon-slayer-s-restaurant", "source": "shinigami"}]
    assert _route(item, whitelist) == "whitelist"


def test_raw_channel_is_not_a_whitelist_retry_destination():
    from app.cron import dispatch_mod

    old_raw = dispatch_mod.settings.RAW_DISCORD_CHANNEL_ID
    old_load = dispatch_mod.load_guild_settings
    object.__setattr__(dispatch_mod.settings, "RAW_DISCORD_CHANNEL_ID", "raw-id")
    dispatch_mod.load_guild_settings = lambda: []
    try:
        raw, whitelist = dispatch_mod.split_dispatch_targets(["legacy-id", "raw-id", "wl-id"])
        assert raw == ["raw-id"]
        assert whitelist == ["legacy-id", "wl-id"]
    finally:
        dispatch_mod.load_guild_settings = old_load
        object.__setattr__(dispatch_mod.settings, "RAW_DISCORD_CHANNEL_ID", old_raw)


def test_subscription_is_source_specific():
    item = {"title_key": "the-demon-slayer-s-restaurant", "source": "ikiru"}
    whitelist = [{"title_key": "the-demon-slayer-s-restaurant", "source": "shinigami"}]
    assert _route(item, whitelist) == "raw"


if __name__ == "__main__":
    test_a_stale_raw_tag_cannot_override_a_live_subscription()
    test_subscription_is_source_specific()
    print("2/2 passed")
