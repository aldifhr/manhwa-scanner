"""Config loaded from .env (parity with be-ag shared/env.ts)."""
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", frozen=True)

    # Discord
    DISCORD_BOT_TOKEN: str = ""
    DISCORD_PUBLIC_KEY: str = ""
    DISCORD_CLIENT_SECRET: str = ""
    DISCORD_OAUTH_REDIRECT_URI: str = "https://scanner.aldifhr.fun/api/auth/discord/callback"
    OUTBOUND_WEBHOOK_URLS: str = ""
    DISCORD_GUILD_ID: str = ""
    ERROR_WEBHOOK_URL: str = ""
    ADMIN_REPORT_CHANNEL_ID: str = ""

    # Direct PostgreSQL connection (transaction pooler, IPv4, reachable from VPS)
    # Example: postgresql://postgres.<ref>:***@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require
    DATABASE_URL: str = ""

    # Public base URL used by cron/embeds/fe to build absolute links
    # and proxy endpoints. Defaults to the deployed scanner host.
    PUBLIC_BASE_URL: str = "https://scanner.aldifhr.fun"

    # Sources — support both old (IKIRU_BASE_URL etc.) and new (.env) names.
    # New .env uses IKIRU_PUBLIC_URL / SHINIGAMI_API_URL / SHINIGAMI_PUBLIC_URL.
    # Old code uses IKIRU_BASE_URL / SECONDARY_SOURCE_URL / SECONDARY_PUBLIC_BASE.
    # Validator below syncs them so either name works.
    IKIRU_BASE_URL: str = "https://07.ikiru.wtf/"
    IKIRU_PUBLIC_URL: str = ""
    SECONDARY_SOURCE_URL: str = "https://api.shngm.io"
    SHINIGAMI_API_URL: str = ""
    SECONDARY_PUBLIC_BASE: str = "https://11.shinigami.asia"
    VORATOON_API_URL: str = "https://api.voratoon.com"
    SHINIGAMI_PUBLIC_URL: str = ""
    # Only ikiru + shinigami are active sources (user: "cukup 2 sumber aja").
    SOURCE_KEYS: list[str] = ["ikiru", "shinigami", "voratoon"]
    # Comma-separated sources to skip in collection (ops toggle, no code change).
    # e.g. DISABLED_SOURCES=ikiru focuses collection on shinigami only.
    DISABLED_SOURCES: str = ""

    # Scraper
    RSS_LOOKBACK_HOURS: int = 24

    # Cron
    CRON_SECRET: str = ""
    FASTCRON_API_KEY: str = ""  # Legacy/rotation support — either secret works
    MONITOR_AUTH_TOKEN: str = ""
    # Member login password (write-limited: can add whitelist / exclude,
    # cannot delete / retry / clear / access settings). Separate from admin.
    MEMBER_AUTH_TOKEN: str = ""
    # JWT session-cookie secret for /api/auth login.
    # MUST be set explicitly — never defaults to MONITOR_AUTH_TOKEN (which is
    # exposed in query strings). Boot guard in _validate_settings enforces this.
    AUTH_SECRET: str = ""
    # Kill switch: set "false" to halt all FastCron runs (returns 503, run skipped).
    # Used to pause cron without deleting code or touching FastCron dashboard.
    CRON_ENABLED: str = "true"
    # Dev/test only: disable monitor auth entirely. NEVER set true in production.
    AUTH_DISABLED: bool = False

    # Redis (durable task queue for Discord add-to-whitelist jobs)
    REDIS_URL: str = "redis://localhost:6379/0"

    # HTTP
    HTTP_USER_AGENT: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    # Image proxy: only these upstream hosts may be fetched. NO wildcards,
    # NO arbitrary ports — explicit host:port pairs to prevent SSRF.
    # Note: derived dynamically via get_proxy_hosts() to stay in sync with IKIRU/SHINIGAMI/VORATOON URLs.
    PROXY_ALLOWED_HOSTS: list[str] = [
        "07.ikiru.wtf:443",
        "ikiru.wtf:443",
        "g.shinigami.asia:443",
        "shinigami.asia:443",
        "assets.shngm.id:443",
        "cvr.voratoon.id:443",
        "cdn.voratoon.com:443",
    ]

    def get_proxy_hosts(self) -> list[str]:
        """Dynamic allowlist derived from current IKIRU/SHINIGAMI/VORATOON settings."""
        from urllib.parse import urlparse

        hosts: set[str] = set(self.PROXY_ALLOWED_HOSTS)
        for raw in (self.IKIRU_BASE_URL, self.SECONDARY_SOURCE_URL, self.VORATOON_API_URL, self.SECONDARY_PUBLIC_BASE):
            try:
                p = urlparse(raw)
                if p.hostname:
                    port = p.port or (443 if p.scheme == "https" else 80)
                    hosts.add(f"{p.hostname.lower()}:{port}")
            except Exception:
                pass
        return sorted(hosts)

    # Deploy env: "production" | "development"
    ENVIRONMENT: str = "production"

    @model_validator(mode="after")
    def _sync_aliases(self):
        # New .env names take precedence; keep both aliases in sync for code that reads either.
        if self.IKIRU_PUBLIC_URL:
            object.__setattr__(self, "IKIRU_BASE_URL", self.IKIRU_PUBLIC_URL)
        elif self.IKIRU_BASE_URL:
            object.__setattr__(self, "IKIRU_PUBLIC_URL", self.IKIRU_BASE_URL)
        if self.SHINIGAMI_API_URL:
            object.__setattr__(self, "SECONDARY_SOURCE_URL", self.SHINIGAMI_API_URL)
        elif self.SECONDARY_SOURCE_URL:
            object.__setattr__(self, "SHINIGAMI_API_URL", self.SECONDARY_SOURCE_URL)
        if self.SHINIGAMI_PUBLIC_URL:
            object.__setattr__(self, "SECONDARY_PUBLIC_BASE", self.SHINIGAMI_PUBLIC_URL)
        elif self.SECONDARY_PUBLIC_BASE:
            object.__setattr__(self, "SHINIGAMI_PUBLIC_URL", self.SECONDARY_PUBLIC_BASE)
        # normalize trailing slash for ikiru
        if self.IKIRU_BASE_URL and not self.IKIRU_BASE_URL.endswith("/"):
            object.__setattr__(self, "IKIRU_BASE_URL", self.IKIRU_BASE_URL + "/")
            object.__setattr__(self, "IKIRU_PUBLIC_URL", self.IKIRU_BASE_URL)
        return self

    # M4 FIX: Warn on unrecognized env vars (extra="ignore" silently drops typos)
    # NOTE: This is a no-op placeholder — pydantic-settings doesn't support
    # "warn" mode natively. Documented for future migration to extra="forbid" in dev.
    # To detect typos, run: python3 -c "from app.config import settings; print(settings.model_dump())"


settings = Settings()


def _validate_settings(s: "Settings") -> None:
    """Refuse to boot if running in production without required secrets.

    Prevents the silent 'auth disabled because .env not loaded' footgun:
    check_monitor_auth() returns True when MONITOR_AUTH_TOKEN is empty, so a
    missing secret would expose every protected endpoint.
    """
    # P0 #3: AUTH_DISABLED in production - warn and enforce auth (not hard fail, was causing 503 on VPS where .env has AUTH_DISABLED=true)
    if s.AUTH_DISABLED and s.ENVIRONMENT.lower() == "production":
        from app.logger import get_logger as _gl
        _gl("config").warn("BOOT GUARD: AUTH_DISABLED=true in production - auth enforced, not bypassed (set ENVIRONMENT=development to bypass)")
    if s.ENVIRONMENT.lower() != "production":
        return
    missing = []
    if not s.CRON_SECRET:
        missing.append("CRON_SECRET")
    if not s.MONITOR_AUTH_TOKEN:
        missing.append("MONITOR_AUTH_TOKEN")
    if not s.AUTH_SECRET:
        missing.append("AUTH_SECRET")
    if not s.DATABASE_URL:
        missing.append("DATABASE_URL")
    if not s.DISCORD_BOT_TOKEN:
        missing.append("DISCORD_BOT_TOKEN")
    if missing:
        raise RuntimeError(
            "BOOT GUARD: production environment missing required secrets: "
            + ", ".join(missing)
            + ". Set them in .env or set ENVIRONMENT=development to bypass."
        )


_validate_settings(settings)
