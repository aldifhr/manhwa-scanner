"""FCFS is the anti-duplicate guarantee — pin it.

`fcfs_key(title, chapter)` decides whether two chapters are "the same chapter".
It is what stops the same release being announced twice when two sources report
it, and it is compared against a UNIQUE column in dispatch_history. If it ever
returns different keys for the same chapter, the user gets duplicate
notifications and nothing errors — a silent, user-visible failure.

Run: PYTHONPATH=. python3 tests/test_fcfs_dedupe.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def key_is_source_agnostic():
    """The whole point: two sources reporting one chapter produce ONE key."""
    from app.services.fcfs import fcfs_key

    a = fcfs_key("Solo Leveling", "120")  # shinigami says 120
    b = fcfs_key("Solo Leveling", "120")  # voratoon says 120
    assert a == b, "same title+chapter must collapse regardless of source"


@case
def title_and_chapter_both_normalise():
    from app.services.fcfs import fcfs_key

    assert fcfs_key("Solo  Leveling!", "012.50") == fcfs_key("solo leveling", "12.5")


@case
def dashed_and_dotted_chapters_collapse():
    """A split chapter written 160-2 by one source and 160.2 by another."""
    from app.services.fcfs import fcfs_key

    assert fcfs_key("X", "160-2") == fcfs_key("X", "160.2")


@case
def different_chapters_never_collide():
    from app.services.fcfs import fcfs_key

    keys = {fcfs_key("X", c) for c in ("1", "2", "10", "11", "100")}
    assert len(keys) == 5, f"distinct chapters collided: {keys}"


@case
def numeric_and_string_chapter_agree():
    """int 0 / float 12.5 must key the same as their string forms.

    This is a regression guard: `str(ch_str or "")` treated int 0 as absent
    (0 is falsy), so normalize_chapter(0) was "" while normalize_chapter("0")
    was "0" — two different keys for one chapter, i.e. a duplicate notification
    if a source ever reports chapter 0 numerically.
    """
    from app.services.fcfs import fcfs_key, normalize_chapter

    assert normalize_chapter(0) == "0", "int 0 must survive as '0'"
    assert normalize_chapter(0) == normalize_chapter("0")
    assert fcfs_key("X", 0) == fcfs_key("X", "0")
    # and the ordinary numeric cases
    assert fcfs_key("X", 12) == fcfs_key("X", "12")
    assert fcfs_key("X", 12.5) == fcfs_key("X", "12.5")


@case
def empty_chapter_is_empty_not_zero():
    from app.services.fcfs import normalize_chapter

    assert normalize_chapter(None) == ""
    assert normalize_chapter("") == ""
    assert normalize_chapter("   ") == ""
    # An absent chapter must NOT collapse onto chapter 0.
    assert normalize_chapter(None) != normalize_chapter(0)


@case
def non_numeric_labels_are_preserved():
    """'OVA'/'Extra' are real chapter labels; they must not be mangled."""
    from app.services.fcfs import normalize_chapter

    assert normalize_chapter("OVA") == "OVA"
    assert normalize_chapter("Extra") == "Extra"
    # Case is preserved (backward compat), so these stay distinct on purpose.
    assert normalize_chapter("OVA") != normalize_chapter("ova")


@case
def title_normalisation_matches_the_whitelist():
    """fcfs must agree with the whitelist's own key, or dedupe and matching
    would disagree about which series a chapter belongs to."""
    from app.services.fcfs import normalize_title
    from app.utils.text import slugify_title_key

    for t in (
        "Solo Leveling",
        "solo  leveling!",
        "I'm the Max-Level Newbie",
        "The Knight's Return",
        "A  -  B",
        "",
    ):
        assert normalize_title(t) == slugify_title_key(t), (
            f"fcfs and whitelist disagree on {t!r}: "
            f"{normalize_title(t)!r} vs {slugify_title_key(t)!r}"
        )


@case
def parse_chapter_number_handles_junk():
    from app.services.fcfs import parse_chapter_number

    assert parse_chapter_number("12") == 12.0
    assert parse_chapter_number(12.5) == 12.5
    assert parse_chapter_number("ch 12.5") == 12.5
    assert parse_chapter_number("OVA") is None
    assert parse_chapter_number(None) is None
    assert parse_chapter_number("") is None


@case
def claimed_check_is_a_single_query_per_table():
    """Both ledgers must be consulted: dispatch_history is the permanent record,
    dispatch_claims covers a concurrent runner mid-send. Checking only one
    reintroduces duplicates under concurrency."""
    from app.services.fcfs import claimed_fcfs_keys

    src = inspect.getsource(claimed_fcfs_keys)
    assert "dispatch_history" in src, "must consult the permanent ledger"
    assert "dispatch_claims" in src, "must consult live claims"
    assert claimed_fcfs_keys([]) == set()


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
