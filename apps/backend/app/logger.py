"""Logger — JSON lines with scopes, correlation IDs, and rich error tracking.

Improvements over v1 (for easier error tracking):
  * Correlation ID (run_id / request_id) auto-injected so every log line
    from one cron run / one request shares an id → grep by id to reconstruct
    the full flow.
  * error() captures exception TYPE + stack trace (exc_info) so you see
    WHERE it broke, not just the message.
  * Severity gate: LOG_LEVEL env (DEBUG/INFO/WARN/ERROR) filters noise.
  * Dual sink: JSON to stdout (pm2) AND rotating files
    (logs/be-ag-py.log full, logs/error.log errors-only) for easy grep.
  * Backward compatible: get_logger(scope), logger.info/warn/error all kept.

Drop-in replacement: existing call sites (logger.warn("x", err=str(e)))
keep working; new error() can take an Exception directly via exc=.
"""
from __future__ import annotations

import json
import sys
import os
import traceback
import threading
import logging
import logging.handlers

from datetime import datetime, timezone


# ── correlation context (thread-local) ────────────────────────────────────
_local = threading.local()


def set_correlation_id(cid: str | None) -> None:
    """Set the correlation id for the current thread (call at request/run start)."""
    _local.cid = cid


def get_correlation_id() -> str | None:
    return getattr(_local, "cid", None)


# ── severity ────────────────────────────────────────────────────────────────
_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
_LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").strip().lower()
if _LOG_LEVEL not in _LEVELS:
    _LOG_LEVEL = "info"
_THRESHOLD = _LEVELS[_LOG_LEVEL]


# ── file sinks (proper logging.Logger, best-effort) ────────────────────────
def _make_file_handler(path: str, level: int) -> logging.Handler | None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        h = logging.handlers.RotatingFileHandler(
            path, maxBytes=5_000_000, backupCount=5, encoding="utf-8"
        )
        h.setLevel(level)
        h.setFormatter(logging.Formatter("%(message)s"))
        return h
    except Exception:
        return None


_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_FULL_PATH = os.environ.get("LOG_FILE", os.path.join(_ROOT, "logs", "be-ag-py.log"))
_ERR_PATH = os.environ.get("LOG_ERROR_FILE", os.path.join(_ROOT, "logs", "error.log"))
_file_handler = _make_file_handler(_FULL_PATH, 10)       # full log, all levels
_err_handler = _make_file_handler(_ERR_PATH, 40)          # errors only

_file_logger = logging.getLogger("be-ag-py-file")
_file_logger.setLevel(logging.DEBUG)
_file_logger.propagate = False
if _file_handler is not None:
    _file_logger.addHandler(_file_handler)
if _err_handler is not None:
    _file_logger.addHandler(_err_handler)


_TOKEN_RE = None  # lazy compiled


def _clean(s) -> str:
    """Prevent log injection + scrub secrets from log lines."""
    import re as _re

    global _TOKEN_RE
    if _TOKEN_RE is None:
        _TOKEN_RE = _re.compile(r"(token|authorization|bearer)\s*[=:]\s*[^\s&\"']+", _re.IGNORECASE)
    txt = str(s).replace("\n", " ").replace("\r", " ")
    # Redact token=... query params and Authorization headers that slipped into fields.
    # Keep first 4 chars for correlation, mask rest.
    def _mask(m):
        raw = m.group(0)
        # keep key, mask value
        if "=" in raw:
            k, v = raw.split("=", 1)
            return f"{k}=***"
        if ":" in raw:
            k, v = raw.split(":", 1)
            return f"{k}: ***"
        return "***"
    txt = _TOKEN_RE.sub(_mask, txt)
    # Also scrub raw 20+ char bearer-like tokens in isolation (heuristic)
    txt = _re.sub(r"Bearer\s+[A-Za-z0-9_\-]{20,}", "Bearer ***", txt, flags=_re.IGNORECASE)
    return txt


class Logger:
    def __init__(self, scope: str = "app"):
        self.scope = scope

    def _emit(self, level: str, msg: str, exc: BaseException | None = None, **fields):
        if _LEVELS.get(level, 20) < _THRESHOLD:
            return
        rec = {
            "level": level,
            "time": datetime.now(timezone.utc).isoformat(),
            "scope": self.scope,
            "msg": _clean(msg),
        }
        cid = get_correlation_id()
        if cid:
            rec["cid"] = cid
        # Rich error fields when an exception is attached.
        if exc is not None:
            rec["error_type"] = type(exc).__name__
            rec["error_msg"] = _clean(str(exc))
            rec["traceback"] = _clean(
                "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            )
        if fields:
            for k, v in fields.items():
                rec[k] = _clean(v) if isinstance(v, str) else v
        line = json.dumps(rec, default=str)
        # stdout (pm2 captures this)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
        # file sinks (proper logging; level gates which handlers receive it)
        if _file_handler is not None or _err_handler is not None:
            _file_logger.log(_LEVELS[level], line)

    # ── leveled methods ──
    def debug(self, msg="", **fields):
        self._emit("debug", msg, **fields)

    def info(self, msg="", **fields):
        self._emit("info", msg, **fields)

    def warn(self, msg="", **fields):
        self._emit("warn", msg, **fields)

    def error(self, msg="", exc: BaseException | None = None, **fields):
        """Emit an error. Pass `exc=exception_instance` to capture type+trace."""
        if exc is None and "err" in fields and isinstance(fields["err"], BaseException):
            exc = fields.pop("err")
        self._emit("error", msg, exc=exc, **fields)


def get_logger(scope: str = "app") -> Logger:
    return Logger(scope)
