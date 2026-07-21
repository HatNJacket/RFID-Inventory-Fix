"""Database engine and session management.

PostgreSQL on Azure in production. The engine is created lazily so the app
can still start and serve Shopify lookups even before DATABASE_URL is set
(useful during Phase 1 local development before you provision PostgreSQL).
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app import config


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal = None


def _normalize_url(url: str) -> str:
    """Azure hands out 'postgresql://'; SQLAlchemy + psycopg3 wants
    'postgresql+psycopg://'. Normalize so either form works."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def get_engine():
    global _engine, _SessionLocal
    if _engine is None:
        if not config.DATABASE_URL:
            raise RuntimeError(
                "DATABASE_URL is not set. Add it to .env (local) or App "
                "Service environment variables (Azure) before using the "
                "database."
            )
        _engine = create_engine(
            _normalize_url(config.DATABASE_URL),
            pool_pre_ping=True,
        )
        _SessionLocal = sessionmaker(
            bind=_engine, autoflush=False, autocommit=False
        )
    return _engine


def get_session():
    """FastAPI dependency: yields a session, always closes it.
    Raises a clean error (surfaced as HTTP 503 by the app) when no database
    is configured yet, instead of a raw 500."""
    if not config.DATABASE_URL:
        raise DatabaseNotConfigured()
    if _SessionLocal is None:
        get_engine()
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()


class DatabaseNotConfigured(RuntimeError):
    """Raised when a DB-backed route is hit before DATABASE_URL is set."""


def init_db() -> None:
    """Create tables if they don't exist. Fine for now; move to Alembic
    migrations once the schema starts changing in production."""
    from app import models  # noqa: F401  (register models on Base)

    Base.metadata.create_all(bind=get_engine())


def database_configured() -> bool:
    return bool(config.DATABASE_URL)
