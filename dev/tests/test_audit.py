"""Audit board: bins scored by sum |shopify on-hand - RFID units|, using
Steve's worked example (3v6 + 8v5 + 4v4 = 6), case tags counting their
units, untagged bins marked, and orphan tags grouped visibly."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_audit_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

def row(v, sku, title, bin_, qty):
    return {"shopify_variant_id":v,"shopify_product_id":"gid://p/"+v,
            "product_title":title,"variant_title":None,"sku":sku,
            "barcode":None,"bin":bin_,"qty":qty,"image_url":None,"vendor":"X"}
# Steve's example bin T (score 6), a tagged bin with score 4, an
# untagged bin (score 2), and a clean tagged bin (score 0).
ROWS=[row("t:a","PROD-A","Product A","BIN-T",6),
      row("t:b","PROD-B","Product B","BIN-T",5),
      row("t:c","PROD-C","Product C","BIN-T",4),
      row("t:f","PROD-F","Product F","BIN-D",6),
      row("t:u","PROD-U","Product U","BIN-U",2),
      row("t:k","PROD-K","Product K","BIN-K",1)]

with patch("app.shopify.lookup_barcode", return_value=None), \
     patch("app.shopify.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import Batch, RfidAssignment
    def tag(epc, sku, bin_, case_units=None):
        return RfidAssignment(rfid_id=epc, shopify_variant_id="t:x",
                              product_title=sku, sku=sku, bin_location=bin_,
                              case_units=case_units)
    with S(get_engine()) as s:
        # A: 3 tags (vs 6). B: 5 singles + one 3-unit case = 8 units (vs 5).
        # C: 4 (vs 4). F: 2 (vs 6). K: 1 (vs 1). ORPHAN: 2 tags, no bin map.
        for i in range(3): s.add(tag(f"A{i:023d}", "PROD-A", "BIN-T"))
        for i in range(5): s.add(tag(f"B{i:023d}", "PROD-B", "BIN-T"))
        s.add(tag("B" + "9"*23, "PROD-B", "BIN-T", case_units=3))
        for i in range(4): s.add(tag(f"C{i:023d}", "PROD-C", "BIN-T"))
        for i in range(2): s.add(tag(f"F{i:023d}", "PROD-F", "BIN-D"))
        s.add(tag("K" + "0"*23, "PROD-K", "BIN-K"))
        for i in range(2): s.add(tag(f"E{i:023d}", "ORPHAN-1", "BIN-X"))
        # BIN-T went through batch tagging; BIN-D only has stray/desk tags
        # (the E6-1 case); BIN-K completed too. A side trip into BIN-U must
        # NOT count as done.
        s.add(Batch(bin_name="BIN-T", status="done"))
        s.add(Batch(bin_name="BIN-K", status="done"))
        s.add(Batch(bin_name="BIN-U", status="done", parent_batch_id=999))
        s.commit()

    d = cl.get("/api/audit/bins").json()
    by = {b["bin"]: b for b in d["bins"]}
    check("BIN-T scores 6 (Steve's worked example)",
          by.get("BIN-T", {}).get("score")==6, by.get("BIN-T"))
    check("case tag counted as its units (B = 8 RFID units)",
          next(p for p in by["BIN-T"]["products"] if p["sku"]=="PROD-B")
          ["rfid_units"]==8, by["BIN-T"]["products"])
    check("BIN-D scores 4", by.get("BIN-D", {}).get("score")==4, by.get("BIN-D"))
    order = [b["bin"] for b in d["bins"]]
    check("sorted by score desc: BIN-T before BIN-D",
          order.index("BIN-T") < order.index("BIN-D"), order)
    check("clean bin scores 0 and sorts last among these",
          by.get("BIN-K", {}).get("score")==0
          and order.index("BIN-K") > order.index("BIN-D"), order)
    check("untagged bin marked", by.get("BIN-U", {}).get("tagged") is False,
          by.get("BIN-U"))
    check("tagged bins marked", by["BIN-T"]["tagged"] is True, by["BIN-T"])
    check("products inside a bin sort by |diff| desc",
          [p["sku"] for p in by["BIN-T"]["products"]][:2]
          in (["PROD-A","PROD-B"], ["PROD-B","PROD-A"])
          and by["BIN-T"]["products"][-1]["sku"]=="PROD-C",
          [p["sku"] for p in by["BIN-T"]["products"]])
    orphan = next((b for b in d["bins"] if "not in the bin map" in b["bin"]),
                  None)
    check("orphan tags surface in their own group",
          orphan is not None and orphan["score"]==2
          and orphan["products"][0]["on_hand"] is None, orphan)
    check("meta: age + counts present",
          "onhand_age_minutes" in d and d["tagged_bin_count"] >= 3, d.keys())
    check("mismatched_count per bin", by["BIN-T"]["mismatched_count"]==2,
          by["BIN-T"])
    # The E6-1 lesson: stray/desk tags never make a bin "done".
    check("completed batch marks the bin batch_done",
          by["BIN-T"]["batch_done"] is True and by["BIN-K"]["batch_done"] is True,
          (by["BIN-T"].get("batch_done"), by["BIN-K"].get("batch_done")))
    check("stray tags alone do NOT mark a bin batch_done (E6-1 case)",
          by["BIN-D"]["batch_done"] is False and by["BIN-D"]["tagged"] is True,
          by["BIN-D"])
    check("a side trip does not mark its target bin done",
          by["BIN-U"]["batch_done"] is False, by["BIN-U"])
    check("done_bin_count counts only completed batches",
          d["done_bin_count"]==2, d["done_bin_count"])
    check("tagged_products counted per bin",
          by["BIN-D"]["tagged_products"]==1, by["BIN-D"])

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
