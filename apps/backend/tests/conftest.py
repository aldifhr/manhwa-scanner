"""Test fixtures — set ENVIRONMENT + secrets before app import so boot guard passes."""
import os
from pathlib import Path

# Set env vars at module level (runs before test files are imported)
os.environ["ENVIRONMENT"] = "development"

# Load .env secrets into os.environ (only if not already set)
env_file = Path(__file__).parent.parent / ".env"
if env_file.exists():
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

# Override with deterministic test secrets (so tests don't depend on .env values)
os.environ["DASHBOARD_PASSWORD"] = "manhwascan"
os.environ["MONITOR_AUTH_TOKEN"] = "monitor-token"
os.environ["AUTH_SECRET"] = "test-auth-secret"
os.environ["CRON_SECRET"] = "cron-secret"
