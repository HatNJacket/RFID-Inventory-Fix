"""One-off prod migration: add rfid_batches.kind (receiving batches).

sqlite test/dev databases recreate themselves; Azure SQL does not, so run
this ONCE against prod before deploying the receiving feature:

    set DATABASE_URL=<prod mssql url, from the app's Azure settings>
    py dev/alter_add_batch_kind.py

Safe to re-run: it checks INFORMATION_SCHEMA first and does nothing when
the column already exists.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from app.database import get_engine  # noqa: E402

engine = get_engine()
with engine.begin() as conn:
    exists = conn.execute(text(
        "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_NAME = 'rfid_batches' AND COLUMN_NAME = 'kind'"
    )).first()
    if exists:
        print("rfid_batches.kind already exists — nothing to do.")
    else:
        conn.execute(text(
            "ALTER TABLE rfid_batches ADD kind NVARCHAR(20) NULL"
        ))
        print("Added rfid_batches.kind.")
        try:
            conn.execute(text(
                "CREATE INDEX ix_rfid_batches_kind ON rfid_batches (kind)"
            ))
            print("Indexed rfid_batches.kind.")
        except Exception as error:  # index is a nicety, not a requirement
            print(f"Index skipped: {error}")
print("Done.")
