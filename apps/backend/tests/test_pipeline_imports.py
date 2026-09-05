"""Ponytail guard for pipeline aliases — fails if NameError regresses."""
def test_pipeline_aliases():
    import app.cron.pipeline as pl
    assert hasattr(pl, "collect_recent_chapters")
    assert hasattr(pl, "filter_whitelisted")
    assert hasattr(pl, "enrich")
    assert hasattr(pl, "dispatch")
    # internal direct prefixes also exist
    assert hasattr(pl.collect, "collect_recent_chapters")
    assert callable(pl.collect_recent_chapters)

def test_pipeline_run_import():
    from app.cron.pipeline import run_pipeline
    assert callable(run_pipeline)
