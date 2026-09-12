import time

from app.cron.source_result import SourceResult


def test_source_result_distinguishes_empty_success_from_failure():
    ok = SourceResult.ok("x", [], time.monotonic())
    failed = SourceResult.failed("x", time.monotonic(), RuntimeError("down"))
    assert ok.success and ok.items == [] and ok.error is None
    assert not failed.success and failed.items == [] and failed.confidence == 0
