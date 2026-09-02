"""Root conftest.py — load .env before tests so env vars are available."""
import os
import sys
from pathlib import Path

def _load_env():
    """Load .env file into os.environ."""
    # Project root (where conftest.py lives)
    root = Path(__file__).parent
    env_file = root / ".env"
    if not env_file.exists():
        return
    
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # Only set if not already in env (don't override existing)
            if key and key not in os.environ:
                os.environ[key] = value

# Load env at import time (before tests collect)
_load_env()
