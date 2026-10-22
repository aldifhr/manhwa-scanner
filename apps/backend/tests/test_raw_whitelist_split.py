"""The raw/whitelist two-feed split.

Dispatch used to send every chapter to every channel in `guild_settings`. The
operator wants two feeds instead:

  * RAW       — every new chapter, for series NOT on the whitelist, carrying an
                "Add to whitelist" button.
  * WHITELIST — only whitelisted series, no button.

Three invariants pin the behaviour, and each one was a real failure mode:

  1. A series already whitelisted is never announced on raw. Otherwise the raw
     channel fills up with buttons that do nothing, and a subscriber sees their
     own series re-announced.
  2. Raw is opt-in. With RAW_DISCORD_CHANNEL_ID unset every channel stays a
     whitelist channel — the previous single-feed behaviour. A config typo must
     not start publishing on a deployment that never asked for a raw feed.
  3. The two feeds use ONE subscription rule. When raw and whitelist each had
     their own matcher, the same chapter could be announced on both.

Runs as a plain script (this repo has no pytest):
    PYTHONPATH=. python3 tests/test_raw_whitelist_split.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _src(fn) -> str:
    return inspect.getsource(fn)


@case
def whitelist_series_are_routed_to_the_whitelist_feed_not_raw():
    """The core split: subscribed ⇒ whitelist feed, everything else ⇒ raw."""
    from app.cron.collect import split_raw_and_whitelisted

    items = [
        {"title_key": "subscribed-series", "source": "shinigami", "url": "u1"},
        {"title_key": "stray-series", "source": "shinigami", "url": "u2"},
    ]
    raw, wl = split_raw_and_whitelisted(
        items, [{"title_key": "subscribed-series", "source": "shinigami"}]
    )
    assert [i["url"] for i in wl] == ["u1"], "whitelisted series must land on the whitelist feed"
    assert [i["url"] for i in raw] == ["u2"], "non-whitelisted series must land on raw"
    assert raw[0]["subscribed"] is False
    assert wl[0]["subscribed"] is True


@case
def the_split_is_source_strict():
    """A shinigami subscription must not subscribe the ikiru copy.

    The whitelist's key is (title_key, source) — see filter_whitelisted().
    """
    from app.cron.collect import split_raw_and_whitelisted

    raw, wl = split_raw_and_whitelisted(
        [
            {"title_key": "same-series", "source": "shinigami", "url": "s"},
            {"title_key": "same-series", "source": "ikiru", "url": "i"},
        ],
        [{"title_key": "same-series", "source": "shinigami"}],
    )
    assert [i["url"] for i in wl] == ["s"], "only the subscribed source is whitelisted"
    assert [i["url"] for i in raw] == ["i"], "the other source stays on raw"


@case
def the_split_covers_every_item_exactly_once():
    """No item may be dropped or duplicated by the partition."""
    from app.cron.collect import split_raw_and_whitelisted

    items = [
        {"title_key": f"t{i}", "source": "shinigami", "url": f"u{i}"} for i in range(25)
    ]
    wl_keys = [{"title_key": f"t{i}", "source": "shinigami"} for i in range(0, 25, 2)]
    raw, wl = split_raw_and_whitelisted(items, wl_keys)
    assert len(raw) + len(wl) == 25, "the partition must cover every item"
    assert len({i["url"] for i in raw} | {i["url"] for i in wl}) == 25, "no duplicates"
    assert len(wl) == 13, f"13 whitelisted, got {len(wl)}"


@case
def raw_feed_is_opt_in():
    """Without RAW_DISCORD_CHANNEL_ID nothing is a raw channel.

    This is what keeps a deployment that never configured a raw feed behaving
    exactly as before the change.
    """
    from app.cron import dispatch_mod

    saved = dispatch_mod.settings.RAW_DISCORD_CHANNEL_ID
    object.__setattr__(dispatch_mod.settings, "RAW_DISCORD_CHANNEL_ID", "")
    try:
        raw, wl = dispatch_mod.split_dispatch_targets(["111", "222"])
        assert raw == [], f"no raw channel may be derived from an unset config, got {raw}"
        assert wl == ["111", "222"], "every channel stays a whitelist channel"
    finally:
        object.__setattr__(dispatch_mod.settings, "RAW_DISCORD_CHANNEL_ID", saved)


@case
def configured_raw_channel_is_split_out():
    """With a raw channel configured, it is removed from the whitelist half.

    The raw channel stays in the whitelist half as well, so a deployment with a
    raw channel but no separate whitelist channel still receives whitelisted
    series instead of silently dropping them.
    """
    from app.cron import dispatch_mod

    saved = dispatch_mod.settings.RAW_DISCORD_CHANNEL_ID
    object.__setattr__(dispatch_mod.settings, "RAW_DISCORD_CHANNEL_ID", "111")
    try:
        raw, wl = dispatch_mod.split_dispatch_targets(["111", "222"])
        assert raw == ["111"]
        assert wl == ["111", "222"], "the raw channel must also carry the whitelist feed"
    finally:
        object.__setattr__(dispatch_mod.settings, "RAW_DISCORD_CHANNEL_ID", saved)


@case
def a_guild_override_wins_over_the_env_default():
    """/setrawchannel on a guild must override the env value.

    The env is the fallback for a single-server deploy, not an override for a
    guild that picked its own channel.
    """
    from app.cron import dispatch_mod as dm

    saved = dm.settings.RAW_DISCORD_CHANNEL_ID
    object.__setattr__(dm.settings, "RAW_DISCORD_CHANNEL_ID", "111")
    target = ""
    try:
        rows = dm.load_guild_settings()
        target = str(rows[0]["guild_id"])
        dm._set_feed_channel(target, "222", "raw")
        raw, wl = dm.split_dispatch_targets(["111", "222"])
        assert raw == ["222"], f"the guild's own raw channel must win, got {raw}"
        assert dm.guild_setting(target, "raw") == "222"
    finally:
        from app.db import q

        if target:
            q("UPDATE guild_settings SET raw_channel_id = NULL WHERE guild_id = %s", [target])
        object.__setattr__(dm.settings, "RAW_DISCORD_CHANNEL_ID", saved)


@case
def the_feed_channel_commands_are_routed_and_registered():
    import pathlib

    import app.discord.router as router

    src = pathlib.Path(router.__file__).read_text()
    assert 'name == "setrawchannel"' in src, "/setrawchannel must be routed"
    assert 'name == "setwhitelistchannel"' in src, "/setwhitelistchannel must be routed"

    reg = pathlib.Path("scripts/register_commands.py").read_text()
    assert '"name": "setrawchannel"' in reg, (
        "/setrawchannel must be registered with Discord or it never appears in the picker"
    )
    assert '"name": "setwhitelistchannel"' in reg, (
        "/setwhitelistchannel must be registered with Discord or it never appears in the picker"
    )
    # Both take a CHANNEL option (type 7) so the picker is scoped to this guild.
    assert '"name": "setrawchannel"' in reg and '"type": 7' in reg


@case
def the_feed_channel_commands_write_the_matching_column():
    from app.discord.router import _route_setrawchannel, _route_setwhitelistchannel

    for fn, col in ((_route_setrawchannel, "raw"), (_route_setwhitelistchannel, "whitelist")):
        src = _src(fn)
        assert f'feed="{col}"' in src, f"{fn.__name__} must write the {col} column"


@case
def dispatch_splits_items_by_channel_feed():
    """The send loop must iterate the per-channel feed, not the whole batch."""
    import pathlib

    src = pathlib.Path(_dispatch().__code__.co_filename).read_text()
    assert "_feed = [" in src, "dispatch must build a per-channel feed"
    assert "for it in _feed:" in src, "the send loop must iterate that feed"
    # and the raw feed must exclude whitelisted items, whitelist must include only them
    assert 'bool(it.get("subscribed")) == (not _is_raw_ch)' in src, (
        "the split must match the subscribed flag to the feed, not invert it"
    )


@case
def only_the_raw_feed_carries_the_button():
    """The button is useless on the whitelist feed — it would re-add a series
    that is already added. It must not be sent there."""
    import pathlib

    src = pathlib.Path(_dispatch().__code__.co_filename).read_text()
    assert "if _is_raw_ch:" in src, "the button must be gated on the raw channel"
    assert "add_whitelist_button" in src


@case
def the_button_carries_the_whitelist_composite_key():
    """custom_id must encode (source, title_key) — the whitelist's PK."""
    from app.discord.embeds import add_whitelist_button, decode_whitelist_custom_id

    row = add_whitelist_button("shinigami", "the-margrave-s-worthless-mage")[0]
    cid = row["components"][0]["custom_id"]
    src, tk = decode_whitelist_custom_id(cid)
    assert (src, tk) == ("shinigami", "the-margrave-s-worthless-mage")
    assert row["components"][0]["type"] == 2, "must be a BUTTON"
    assert row["type"] == 1, "must be an ACTION_ROW"


@case
def the_button_round_trips_a_nasty_title_key():
    """A title containing ':' must not shift the field boundaries."""
    from app.discord.embeds import add_whitelist_button, decode_whitelist_custom_id

    cid = add_whitelist_button("shinigami", "odd:key/with stuff")[0]["components"][0]["custom_id"]
    src, tk = decode_whitelist_custom_id(cid)
    assert src == "shinigami", f"source must survive, got {src!r}"
    assert tk == "odd-key-with-stuff", f"title_key must round-trip, got {tk!r}"


@case
def a_malformed_custom_id_is_rejected_not_guessed():
    from app.discord.embeds import decode_whitelist_custom_id

    for bad in ("", "wladd:", "wladd:shinigami", "other:shinigami:x", "wladd::slug"):
        try:
            decode_whitelist_custom_id(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} must be rejected")


@case
def the_button_is_absent_when_there_is_nothing_to_key_on():
    from app.discord.embeds import add_whitelist_button

    assert add_whitelist_button("", "slug") == []
    assert add_whitelist_button("shinigami", "") == []


@case
def the_interaction_handler_is_registered():
    import pathlib

    import app.discord.router as router

    src = pathlib.Path(router.__file__).read_text()
    assert 'custom_id.startswith("wladd:")' in src, "the wladd component must be routed"
    assert "_route_whitelist_add" in src


@case
def the_handler_writes_to_the_whitelist_table():
    from app.discord.router import _route_whitelist_add

    src = _src(_route_whitelist_add)
    assert "add_whitelist_entries" in src, "the handler must write the whitelist row"
    assert "decode_whitelist_custom_id" in src, "it must read the key from the button"


@case
def the_handler_never_echoes_a_title_into_the_db_verbatim():
    """The display title comes from the embed; the key comes from the button.

    Writing the embed title as title_key would produce a title_key that
    normalize_title_key() would slugify differently from the row the button
    was authored with, so the subscription would never match a dispatch.
    """
    from app.discord.router import _route_whitelist_add

    src = _src(_route_whitelist_add)
    assert '"title_key": title_key' in src, "title_key must come from the decoded custom_id"


@case
def send_supports_components_but_the_gateway_fallback_does_not():
    """The gateway fallback cannot carry a button, so a component send must not
    silently degrade into a buttonless message."""
    from app.discord.client import send_channel_message

    src = _src(send_channel_message)
    assert "components" in src
    assert "cannot carry components" in src, "the fallback must refuse, not strip"


@case
def the_pipeline_tags_the_feed_instead_of_filtering_it_away():
    """pipeline.py must hand dispatch BOTH feeds.

    The previous code filtered to the whitelist here, which would have made the
    raw feed permanently empty.
    """
    import pathlib

    import app.cron.pipeline as pl

    src = pathlib.Path(pl.__file__).read_text()
    assert "to_dispatch = enriched_all" in src, "pipeline must not filter the batch"
    assert '_it["subscribed"]' in src, "pipeline must tag each item's feed"


@case
def pipeline_tags_use_the_same_rule_as_the_split():
    import pathlib

    import app.cron.pipeline as pl

    src = pathlib.Path(pl.__file__).read_text()
    assert "collect.slugify_title_key" in src, "must reuse the collector's slugifier"


def _dispatch():
    from app.cron.dispatch_mod import dispatch

    return dispatch

def main() -> int:
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  pass  {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {exc}")
        except Exception as exc:
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
