"""SKU-case drift (the ZWO Anti-Dew twins): the dead mirror hands back
'ZWO Anti-dew' while the live catalog says 'ZWO Anti-Dew'. Same-SKU-
different-case is the SAME product: the live casing wins at resolution,
scans land on the existing row instead of splitting it, and candidate
lists never show the pair as two products."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_skucase_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

BC = "6977641321150"
LIVE_SKU = "ZWO Anti-Dew"
STALE_SKU = "ZWO Anti-dew"
TITLE = "ZWO Cooled Camera Anti-Dew Heater Strip"

def mirror_product():
    # What the dead TELCAN mirror claims: stale casing, no bin.
    return {"shopify_variant_id":"handle:zwo-anti-dew","shopify_product_id":None,
            "product_title":TITLE,"variant_title":None,"sku":STALE_SKU,
            "barcode":BC,"bin_location":"No bin assigned","source":"telcan"}

def live_product():
    return {"shopify_variant_id":"gid:1","shopify_product_id":"gid:p1",
            "product_title":TITLE,"variant_title":None,"sku":LIVE_SKU,
            "barcode":BC,"bin_location":"F2-2"}

ROWS=[{"shopify_variant_id":"gid:1","shopify_product_id":"gid:p1",
       "product_title":TITLE,"variant_title":None,"sku":LIVE_SKU,
       "barcode":BC,"bin":"F2-2","qty":3,"image_url":None,"vendor":"ZWO"}]

with patch("app.catalog.lookup_barcode",
           side_effect=lambda s, t: mirror_product() if t == BC else None), \
     patch("app.catalog.lookup_barcode_all",
           side_effect=lambda s, t: [mirror_product()] if t == BC else []), \
     patch("app.shopify.lookup_barcode",
           side_effect=lambda t: live_product() if t == BC else None), \
     patch("app.shopify.lookup_barcode_all",
           side_effect=lambda t: [live_product()] if t == BC else []), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=3), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    # Resolution: the mirror's stale casing is normalized to the live one.
    p = cl.get(f"/api/products/by-barcode/{BC}").json()
    check("single lookup returns the LIVE casing", p.get("sku")==LIVE_SKU, p)

    cands = cl.get(f"/api/products/candidates?barcode={BC}").json()
    check("candidate list holds ONE product, not a case-twin pair",
          cands["count"]==1, cands)
    check("that one candidate wears the live casing",
          cands["candidates"][0]["sku"]==LIVE_SKU, cands["candidates"])

    # Batch flow: scanning must land on the pre-seeded row, not split it.
    bid = cl.post("/api/batches", json={"bin":"F2-2","created_by":"Steve"}).json()["id"]
    for _ in range(3):
        cl.post(f"/api/batches/{bid}/scan", json={"code":BC})
    items = cl.get(f"/api/batches/{bid}").json()["items"]
    ours = [i for i in items if (i["sku"] or "").upper()==LIVE_SKU.upper()]
    check("one row for the product, not two", len(ours)==1,
          [(i["sku"], i["qty_scanned"]) for i in items])
    check("row carries the live casing", ours[0]["sku"]==LIVE_SKU, ours[0])
    check("all 3 boxes on that one row", ours[0]["qty_scanned"]==3, ours[0])

    rev = cl.get(f"/api/batches/{bid}/review").json()
    check("Check step is clean - no ambiguous case-twin",
          rev["count"]==0, rev["items"])

    # Even a pre-existing row with the STALE casing (created before this
    # fix) must catch new scans instead of spawning a live-cased sibling.
    bid2 = cl.post("/api/batches", json={"bin":"F2-2"}).json()["id"]
    items2 = cl.get(f"/api/batches/{bid2}").json()["items"]
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import BatchItem
    with S(get_engine()) as s:
        row = s.get(BatchItem, items2[0]["id"])
        row.sku = STALE_SKU          # simulate a pre-fix row
        s.commit()
    cl.post(f"/api/batches/{bid2}/scan", json={"code":BC})
    items2 = cl.get(f"/api/batches/{bid2}").json()["items"]
    ours2 = [i for i in items2 if (i["sku"] or "").upper()==LIVE_SKU.upper()]
    check("scan lands on the stale-cased row instead of splitting",
          len(ours2)==1 and ours2[0]["qty_scanned"]==1,
          [(i["sku"], i["qty_scanned"]) for i in items2])

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
