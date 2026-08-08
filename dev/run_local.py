"""Local UI-verification server: sqlite seeded with a batch awaiting
verify — one normal product, one flagged 'won't RFID scan' — plus a C72
sweep capture that heard ONLY the normal product's tags."""
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "uiverify.db")
if os.path.exists(DB):
    os.remove(DB)
os.environ["DATABASE_URL"] = "sqlite:///" + DB.replace("\\", "/")
os.environ["SHOPIFY_STORE"] = "t.myshopify.com"
os.environ["SHOPIFY_CLIENT_ID"] = "x"
os.environ["SHOPIFY_CLIENT_SECRET"] = "x"
os.environ["SHOPIFY_WRITE_MODE"] = "scan_station_only,verify_onhand"
os.environ.pop("STATION_KEY", None)
os.environ.pop("PRINT_AGENT_KEY", None)

from app.main import app  # noqa: E402  (env must be set first)
from app.database import get_engine  # noqa: E402
from app.models import (  # noqa: E402
    Base, Batch, BatchItem, BinMapEntry, EpcCapture, PrintJob,
    ReviewTask, RfidAssignment, RfidIncompatible,
)
from sqlalchemy.orm import Session  # noqa: E402

# Tables normally appear in the app's startup hook; seeding runs first.
Base.metadata.create_all(get_engine())

with Session(get_engine()) as s:
    b = Batch(bin_name="T1-1", status="awaiting-verify", ui_step="verify",
              created_by="Steve")
    s.add(b)
    s.flush()
    normal = BatchItem(batch_id=b.id, scanned_code="111", resolved=True,
                       sku="NORMAL-1", barcode="111",
                       product_title="Baader UHC Filter 2in",
                       shopify_variant_id="t:1", qty_scanned=2,
                       paired_count=2, bin_location="T1-1",
                       expected_qty=5,
                       shopify_product_id="gid://shopify/Product/123456789")
    flagged = BatchItem(batch_id=b.id, scanned_code="222", resolved=True,
                        sku="OPTO-LPRO", barcode="222",
                        product_title="Optolong L-Pro 2in (won't-scan test)",
                        shopify_variant_id="t:2", qty_scanned=2,
                        paired_count=2, bin_location="T1-1",
                        expected_qty=2)
    # Found MORE than Shopify knew about: the on-hand fix button's case.
    surplus = BatchItem(batch_id=b.id, scanned_code="333", resolved=True,
                        sku="SURPLUS-1", barcode="333",
                        product_title="Baader Filter Drawer (surplus test)",
                        shopify_variant_id="t:3", qty_scanned=4,
                        paired_count=4, bin_location="T1-1",
                        expected_qty=2)
    surplus2 = BatchItem(batch_id=b.id, scanned_code="444", resolved=True,
                         sku="SURPLUS-2", barcode="444",
                         product_title="Antlia ALP-T (second surplus)",
                         shopify_variant_id="t:4", qty_scanned=3,
                         paired_count=3, bin_location="T1-1",
                         expected_qty=1)
    # Already-tagged exception: boxes stickered on an earlier side trip —
    # 0 scanned / 0 paired here is CORRECT; the sweep hears their tags.
    pretag = BatchItem(batch_id=b.id, scanned_code="555", resolved=True,
                       sku="PRETAG-1", barcode="555",
                       product_title="Askar FMA180 (already-tagged test)",
                       shopify_variant_id="t:5", qty_scanned=0,
                       paired_count=0, tagged_before=2,
                       bin_location="T1-1", expected_qty=2)
    # The F9384A shape: 1 scanned+paired here, but the sweep also hears a
    # second tag recorded at ANOTHER shelf -> flagged, expandable, and
    # resolvable by setting already-tagged to 1.
    mis = BatchItem(batch_id=b.id, scanned_code="666", resolved=True,
                    sku="MIS-1", barcode="666",
                    product_title="Svbony SV405CC (mismatch test)",
                    shopify_variant_id="t:6", qty_scanned=1,
                    paired_count=1, bin_location="T1-1", expected_qty=2)
    s.add_all([normal, flagged, surplus, surplus2, pretag, mis])
    # Recommended checks with different mismatch sizes, for the sort.
    s.add_all([
        ReviewTask(category="inventory-check", sku="SMALL-1",
                   product_title="Small mismatch",
                   detail="Bin A1-1: 3 unit(s) counted but Shopify "
                          "on-hand is 4. Recommend a product check."),
        ReviewTask(category="inventory-check", sku="BIG-1",
                   product_title="Big mismatch",
                   detail="Bin B2-2: 1 unit(s) counted but Shopify "
                          "on-hand is 9. Recommend a product check."),
        ReviewTask(category="inventory-check", sku="MID-1",
                   product_title="Middle mismatch",
                   detail="Bin C3-3: 8 unit(s) counted but Shopify "
                          "on-hand is 5. Recommend a product check."),
    ])
    s.add(RfidIncompatible(sku="OPTO-LPRO", set_by="Steve"))
    epcs = {
        "NORMAL-1": ["AAAA0000000000000000000A", "AAAA0000000000000000000B"],
        "OPTO-LPRO": ["BBBB0000000000000000000A", "BBBB0000000000000000000B"],
    }
    # PRETAG-1's tags predate the batch (no batch_id, no barcode on the
    # tag rows — the SKU-only match must claim them, not call them
    # foreign) and the sweep heard both.
    for epc in ("CCCC0000000000000000000A", "CCCC0000000000000000000B"):
        s.add(RfidAssignment(rfid_id=epc, shopify_variant_id="t:5",
                             product_title="Askar FMA180",
                             sku="pretag-1", bin_location="T1-1"))
    for sku, pair in epcs.items():
        title = ("Baader UHC Filter 2in" if sku == "NORMAL-1"
                 else "Optolong L-Pro 2in (won't-scan test)")
        for epc in pair:
            s.add(PrintJob(epc=epc, status="done", batch_id=b.id,
                           shopify_variant_id="t:x", product_title=title,
                           sku=sku, barcode="111" if sku == "NORMAL-1"
                           else "222", bin_location="T1-1"))
            s.add(RfidAssignment(rfid_id=epc, shopify_variant_id="t:x",
                                 product_title=title, sku=sku,
                                 barcode="111" if sku == "NORMAL-1"
                                 else "222", bin_location="T1-1",
                                 batch_id=b.id))
    # MIS-1: one tag paired in this batch, one recorded at another shelf.
    s.add(RfidAssignment(rfid_id="DDDD0000000000000000000A",
                         shopify_variant_id="t:6",
                         product_title="Svbony SV405CC", sku="MIS-1",
                         barcode="666", bin_location="T1-1",
                         batch_id=b.id))
    s.add(RfidAssignment(rfid_id="DDDD0000000000000000000B",
                         shopify_variant_id="t:6",
                         product_title="Svbony SV405CC", sku="MIS-1",
                         bin_location="Z9-9"))
    # The C72 sweep heard the normal product, the pre-tagged boxes, and
    # BOTH MIS-1 tags.
    swept = epcs["NORMAL-1"] + [
        "CCCC0000000000000000000A", "CCCC0000000000000000000B",
        "DDDD0000000000000000000A", "DDDD0000000000000000000B",
    ]
    s.add(EpcCapture(device="C72-test", note="Bin T1-1 verify sweep",
                     batch_id=b.id, epc_count=len(swept),
                     epcs="\n".join(swept)))
    # Audit-board data: Steve's worked example (score 6), a score-4 bin,
    # an untagged bin, and the T1-1 products (received-not-found: NORMAL
    # shows 5 on hand, only 2 tagged).
    def m(sku, title, bin_, qty, barcode=None):
        return BinMapEntry(sku=sku, product_title=title, bin=bin_, qty=qty,
                           barcode=barcode, shopify_variant_id="t:" + sku)
    # Barcodes on the T1-1 rows so scan-station lookups (and C72 LINK
    # relays) resolve locally from the live bin map, like prod does.
    nm = m("NORMAL-1", "Baader UHC Filter 2in", "T1-1", 5, barcode="111")
    nm.shopify_product_id = "gid://shopify/Product/123456789"
    s.add_all([
        nm,
        m("OPTO-LPRO", "Optolong L-Pro 2in (won't-scan test)", "T1-1", 2,
          barcode="222"),
        # Expected here, nothing tagged: the row that hides behind the
        # audit's untagged toggle.
        m("PROD-Z", "Product Z (never tagged)", "BIN-T", 3),
        m("PROD-A", "Product A", "BIN-T", 6),
        m("PROD-B", "Product B", "BIN-T", 5),
        m("PROD-C", "Product C", "BIN-T", 4),
        m("PROD-F", "Product F", "BIN-D", 6),
        m("PROD-U", "Product U (untagged bin)", "BIN-U", 2),
        # Tags say K4-1, Shopify says J2-2: the Inventory tab's
        # "⇢ Shopify" offer (and the K4-1 chip's no-wrap fix).
        m("MISMATCH-1", "Mismatch Demo (tags K4-1, Shopify J2-2)",
          "J2-2", 1, barcode="999"),
    ])
    s.add(RfidAssignment(rfid_id="MMMM0000000000000000000M",
                         shopify_variant_id="t:MM", sku="MISMATCH-1",
                         product_title="Mismatch Demo (tags K4-1, "
                                       "Shopify J2-2)",
                         bin_location="K4-1"))
    # BIN-T was batch-tagged to completion; BIN-D only has stray tags.
    from datetime import datetime, timezone
    done_at = datetime.now(timezone.utc)
    real_done = Batch(bin_name="BIN-T", status="done",
                      completed_at=done_at, created_by="Steve")
    s.add(real_done)
    s.flush()
    # A finished SIDE TRIP into BIN-D: must show in Recently done with a
    # "side trip" chip, must NOT count BIN-D as a done bin, and History
    # must call it a side trip.
    s.add(Batch(bin_name="BIN-D", status="done", completed_at=done_at,
                created_by="Nick", parent_batch_id=real_done.id))
    # An already-tagged answer, for the History chip.
    from app.models import BarcodeChange
    s.add(BarcodeChange(sku="NORMAL-1", product_title="Baader UHC Filter",
                        changed_field="tagged-before", old_barcode="0",
                        new_barcode="2", changed_by="C72-test"))
    extra = {
        "PROD-A": ("BIN-T", 3), "PROD-B": ("BIN-T", 8),
        "PROD-C": ("BIN-T", 4), "PROD-F": ("BIN-D", 2),
    }
    n = 0
    for sku, (bin_, count) in extra.items():
        for _ in range(count):
            n += 1
            s.add(RfidAssignment(rfid_id=f"E{n:023d}",
                                 shopify_variant_id="t:x",
                                 product_title=sku, sku=sku,
                                 bin_location=bin_))
    s.commit()
    print(f"seeded batch {b.id} on T1-1 + audit data")

# Fake Shopify inventory so the on-hand button works end-to-end locally.
from app import shopify as _sh  # noqa: E402
_FAKE = {"SURPLUS-1": 2, "SURPLUS-2": 1, "NORMAL-1": 5, "OPTO-LPRO": 2}
def _fake_get(sku):
    return _FAKE.get(sku)
def _fake_set(sku, qty):
    before = _FAKE.get(sku, 0)
    _FAKE[sku] = int(qty)
    print(f"[fake shopify] on-hand {sku}: {before} -> {qty}")
    return before
_sh.get_on_hand = _fake_get
_sh.set_on_hand = _fake_set
# No-op the API lookup paths too: the live bin map answers product
# identity locally, and a dead API must degrade to that instead of
# surfacing token errors (mirrors the dev/tests mocking). One product
# answers so the "write bin to Shopify" buttons run end to end.
_MM = {"shopify_variant_id": "t:MM",
       "shopify_product_id": "gid://shopify/Product/424242",
       "product_title": "Mismatch Demo (tags K4-1, Shopify J2-2)",
       "variant_title": None, "sku": "MISMATCH-1", "barcode": "999",
       "bin_location": "J2-2", "image_url": None}
_sh.lookup_barcode = lambda code: (
    dict(_MM) if code in ("999", "MISMATCH-1") else None)
_sh.lookup_barcode_all = lambda code: (
    [dict(_MM)] if code in ("999", "MISMATCH-1") else [])
_sh.set_variant_bin = (
    lambda vid, b: print(f"[fake shopify] variant bin {vid} -> {b}"))
_sh.product_bin_info = lambda pid: {"variant_count": 1, "easy_bin": None}
_sh.set_product_bin = (
    lambda pid, b: print(f"[fake shopify] easyscan bin {pid} -> {b}"))
_sh.fetch_all_variant_bins = lambda: []
_sh.get_stock_info_by_skus = lambda skus: {}
_sh.get_quantities_by_skus = lambda skus: {}

# Fake TC-Planner bridge: NORMAL-1 sits on an open PO so the on-order
# hint shows on both the Scan Station card and receiving collect.
from app import planner as _pl  # noqa: E402
_pl.health = lambda operator=None: {
    "configured": True, "ok": True,
    "service": "fake-planner", "identified_as": operator or "RFID"}
def _fake_on_order(sku, operator=None):
    base = {"configured": True, "ok": True, "sku": sku,
            "total_remaining": 0, "orders": []}
    if (sku or "").upper() == "NORMAL-1":
        base["orders"] = [{
            "order_id": 10, "reference_number": 935,
            "vendor": "Sky-Watcher", "status": "partial_received",
            "expected_date": "2026-09-04",
            "ordered": 6, "received": 2, "remaining": 4,
        }]
        base["total_remaining"] = 4
    return base
_pl.on_order_for_sku = _fake_on_order

import uvicorn  # noqa: E402
uvicorn.run(app, host="127.0.0.1", port=8123)
