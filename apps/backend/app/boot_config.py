"""Boot-time config validation — fail fast on missing critical settings."""
from __future__ import annotations

import os
from typing import List, Tuple

from app.logger import get_logger

logger = get_logger("boot:config")

# (env_var, required_in_prod, description)
CRITICAL_VARS: List[Tuple[str, bool, str]] = [
    ("DATABASE_URL", True, "Postgres connection string"),
    ("DISCORD_BOT_TOKEN", True, "Discord bot token for notifications"),
    ("AUTH_SECRET", True, "JWT signing secret"),
    ("CRON_SECRET", True, "Cron internal auth"),
]

def validate_settings() -> None:
    """Raise RuntimeError if critical config is missing in production."""
    env = os.getenv("ENVIRONMENT", "development").lower()
    is_prod = env == "production"

    missing = []
    for var, required_in_prod, desc in CRITICAL_VARS:
        val = os.getenv(var, "").strip()
        if not val:
            if required_in_prod and is_prod:
                missing.append(f"{var} ({desc})")
            elif required_in_prod:
                logger.warn(f"missing config (non-prod): {var} ({desc})")

    if missing:
        raise RuntimeError(
            f"BOOT GUARD: missing critical config: {', '.join(missing)}"
        )

    # Validate Redis URL format
    redis_url = os.getenv("REDIS_URL", "").strip()
    if redis_url and not redis_url.startswith("redis://"):
        logger.warn(f"REDIS_URL looks invalid: {redis_url[:40]}")

    logger.info("config validation ok", env=env)
