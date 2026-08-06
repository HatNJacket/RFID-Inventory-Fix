"""Won't-RFID-scan flag: set/unset with logging, annotations everywhere the
clients look, verify/baseline stop crying wolf, and the two-box PUT on
label-names."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_norfid_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

P = {"shopify_variant_id":"t:1","shopify_product_id":"gid://p/1",
     "product_title":"ZWO Desiccant Tube","variant_title":None,
     "sku":"ZWO-Desicc","barcode":"888","bin_location":"D4-1"}
def look(t):
    return dict(P) if t in ("888","ZWO-Desicc") else None
ROWS=[{"shopify_variant_id":"t:1","shopify_product_id":"gid://p/1",
       "product_title":P["product_title"],"variant_title":None,
       "sku":P["sku"],"barcode":"888","bin":"D4-1","qty":2,
       "image_url":None,"vendor":"ZWO"}]

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=2), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    # ---- flag on, logged --------------------------------------------------
    r = cl.put("/api/products/ZWO-Desicc/rfid-incompatible",
               json={"incompatible": True, "changed_by": "Steve"})
    check("flag set", r.status_code==200 and r.json()["rfid_incompatible"],
          r.text[:200])
    g = cl.get("/api/products/ZWO-Desicc/rfid-incompatible").json()
    check("flag reads back with who", g["rfid_incompatible"]
          and g["set_by"]=="Steve", g)
    ph = cl.get("/api/product-history?term=ZWO-Desicc").json()
    ev = [e for e in ph["events"] if e["type"]=="rfid-flag-changed"]
    check("flip logged in the product's history",
          len(ev)==1 and ev[0]["shopify"] is False, ev)
    check("panel payload carries the flag", ph["rfid_incompatible"] is True,
          ph.get("rfid_incompatible"))

    # ---- annotations ------------------------------------------------------
    bid = cl.post("/api/batches", json={"bin":"D4-1","created_by":"Steve"}).json()["id"]
    sc = cl.post(f"/api/batches/{bid}/scan", json={"code":"888"}).json()
    check("scan response carries the flag",
          sc["item"]["rfid_incompatible"] is True, sc["item"])
    cl.post(f"/api/batches/{bid}/scan", json={"code":"888"})
    items = cl.get(f"/api/batches/{bid}").json()["items"]
    it = items[0]
    check("batch items carry the flag", it["rfid_incompatible"] is True, it)
    tags = cl.get("/api/products/tags?sku=ZWO-Desicc").json()
    check("tags endpoint piggybacks the flag",
          tags["rfid_incompatible"] is True, tags)

    # ---- verify: paired but silent = fine ----------------------------------
    cl.post(f"/api/batches/{bid}/queue-labels", json={})
    for epc in ("DDDD0000000000000000000D","DDDD0000000000000000000E"):
        cl.post(f"/api/batches/{bid}/pair", json={"epc":epc,"item_id":it["id"]})
    v = cl.post(f"/api/batches/{bid}/verify", json={"epcs":[]}).json()
    row = v["items"][0]
    check("verify row carries the flag", row["rfid_incompatible"] is True, row)
    check("verify OK despite 0 detected on a flagged product",
          v["ok"] is True, v)
    check("verify rows carry expected/units/product-id for the web table",
          row.get("expected_qty")==2 and row.get("units_total")==2
          and "shopify_product_id" in row, row)
    bc = cl.post("/api/bins/D4-1/check", json={"epcs":[]}).json()
    check("bin check rows carry the flag",
          all(x["rfid_incompatible"] for x in bc["items"]
              if x["sku"]=="ZWO-Desicc"), bc["items"])
    inv = cl.get("/api/inventory/summary").json()
    prow = next((p for p in inv["products"] if p["sku"]=="ZWO-Desicc"), None)
    check("inventory row carries the flag",
          prow is not None and prow["rfid_incompatible"] is True, prow)

    # ---- baseline: silence is EXPECTED, no tagged-not-detected -------------
    bid2 = cl.post("/api/batches", json={"bin":"D4-1"}).json()["id"]
    r = cl.post(f"/api/batches/{bid2}/baseline",
                json={"epcs":["FFFF0000000000000000000F"]})
    check("baseline applies", r.status_code==200, r.text[:200])
    rev = cl.get(f"/api/batches/{bid2}/review").json()
    check("no tagged-not-detected for the flagged product",
          not any("tagged-not-detected" in e["flags"] for e in rev["items"]),
          rev["items"])

    # ---- unflag: everything reverts ----------------------------------------
    cl.put("/api/products/ZWO-Desicc/rfid-incompatible",
           json={"incompatible": False, "changed_by": "Steve"})
    rev = cl.get(f"/api/batches/{bid2}/review").json()
    check("unflagged product IS flagged tagged-not-detected again",
          any("tagged-not-detected" in e["flags"] for e in rev["items"]),
          rev["items"])
    v = cl.post(f"/api/batches/{bid}/verify", json={"epcs":[]}).json()
    check("verify complains again once unflagged", v["ok"] is False, v["ok"])
    ph = cl.get("/api/product-history?term=ZWO-Desicc").json()
    ev = [e for e in ph["events"] if e["type"]=="rfid-flag-changed"]
    check("both flips logged", len(ev)==2, len(ev))

    # ---- two-box PUT on label-names ----------------------------------------
    r = cl.put("/api/label-names/ZWO-Desicc",
               json={"top_text":"ZWO Desiccant","sku_line":"DRY TUBE",
                     "updated_by":"Steve"})
    d = r.json()
    check("two-box PUT saves both lines",
          d["label_name"]=="ZWO Desiccant" and d["placement"]=="header"
          and d["sku_text"]=="DRY TUBE", d)
    r = cl.put("/api/label-names/ZWO-Desicc",
               json={"top_text":"Telescopes Canada","sku_line":"ZWO-Desicc"})
    check("two-box PUT at defaults clears the saved name",
          r.json()["label_name"] is None, r.json())
    # Legacy single-text PUT still works (the C72 uses it).
    r = cl.put("/api/label-names/ZWO-Desicc",
               json={"label_name":"Dry Tube","placement":"sku"})
    check("legacy PUT still works", r.json()["label_name"]=="Dry Tube",
          r.json())

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
