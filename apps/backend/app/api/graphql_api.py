"""GraphQL API — Strawberry GraphQL setup for manhwa-backend."""
from __future__ import annotations

import strawberry
from strawberry.fastapi import GraphQLRouter
from strawberry.types import Info
from typing import Optional


# ── Types ──

@strawberry.type
class SourceHealth:
    name: str
    status: str
    last_scrape: Optional[str] = None
    last_success: Optional[str] = None
    error_rate_24h: float = 0.0
    consecutive_failures: int = 0
    last_error: Optional[str] = None
    disabled_until: Optional[str] = None


@strawberry.type
class WhitelistEntry:
    title_key: str
    source: str
    title: Optional[str] = None
    url: Optional[str] = None
    cover: Optional[str] = None
    rating: Optional[float] = None
    status: Optional[str] = None
    origin: Optional[str] = None
    latest_chapter: Optional[float] = None
    latest_sent_chapter: Optional[float] = None
    created_at: Optional[str] = None


@strawberry.type
class RSSItem:
    title_key: str
    title: str
    chapter: str
    chapter_url: str
    series_url: Optional[str] = None
    source: str
    updated_time: Optional[str] = None


@strawberry.type
class DispatchHistoryItem:
    title_key: str
    chapter_title: str
    chapter_url: str
    source: str
    sent_at: str


@strawberry.type
class AnalyticsOverview:
    popular_series: list[PopularSeriesEntry]
    chapter_velocity: list[VelocityEntry]
    source_distribution: list[SourceDistributionEntry]


@strawberry.type
class PopularSeriesEntry:
    title_key: str
    source: str
    dispatch_count: int
    last_dispatched: Optional[str] = None


@strawberry.type
class VelocityEntry:
    date: str
    total_dispatches: int
    unique_series: int


@strawberry.type
class SourceDistributionEntry:
    source: str
    count: int


# ── Queries ──

def _check_auth(info: Info) -> bool:
    """Check if request is authenticated."""
    request = info.context["request"]
    from app.utils.request_auth import require_monitor_auth
    return require_monitor_auth(request)


@strawberry.type
class Query:
    @strawberry.field
    def health(self, info: Info) -> list[SourceHealth]:
        """Get source health status."""
        if not _check_auth(info):
            raise Exception("Unauthorized")
        
        from app.storage import health as health_store
        from app.config import settings
        hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
        result = []
        for src, row in (hm or {}).items():
            ok_24h = int(row.get("successes_today") or 0) + int(row.get("failures_today") or 0)
            err_rate = round(100.0 * int(row.get("failures_today") or 0) / ok_24h, 1) if ok_24h else 0.0
            result.append(SourceHealth(
                name=src,
                status=row.get("status", "healthy"),
                last_scrape=row.get("last_checked_at"),
                last_success=row.get("last_success_at"),
                error_rate_24h=err_rate,
                consecutive_failures=row.get("consecutive_failures", 0),
                last_error=row.get("last_error"),
                disabled_until=row.get("disabled_until"),
            ))
        return result

    @strawberry.field
    def whitelist(
        self,
        info: Info,
        source: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[WhitelistEntry]:
        """Get whitelist entries."""
        if not _check_auth(info):
            raise Exception("Unauthorized")
        
        from app.db import q
        sql = "SELECT * FROM whitelist WHERE 1=1"
        params = []
        if source:
            sql += " AND source = %s"
            params.append(source)
        if search:
            sql += " AND title ILIKE %s"
            params.append(f"%{search}%")
        sql += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
        params.extend([limit, offset])
        
        rows = q(sql, params)
        return [WhitelistEntry(
            title_key=r["title_key"],
            source=r["source"],
            title=r.get("title"),
            url=r.get("url"),
            cover=r.get("cover"),
            rating=r.get("rating"),
            status=r.get("status"),
            origin=r.get("origin"),
            latest_chapter=r.get("latest_chapter"),
            latest_sent_chapter=r.get("latest_sent_chapter"),
            created_at=str(r["created_at"]) if r.get("created_at") else None,
        ) for r in rows]

    @strawberry.field
    def rss_feed(
        self,
        info: Info,
        source: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[RSSItem]:
        """Get recent RSS feed."""
        if not _check_auth(info):
            raise Exception("Unauthorized")
        
        from app.db import q
        sql = "SELECT * FROM recent_chapters WHERE 1=1"
        params = []
        if source:
            sql += " AND source = %s"
            params.append(source)
        sql += " ORDER BY updated_time DESC LIMIT %s OFFSET %s"
        params.extend([limit, offset])
        
        rows = q(sql, params)
        return [RSSItem(
            title_key=r["title_key"],
            title=r.get("title", ""),
            chapter=str(r.get("chapter_number", "")),
            chapter_url=r.get("chapter_url", ""),
            series_url=r.get("series_url"),
            source=r["source"],
            updated_time=str(r["updated_time"]) if r.get("updated_time") else None,
        ) for r in rows]

    @strawberry.field
    def dispatch_history(
        self,
        info: Info,
        limit: int = 50,
        offset: int = 0,
    ) -> list[DispatchHistoryItem]:
        """Get dispatch history."""
        if not _check_auth(info):
            raise Exception("Unauthorized")
        
        from app.db import q
        rows = q("""
            SELECT title_key, chapter_title, chapter_url, source, sent_at
            FROM dispatch_history
            ORDER BY sent_at DESC
            LIMIT %s OFFSET %s
        """, [limit, offset])
        
        return [DispatchHistoryItem(
            title_key=r["title_key"],
            chapter_title=r["chapter_title"],
            chapter_url=r["chapter_url"],
            source=r["source"],
            sent_at=str(r["sent_at"]),
        ) for r in rows]


# ── Schema ──

schema = strawberry.Schema(query=Query)


def get_graphql_router() -> GraphQLRouter:
    """Create GraphQL router."""
    return GraphQLRouter(
        schema,
        path="/graphql",
        graphql_ide="apollo-sandbox",
    )
