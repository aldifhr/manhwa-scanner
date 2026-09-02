"""Supabase/DB client entrypoint.

PostgREST client removed — backend now talks to PostgreSQL directly via the
transaction pooler (see app/db_adapter.py). This module re-exports get_supabase()
so existing `from app.db import get_supabase` imports keep working unchanged.
"""
from app.db_adapter import get_supabase, get_conn, put_conn, q, close_pool, get_pool_stats  # noqa: F401

__all__ = ["get_supabase", "get_conn", "put_conn", "q", "get_pool_stats"]
