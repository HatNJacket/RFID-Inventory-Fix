"""Load (or refresh) the Astronomik serial-prefix table from their sheet.

Astronomik barcodes each unit's serial number instead of a product barcode;
the first four digits (their "SN4") identify the item, and the item number
is our SKU. Their rep supplies the mapping as a spreadsheet with columns
including "item number", "item name", and "SN4".

Usage:
    py load_astronomik.py "C:\\path\\to\\Astronomik.xlsx"

Re-running with a newer sheet upserts: existing prefixes are updated, new
ones added. Requires DATABASE_URL in .env (writes only rfid_serial_prefixes).
"""
import sys

import openpyxl
from sqlalchemy.orm import Session

from app.database import get_engine, init_db
from app.models import SerialPrefix

BRAND = "Astronomik"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]

    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip().lower() if h else "" for h in next(rows)]
    try:
        i_item = header.index("item number")
        i_name = header.index("item name")
        i_sn4 = header.index("sn4")
    except ValueError:
        sys.exit(f"Expected columns 'item number', 'item name', 'SN4' — "
                 f"found: {header}")

    init_db()
    added = updated = skipped = 0
    with Session(get_engine()) as session:
        for row in rows:
            sn4 = str(row[i_sn4]).strip() if row[i_sn4] is not None else ""
            sku = str(row[i_item]).strip() if row[i_item] is not None else ""
            name = str(row[i_name]).strip() if row[i_name] is not None else ""
            if not sn4 or not sku or not sn4.isdigit():
                skipped += 1
                continue
            existing = session.get(SerialPrefix, sn4)
            if existing is None:
                session.add(SerialPrefix(
                    prefix=sn4, brand=BRAND, sku=sku, item_name=name[:255]
                ))
                added += 1
            else:
                existing.brand, existing.sku = BRAND, sku
                existing.item_name = name[:255]
                updated += 1
        session.commit()
    print(f"done: {added} added, {updated} updated, {skipped} skipped")


if __name__ == "__main__":
    main()
