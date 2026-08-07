"""A walked batch is a deep manual check of its shelf: products the batch
physically handled whose Shopify bin disagrees (or is missing) get a
one-tap "write this bin to Shopify" offer — at Verify (bin_differs on
report rows) and on the Inventory tab (shopify_bin + bin_differs per row).
The write itself is the existing audited /api/bin-updates; nothing here
touches quantities.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_binfix_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
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
    from app.models import Batch, BatchItem, BinMapEntry, RfidAssignment

    with S(get_engine()) as s:
        b = Batch(bin_name="K3-3", status="awaiting-verify",
                  created_by="Nick")
        s.add(b); s.flush()
        # Handled here, Shopify says NOTHING -> offer.
        s.add(BatchItem(batch_id=b.id, scanned_code="1", resolved=True,
                        sku="NOBIN-1", barcode="1", qty_scanned=2,
                        paired_count=2, bin_location=None,
                        product_title="Unbinned Camera",
                        shopify_variant_id="gid://v/1"))
        # Handled here, Shopify says ELSEWHERE -> offer.
        s.add(BatchItem(batch_id=b.id, scanned_code="2", resolved=True,
                        sku="WRONG-1", barcode="2", qty_scanned=1,
                        paired_count=1, bin_location="A1-1",
                        product_title="Wrong-shelf Widget",
                        shopify_variant_id="gid://v/2"))
        # Handled here, Shopify AGREES (split shelf counts) -> no offer.
        s.add(BatchItem(batch_id=b.id, scanned_code="3", resolved=True,
                        sku="OK-1", barcode="3", qty_scanned=1,
                        paired_count=1, bin_location="K3-3 & B9-9",
                        product_title="Fine Filter",
                        shopify_variant_id="gid://v/3"))
        # Pre-seeded, NEVER handled (0 everything) -> no offer: nobody
        # touched the box, so the batch proves nothing about it.
        s.add(BatchItem(batch_id=b.id, scanned_code="4", resolved=True,
                        sku="GHOST-1", barcode="4", qty_scanned=0,
                        paired_count=0, bin_location="Z9-9",
                        product_title="Untouched Product",
                        shopify_variant_id="gid://v/4"))
        # Inventory side: tags at K4-1...
        s.add(RfidAssignment(rfid_id="AAAA0000000000000000000A",
                             shopify_variant_id="gid://v/5", sku="INV-1",
                             product_title="Inventory Product",
                             bin_location="K4-1"))
        # ...while the live map bins the product at J2-2 -> offer.
        s.add(BinMapEntry(sku="INV-1", barcode="5", bin="J2-2", qty=1,
                          product_title="Inventory Product",
                          shopify_variant_id="gid://v/5",
                          shopify_product_id="gid://shopify/Product/5"))
        # Agreeing product -> no offer.
        s.add(RfidAssignment(rfid_id="AAAA0000000000000000000B",
                             shopify_variant_id="gid://v/6", sku="INV-2",
                             product_title="Settled Product",
                             bin_location="C2-2"))
        s.add(BinMapEntry(sku="INV-2", barcode="6", bin="C2-2", qty=1,
                          product_title="Settled Product",
                          shopify_variant_id="gid://v/6",
                          shopify_product_id="gid://shopify/Product/6"))
        # Tags at a bin Shopify lists among SEVERAL (split) -> no offer.
        s.add(RfidAssignment(rfid_id="AAAA0000000000000000000C",
                             shopify_variant_id="gid://v/7", sku="INV-3",
                             product_title="Split Product",
                             bin_location="D1-1"))
        s.add(BinMapEntry(sku="INV-3", barcode="7", bin="E5-5", qty=1,
                          other_bins="D1-1",
                          product_title="Split Product",
                          shopify_variant_id="gid://v/7",
                          shopify_product_id="gid://shopify/Product/7"))
        s.commit()
        bid = b.id

    rep = cl.post(f"/api/batches/{bid}/verify", json={"epcs": []}).json()
    rows = {r["sku"]: r for r in rep["items"]}
    check("verify: handled + Shopify-bin missing -> offer",
          rows["NOBIN-1"]["bin_differs"] is True, rows["NOBIN-1"])
    check("verify: handled + Shopify says another shelf -> offer",
          rows["WRONG-1"]["bin_differs"] is True, rows["WRONG-1"])
    check("verify: the row says what Shopify currently believes",
          rows["WRONG-1"]["bin_location"] == "A1-1", rows["WRONG-1"])
    check("verify: split-shelf agreement -> no offer",
          rows["OK-1"]["bin_differs"] is False, rows["OK-1"])
    check("verify: an untouched pre-seed row proves nothing -> no offer",
          rows["GHOST-1"]["bin_differs"] is False, rows["GHOST-1"])

    inv = cl.get("/api/inventory/summary").json()
    prods = {p["sku"]: p for p in inv["products"]}
    check("inventory: rows carry Shopify's bin for comparison",
          prods["INV-1"]["shopify_bin"] == "J2-2", prods.get("INV-1"))
    check("inventory: tags-vs-Shopify disagreement -> offer",
          prods["INV-1"]["bin_differs"] is True, prods.get("INV-1"))
    check("inventory: agreement -> no offer",
          prods["INV-2"]["bin_differs"] is False, prods.get("INV-2"))
    check("inventory: Shopify listing the tags' bin among several is "
          "agreement", prods["INV-3"]["bin_differs"] is False,
          prods.get("INV-3"))

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
