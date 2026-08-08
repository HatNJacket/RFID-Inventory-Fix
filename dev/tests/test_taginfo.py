"""Scan-a-tag-and-be-told-what-it-is (C72 TODO #8) + unlink leaves a
receipt in History.

Driven by a real orphan: a box tagged under DB24010501, the SKU Shopify
renamed to F9394B months earlier, so the tag points at a product the
live catalog no longer has (2026-08-06).
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_taginfo_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
import app.main as M
from app.main import app
# Startup kicks a BACKGROUND bin-map rebuild; with fetch_all_variant_bins
# mocked to [] it rewrites the map to EMPTY, and under full-suite load it
# can land AFTER this test seeds its BinMapEntry rows — wiping them and
# failing the live-map checks (flaked 2026-08-08). Tests seed the map by
# hand, so the background rebuild has no business running at all.
M._maybe_refresh_bin_map = lambda *a, **k: False
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

with patch("app.shopify.lookup_barcode", return_value=None), \
     patch("app.shopify.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.fetch_all_variant_bins", return_value=[]), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import (RfidAssignment, BinMapEntry, PrintJob,
                            RfidIncompatible)
    LIVE, ORPHAN = "AAAA0000000000000000000A", "BBBB0000000000000000000B"
    MOVED, CASE  = "CCCC0000000000000000000C", "DDDD0000000000000000000D"
    PRINTED      = "EEEE0000000000000000000E"
    with S(get_engine()) as s:
        s.add(BinMapEntry(sku="F9394B", barcode="507641", bin="I1-5", qty=3,
                          product_title="Svbony SA206",
                          image_url="https://img/x.jpg",
                          shopify_variant_id="gid://v/1"))
        # Two live tags for it, both in its bin.
        for e in (LIVE, "AAAA0000000000000000000F"):
            s.add(RfidAssignment(rfid_id=e, shopify_variant_id="gid://v/1",
                                 product_title="Svbony SA206", sku="F9394B",
                                 barcode="507641", bin_location="I1-5"))
        # The orphan: tagged under the SKU Shopify renamed away.
        s.add(RfidAssignment(rfid_id=ORPHAN, shopify_variant_id="telcan:1",
                             product_title="Svbony SA206 (old listing)",
                             sku="DB24010501", barcode="507641",
                             bin_location="I1-5", assigned_by="C72"))
        # Recorded on a shelf Shopify no longer agrees with.
        s.add(BinMapEntry(sku="MOVED-1", barcode="222", bin="D2-2", qty=1,
                          product_title="Moved Product",
                          shopify_variant_id="gid://v/2"))
        s.add(RfidAssignment(rfid_id=MOVED, shopify_variant_id="gid://v/2",
                             product_title="Moved Product", sku="MOVED-1",
                             bin_location="K9-9"))
        # A sealed case, and a won't-scan product.
        s.add(BinMapEntry(sku="CASE-1", barcode="333", bin="A1-1", qty=8,
                          product_title="Case Product",
                          shopify_variant_id="gid://v/3"))
        s.add(RfidAssignment(rfid_id=CASE, shopify_variant_id="gid://v/3",
                             product_title="Case Product", sku="CASE-1",
                             bin_location="A1-1", case_units=8, suspect=True))
        s.add(RfidIncompatible(sku="CASE-1", set_by="Steve"))
        s.add(PrintJob(epc=PRINTED, status="done", sku="NEVER-PAIRED",
                       product_title="Printed But Unpaired",
                       shopify_variant_id="gid://v/4"))
        s.commit()

    r = cl.get(f"/api/tag-info/{LIVE}").json()
    check("a healthy tag reports product, counts and bin",
          r["found"] and r["assignment"]["sku"]=="F9394B"
          and r["tags_total"]==2 and r["tags_here"]==2
          and r["live_sku_exists"] and r["expected_qty"]==3
          and r["image_url"]=="https://img/x.jpg", r)
    check("a healthy tag raises no warnings", r["notes"]==[], r["notes"])

    r = cl.get(f"/api/tag-info/{ORPHAN}").json()
    check("the orphan is named as one (SKU gone from Shopify)",
          r["found"] and r["live_sku_exists"] is False
          and any("no product with SKU" in n for n in r["notes"]), r)
    check("and it is NOT counted among the live product's tags",
          r["tags_total"]==1, r)

    r = cl.get(f"/api/tag-info/{MOVED}").json()
    check("a tag whose bin Shopify disagrees with says so",
          any("Shopify now puts" in n for n in r["notes"])
          and r["live_bins"]==["D2-2"], r)

    r = cl.get(f"/api/tag-info/{CASE}").json()
    check("sealed-case, suspect and won't-scan all surface",
          len([n for n in r["notes"] if "Sealed case" in n])==1
          and any("SUSPECT" in n for n in r["notes"])
          and any("won't RFID scan" in n for n in r["notes"]), r["notes"])

    r = cl.get(f"/api/tag-info/{PRINTED}").json()
    check("a printed-but-never-paired label is explained, not 404'd",
          r["found"] is False and r["printed_only"] is True
          and r["print_job"]["sku"]=="NEVER-PAIRED", r)

    r = cl.get("/api/tag-info/FFFF0000000000000000000F").json()
    check("a tag nobody owns is answered too",
          r["found"] is False and r["printed_only"] is False
          and r["notes"], r)

    # ---- unlink leaves a receipt ---------------------------------------
    r = cl.delete(f"/api/rfid-assignments/{ORPHAN}?by=C72")
    check("unlinking the orphan works", r.status_code==204, r.status_code)
    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"]=="tag-unlinked"]
    check("History keeps the receipt (tag, product, who)",
          len(ev)==1 and ev[0]["sku"]=="DB24010501"
          and ORPHAN in (ev[0]["detail"] or "")
          and ev[0]["worker"]=="C72", ev)
    r = cl.get(f"/api/tag-info/{ORPHAN}").json()
    check("the unlinked tag now reads as unknown",
          r["found"] is False, r)
    check("the live product's tags are untouched",
          cl.get(f"/api/tag-info/{LIVE}").json()["tags_total"]==2, None)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
