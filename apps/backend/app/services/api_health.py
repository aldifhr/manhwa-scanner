"""API failure detector — tracks upstream health and auto-switches mode."""
from __future__ import annotations

import time

from app.logger import get_logger

logger = get_logger("services:api_health")


class ApiFailureDetector:
    """Detects when an upstream API is consistently failing.

    Usage:
        detector = ApiFailureDetector(threshold=5, cooldown=300)
        if detector.should_try_api():
            result = fetch_api()
            if result:
                detector.record_success()
            else:
                detector.record_failure()
        else:
            result = fetch_html()
    """

    def __init__(self, threshold: int = 5, cooldown: int = 300):
        self._threshold = threshold
        self._cooldown = cooldown
        self._consecutive_failures = 0
        self._html_mode_until = 0.0

    def should_try_api(self) -> bool:
        """True if we should try the API (not in HTML-only mode)."""
        if self._html_mode_until:
            if time.monotonic() < self._html_mode_until:
                return False
            # Cooldown expired — try API once
            return True
        return True

    def record_success(self) -> None:
        """API call succeeded."""
        if self._consecutive_failures:
            logger.info("api recovered", failures=self._consecutive_failures)
        self._consecutive_failures = 0
        self._html_mode_until = 0.0

    def record_failure(self) -> None:
        """API call failed."""
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._threshold:
            self._html_mode_until = time.monotonic() + self._cooldown
            logger.warn(
                "api failure threshold reached, switching to HTML mode",
                failures=self._consecutive_failures,
                cooldown=self._cooldown,
            )

    @property
    def html_mode(self) -> bool:
        return bool(self._html_mode_until and time.monotonic() < self._html_mode_until)


# Per-source detectors
detectors: dict[str, ApiFailureDetector] = {}


def get_detector(source: str) -> ApiFailureDetector:
    if source not in detectors:
        detectors[source] = ApiFailureDetector()
    return detectors[source]
