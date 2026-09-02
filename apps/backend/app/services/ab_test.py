"""A/B Testing — notification format variants for optimization."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from app.logger import get_logger

logger = get_logger("ab_test")


class TestVariant(str, Enum):
    """A/B test variants."""
    CONTROL = "control"
    VARIANT_A = "variant_a"
    VARIANT_B = "variant_b"


# ── Active Tests ──

ACTIVE_TESTS = {
    "notification_format": {
        "description": "Test different Discord notification formats",
        "variants": [TestVariant.CONTROL, TestVariant.VARIANT_A, TestVariant.VARIANT_B],
        "weights": [0.34, 0.33, 0.33],  # Traffic split
    },
    "embed_color": {
        "description": "Test embed color schemes",
        "variants": [TestVariant.CONTROL, TestVariant.VARIANT_A],
        "weights": [0.5, 0.5],
    },
}


def get_variant(test_name: str, user_id: str = "default") -> TestVariant:
    """Get the A/B test variant for a user.
    
    Uses consistent hashing so the same user always gets the same variant.
    """
    test = ACTIVE_TESTS.get(test_name)
    if not test:
        return TestVariant.CONTROL
    
    # Consistent hashing
    hash_input = f"{test_name}:{user_id}"
    hash_val = int(hashlib.md5(hash_input.encode()).hexdigest(), 16)
    hash_pct = (hash_val % 10000) / 10000.0
    
    # Assign variant based on weights
    cumulative = 0.0
    for variant, weight in zip(test["variants"], test["weights"]):
        cumulative += weight
        if hash_pct < cumulative:
            return variant
    
    return test["variants"][-1]


def get_notification_format(variant: TestVariant) -> dict:
    """Get notification format config for a variant."""
    formats = {
        TestVariant.CONTROL: {
            "use_embed": True,
            "show_cover": True,
            "show_genres": True,
            "show_rating": True,
            "compact": False,
            "color_scheme": "source",
        },
        TestVariant.VARIANT_A: {
            "use_embed": True,
            "show_cover": True,
            "show_genres": False,
            "show_rating": True,
            "compact": True,
            "color_scheme": "source",
        },
        TestVariant.VARIANT_B: {
            "use_embed": True,
            "show_cover": False,
            "show_genres": True,
            "show_rating": False,
            "compact": True,
            "color_scheme": "unified",
        },
    }
    return formats.get(variant, formats[TestVariant.CONTROL])


def track_test_event(test_name: str, variant: TestVariant, event: str, metadata: dict | None = None):
    """Track an A/B test event."""
    try:
        from app.db import q
        q("""
            INSERT INTO ab_test_events (test_name, variant, event, metadata, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s)
        """, [
            test_name,
            str(variant),
            event,
            json.dumps(metadata or {}),
            datetime.now(timezone.utc).isoformat(),
        ])
    except Exception as e:
        logger.warn("ab_test track failed", err=str(e)[:100])


def get_test_results(test_name: str) -> dict:
    """Get A/B test results."""
    try:
        from app.db import q
        results = q("""
            SELECT variant, event, COUNT(*) as count
            FROM ab_test_events
            WHERE test_name = %s
            GROUP BY variant, event
            ORDER BY variant, event
        """, [test_name])
        
        # Organize by variant
        by_variant = {}
        for r in results:
            v = r["variant"]
            if v not in by_variant:
                by_variant[v] = {}
            by_variant[v][r["event"]] = r["count"]
        
        return by_variant
    except Exception as e:
        logger.warn("ab_test results failed", err=str(e)[:100])
        return {}
