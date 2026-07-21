"""Diagnostic terminal script -- "what's actually in this database?"

Companion to test_shopify.py. Reads DATABASE_URL from .env and, without
modifying anything:

    py inspect_db.py               list every table with its row count
    py inspect_db.py TABLENAME     show the first 20 rows of that table
    py inspect_db.py TABLENAME 50  show the first 50 rows

Read-only: runs only SELECTs against INFORMATION_SCHEMA and the named table.
"""
import sys

from sqlalchemy import create_engine, text

from app import config
from app.database import _normalize_url

if not config.DATABASE_URL:
    sys.exit("DATABASE_URL is not set in .env — add it first (see README).")

engine = create_engine(_normalize_url(config.DATABASE_URL))

with engine.connect() as conn:
    if len(sys.argv) < 2:
        # No table named: list all tables and how many rows each has.
        tables = conn.execute(text(
            "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_TYPE = 'BASE TABLE' "
            "ORDER BY TABLE_SCHEMA, TABLE_NAME"
        )).all()
        if not tables:
            print("No tables found — the database is empty.")
        print(f"{'table':50} rows")
        print("-" * 60)
        for schema, name in tables:
            count = conn.execute(
                text(f"SELECT COUNT(*) FROM [{schema}].[{name}]")
            ).scalar()
            label = name if schema == "dbo" else f"{schema}.{name}"
            print(f"{label:50} {count}")
        print("\nRun  py inspect_db.py TABLENAME  to see a table's rows.")
    else:
        table = sys.argv[1]
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        # Resolve the schema so plain names like TELCAN_ORDERS work.
        row = conn.execute(
            text("SELECT TOP 1 TABLE_SCHEMA, TABLE_NAME "
                 "FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = :t"),
            {"t": table},
        ).first()
        if row is None:
            sys.exit(f"No table named '{table}'. Run with no arguments to "
                     f"list tables.")
        schema, name = row
        result = conn.execute(
            text(f"SELECT TOP ({limit}) * FROM [{schema}].[{name}]")
        )
        columns = list(result.keys())
        rows = result.all()
        print(" | ".join(columns))
        print("-" * min(120, max(len(" | ".join(columns)), 20)))
        for r in rows:
            print(" | ".join("" if v is None else str(v) for v in r))
        print(f"\n({len(rows)} rows shown from [{schema}].[{name}])")
