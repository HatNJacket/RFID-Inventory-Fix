"""New behaviors: ask-first bin flags, bin updates that move the LOCAL
records too, and side trips that chain (a trip started from inside a
trip finds its way home)."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_flagtrip_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

def prod(v, sku, title, bin_, bc):
    return {"shopify_variant_id":v,"shopify_product_id":"gid://p/"+v,
            "product_title":title,"variant_title":None,"sku":sku,
            "barcode":bc,"bin_location":bin_}
HOME = prod("t:1","HOME-1","Telescope Cap","D2-2","111")
STRAY1 = prod("t:2","EFW-MASK","ZWO EFW Mask","F2-2","222")
STRAY2 = prod("t:3","DEEP-1","Deep Stray","G1-1","333")
CAT = {p["barcode"]: p for p in (HOME,STRAY1,STRAY2)}
def look(t):
    p = CAT.get(t) or next((x for x in CAT.values() if x["sku"]==t), None)
    return dict(p) if p else None
ROWS=[{"shopify_variant_id":p["shopify_variant_id"],"shopify_product_id":p["shopify_product_id"],
       "product_title":p["product_title"],"variant_title":None,"sku":p["sku"],
       "barcode":p["barcode"],"bin":p["bin_location"],"qty":1,
       "image_url":None,"vendor":"X"} for p in (HOME,STRAY1,STRAY2)]
# EFW-MASK also has an old split row in the map - a bin move must collapse it.
ROWS.append(dict(ROWS[1], bin="E6-1"))

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}), \
     patch("app.shopify.set_variant_bin", return_value=None), \
     patch("app.shopify.product_bin_info",
           return_value={"variant_count":1,"easy_bin":None}), \
     patch("app.shopify.set_product_bin", return_value=None):
  with TestClient(app) as cl:
    # ---- ask-first flags ----------------------------------------------
    r = cl.put("/api/bins/D2-2/flagged",
               json={"flagged": True, "note": "consignment mix",
                     "flagged_by": "Steve"})
    check("flagging a bin works", r.status_code==200, r.text[:200])
    ov = cl.get("/api/bins/overview").json()
    row = next((b for b in ov["todo"] if b["bin"]=="D2-2"), None)
    check("overview marks the bin flagged",
          row is not None and row["flagged"] is True, row)
    check("the note rides along", row and row["flag_note"]=="consignment mix", row)
    check("flagged_count counts it", ov["flagged_count"]>=1, ov["flagged_count"])
    r = cl.put("/api/bins/D2-2/flagged", json={"flagged": False})
    ov = cl.get("/api/bins/overview").json()
    row = next((b for b in ov["todo"] if b["bin"]=="D2-2"), None)
    check("unflagging clears it", row is not None and not row["flagged"], row)

    # ---- bin update moves the LOCAL records too ------------------------
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import RfidAssignment, BinMapEntry
    with S(get_engine()) as s:
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000AA",
                             shopify_variant_id="t:2",
                             product_title="ZWO EFW Mask", sku="EFW-MASK",
                             bin_location="F2-2"))
        s.commit()
    r = cl.post("/api/bin-updates",
                json={"target":"EFW-MASK","bin":"F9-9","changed_by":"test"})
    check("bin update accepted", r.status_code==201, r.text[:200])
    with S(get_engine()) as s:
        maps = [m for m in s.query(BinMapEntry).all()
                if (m.sku or "").upper()=="EFW-MASK"]
        tags = [t for t in s.query(RfidAssignment).all()
                if (t.sku or "").upper()=="EFW-MASK"]
    check("bin map collapsed to ONE row with the new bin",
          len(maps)==1 and maps[0].bin=="F9-9",
          [(m.bin) for m in maps])
    check("tag on file moved with it",
          tags and all(t.bin_location=="F9-9" for t in tags),
          [(t.bin_location) for t in tags])

    # ---- side trip from inside a side trip ------------------------------
    bid = cl.post("/api/batches", json={"bin":"D2-2","created_by":"Steve"}).json()["id"]
    cl.post(f"/api/batches/{bid}/scan", json={"code":"111"})
    cl.post(f"/api/batches/{bid}/scan", json={"code":"222"})  # F2-2 stray... wait, EFW now F9-9
    cl.post(f"/api/batches/{bid}/scan", json={"code":"333"})  # G1-1 stray
    r = cl.post(f"/api/batches/{bid}/divert", json={"bin":"G1-1"})
    check("first trip starts", r.status_code==201, r.text[:200])
    child = r.json()["batch"]
    check("child points at its parent", child["parent_batch_id"]==bid, child)
    # Inside the child, a stray for yet another bin (scan one there).
    # EFW-MASK's bin was moved to F9-9 above, and lookups now answer from
    # the LIVE bin map rather than the dead mirror — so the scanned row
    # records F9-9, not the mock's stale F2-2. Divert to what it says.
    cl.post(f"/api/batches/{child['id']}/scan", json={"code":"222"})
    r = cl.post(f"/api/batches/{child['id']}/divert", json={"bin":"F9-9"})
    check("trip from inside a trip is allowed", r.status_code==201, r.text[:200])
    grand = r.json()["batch"]
    check("grandchild chains to the child",
          grand["parent_batch_id"]==child["id"], grand)
    r = cl.post(f"/api/batches/{grand['id']}/close-divert", json={})
    back = r.json()["parent"]
    check("closing the inner trip returns the CHILD, with its own parent "
          "still set", back["id"]==child["id"]
          and back["parent_batch_id"]==bid, back)
    r = cl.post(f"/api/batches/{child['id']}/close-divert", json={})
    back = r.json()["parent"]
    check("closing the child returns the original batch",
          back["id"]==bid and back["parent_batch_id"] is None, back)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
