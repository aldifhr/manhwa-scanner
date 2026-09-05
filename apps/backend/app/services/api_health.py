"""Shim: ApiFailureDetector now lives in resilience.cb_ikiru_api. Kept for import compat."""
from app.services.resilience import cb_ikiru_api as _cb

class ApiFailureDetector:
    def should_try_api(self): return _cb.allow()
    def record_success(self): _cb.record_success()
    def record_failure(self): _cb.record_failure()
    @property
    def html_mode(self): return not _cb.allow()

detectors = {"ikiru": ApiFailureDetector()}
def get_detector(source: str) -> ApiFailureDetector:
    return detectors.setdefault(source, ApiFailureDetector())
