"""Bulk scan (web Scan Station): one sweep's EPCs assigned to the loaded
product in a single write, duplicates skipped and named (never stolen),
undo unlinks exactly the sweep's tags — and History folds each sweep into
ONE expandable event ("N × RFID tag" + epcs list) instead of N identical
rows. Single scans keep their own rows.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_bulkscan_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

PROD = {"shopify_variant_id":"gid://v/1","shopify_product_id":"gid://p/1",
        "product_title":"Baader UHC Filter","variant_title":None,
        "sku":"BULK-1","barcode":"111","bin_location":"T1-1"}
A = "AAAA0000000000000000000A"
B = "AAAA0000000000000000000B"
OTHER = "CCCC0000000000000000000C"   # someone else's tag, in sweep range
MINE_OLD = "DDDD0000000000000000000D"  # this product's earlier tag

with patch("app.shopify.lookup_barcode", return_value=None), \
     patch("app.shopify.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.fetch_all_variant_bins", return_value=[]), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    cl.post("/api/rfid-assignments",
            json={**PROD, "rfid_id": MINE_OLD, "assigned_by": "Nick"})
    cl.post("/api/rfid-assignments",
            json={"rfid_id": OTHER, "shopify_variant_id": "gid://v/9",
                  "product_title": "Someone Else", "sku": "OTHER-9",
                  "assigned_by": "Nick"})

    # ---- the sweep -----------------------------------------------------
    r = cl.post("/api/rfid-assignments/sweep",
                json={**PROD, "assigned_by": "Nick",
                      "epcs": [A, B, A, OTHER, MINE_OLD]})
    check("sweep assigns only the NEW tags (input de-duped)",
          r.status_code == 201 and r.json()["count"] == 2, r.text)
    dups = {d["epc"]: d for d in r.json()["duplicates"]}
    check("a neighbour's tag is skipped and NAMED, never stolen",
          dups[OTHER]["sku"] == "OTHER-9" and dups[OTHER]["own"] is False,
          dups)
    check("this product's own earlier tag is skipped as OWN",
          dups[MINE_OLD]["own"] is True, dups)
    got = {a["rfid_id"] for a in r.json()["assigned"]}
    check("assigned list is exactly the new pair", got == {A, B}, got)
    stamps = {a["assigned_at"] for a in r.json()["assigned"]}
    check("the sweep's rows share ONE timestamp", len(stamps) == 1, stamps)

    # ---- History folds the sweep ---------------------------------------
    hist = cl.get("/api/history").json()["events"]
    sweeps = [e for e in hist if e["type"] == "tag-assigned"
              and e.get("epcs")]
    check("History shows ONE event for the sweep",
          len(sweeps) == 1 and sorted(sweeps[0]["epcs"]) == sorted([A, B]),
          sweeps)
    check("its detail counts tags instead of naming an EPC",
          "2 × RFID tag" in sweeps[0]["detail"], sweeps[0]["detail"])
    singles = [e for e in hist if e["type"] == "tag-assigned"
               and not e.get("epcs")]
    check("single assigns keep their own rows with the EPC",
          len(singles) == 2
          and any(MINE_OLD in e["detail"] for e in singles), singles)

    ph = cl.get("/api/product-history", params={"term": "BULK-1"}).json()
    ph_sweeps = [e for e in ph.get("events", [])
                 if e["type"] == "tag-assigned" and e.get("epcs")]
    check("the product panel folds the sweep too",
          len(ph_sweeps) == 1 and len(ph_sweeps[0]["epcs"]) == 2, ph_sweeps)

    # ---- undo: exactly the sweep, nothing else -------------------------
    r = cl.post("/api/rfid-assignments/sweep/undo",
                json={"epcs": [A, B, OTHER], "sku": "BULK-1",
                      "by": "Nick"})
    check("undo unlinks the sweep's tags", r.json()["count"] == 2, r.text)
    check("the sku guard protects the neighbour's tag",
          r.json()["skipped"] == [OTHER], r.json())
    check("the tags are really gone",
          cl.get(f"/api/rfid-assignments/{A}").status_code == 404
          and cl.get(f"/api/rfid-assignments/{OTHER}").status_code == 200)

    hist = cl.get("/api/history").json()["events"]
    unlinks = [e for e in hist if e["type"] == "tag-unlinked"]
    check("History folds the undo into one expandable event",
          len(unlinks) == 1 and sorted(unlinks[0]["epcs"]) == sorted([A, B])
          and "2 × RFID tag unlinked" in unlinks[0]["detail"], unlinks)

    r = cl.post("/api/rfid-assignments/sweep",
                json={**PROD, "assigned_by": "Nick", "epcs": ["  ", ""]})
    check("a sweep of blanks is refused", r.status_code == 422, r.text)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
