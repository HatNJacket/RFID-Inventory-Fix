"""The D1-1 blind spot: products Shopify expects on the shelf that the walk
never met must surface at Check as 'not-on-shelf' — while scanned-and-
matching rows, zero-expected rows, and scanned-then-zeroed strays stay
quiet."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_notonshelf_test.db")
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
    return {"shopify_variant_id":v,"shopify_product_id":"h:"+v,
            "product_title":title,"variant_title":None,"sku":sku,
            "barcode":bc,"bin_location":bin_}
HERE1 = prod("t:1","C14set","Celestron C14 set","D1-1","111")   # scanned, matches
HERE2 = prod("t:2","C11met","Celestron C11 metal","D1-1","222") # never scanned, exp 2
HERE3 = prod("t:3","CNspr","Counterweight spring","D1-1","333") # never scanned, exp 0
AWAY  = prod("t:4","BARLOW","2x Erecting Barlow","E6-1","444")  # foreign, zeroed
CAT = {p["barcode"]: p for p in (HERE1,HERE2,HERE3,AWAY)}
def look(t):
    p = CAT.get(t) or next((x for x in CAT.values() if x["sku"]==t), None)
    return dict(p) if p else None
QTY = {"C14set":1,"C11met":2,"CNspr":0,"BARLOW":6}
ROWS=[{"shopify_variant_id":p["shopify_variant_id"],"shopify_product_id":p["shopify_product_id"],
       "product_title":p["product_title"],"variant_title":None,"sku":p["sku"],
       "barcode":p["barcode"],"bin":p["bin_location"],
       "qty":QTY[p["sku"]],"image_url":None,"vendor":"X"} for p in (HERE1,HERE2,HERE3,AWAY)]

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", side_effect=lambda sku: QTY.get(sku)), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    bid = cl.post("/api/batches", json={"bin":"D1-1","created_by":"Steve"}).json()["id"]
    items = {i["sku"]: i for i in cl.get(f"/api/batches/{bid}").json()["items"]}
    check("D1-1 pre-seeds its three products",
          {"C14set","C11met","CNspr"} <= set(items), set(items))

    # Walk the shelf: only C14set is really there.
    cl.post(f"/api/batches/{bid}/scan", json={"code":"111"})
    # A stray from E6-1 got scanned by mistake, then minused back to 0.
    cl.post(f"/api/batches/{bid}/scan", json={"code":"444"})
    items = {i["sku"]: i for i in cl.get(f"/api/batches/{bid}").json()["items"]}
    cl.post(f"/api/batches/{bid}/items/{items['BARLOW']['id']}/qty", json={"qty":0})

    rev = cl.get(f"/api/batches/{bid}/review").json()
    by = {e["item"]["sku"]: e for e in rev["items"]}
    check("unscanned product with stock expected here IS flagged",
          "C11met" in by and by["C11met"]["flags"]==["not-on-shelf"],
          by.get("C11met", by.keys()))
    check("scanned-and-matching product is NOT flagged", "C14set" not in by, by.keys())
    check("zero-expected product stays quiet", "CNspr" not in by, by.keys())
    check("scanned-then-zeroed stray from another bin stays quiet",
          "BARLOW" not in by, by.keys())

    # The flag clears the moment the product is actually found and scanned.
    cl.post(f"/api/batches/{bid}/scan", json={"code":"222"})
    rev = cl.get(f"/api/batches/{bid}/review").json()
    by = {e["item"]["sku"]: e for e in rev["items"]}
    check("flag drops once the product is scanned (count check takes over)",
          "C11met" not in by or "not-on-shelf" not in by["C11met"]["flags"],
          by.get("C11met"))
    check("scanning 1 of expected 2 now flags the count instead",
          "C11met" in by and "count-mismatch" in by["C11met"]["flags"],
          by.get("C11met"))

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
