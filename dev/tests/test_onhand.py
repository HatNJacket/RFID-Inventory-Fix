"""On-hand correction from the Verify step: increase-only, confirmed,
feature-gated, logged with a two-phase undo in History."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ["SHOPIFY_WRITE_MODE"]="scan_station_only,verify_onhand"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_onhand_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
from app import config
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

P = {"shopify_variant_id":"t:1","shopify_product_id":"gid://p/1",
     "product_title":"ZWO Filter Drawer","variant_title":None,
     "sku":"ZWO-X","barcode":"555","bin_location":"Z1-1"}
def look(t):
    return dict(P) if t in ("555","ZWO-X") else None
ROWS=[{"shopify_variant_id":"t:1","shopify_product_id":"gid://p/1",
       "product_title":P["product_title"],"variant_title":None,
       "sku":"ZWO-X","barcode":"555","bin":"Z1-1","qty":3,
       "image_url":None,"vendor":"ZWO"}]
STATE = {"ZWO-X": 3}
def fake_get(sku): return STATE.get(sku)
def fake_set(sku, qty):
    before = STATE.get(sku, 0); STATE[sku] = qty; return before

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", side_effect=fake_get), \
     patch("app.shopify.set_on_hand", side_effect=fake_set), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    bid = cl.post("/api/batches", json={"bin":"Z1-1","created_by":"Steve"}).json()["id"]
    for _ in range(5):
        cl.post(f"/api/batches/{bid}/scan", json={"code":"555"})
    it = cl.get(f"/api/batches/{bid}").json()["items"][0]
    check("setup: 5 found vs 3 expected", it["qty_scanned"]==5
          and it["expected_qty"]==3, it)

    # Gate: feature must be enabled by name.
    saved = config.SHOPIFY_WRITE_MODE
    config.SHOPIFY_WRITE_MODE = "scan_station_only"
    r = cl.post("/api/onhand-updates",
                json={"sku":"ZWO-X","new_qty":5,"confirmed":True})
    check("blocked when verify_onhand not in the mode", r.status_code==403,
          r.status_code)
    config.SHOPIFY_WRITE_MODE = saved

    # Confirmation required.
    r = cl.post("/api/onhand-updates", json={"sku":"ZWO-X","new_qty":5})
    check("unconfirmed refused", r.status_code==409, r.status_code)
    # Increase-only.
    r = cl.post("/api/onhand-updates",
                json={"sku":"ZWO-X","new_qty":2,"confirmed":True})
    check("lowering refused", r.status_code==422, r.status_code)
    r = cl.post("/api/onhand-updates",
                json={"sku":"ZWO-X","new_qty":3,"confirmed":True})
    check("equal refused too", r.status_code==422, r.status_code)

    # The real thing.
    r = cl.post("/api/onhand-updates",
                json={"sku":"ZWO-X","new_qty":5,"confirmed":True,
                      "changed_by":"Steve","batch_id":bid,
                      "item_id":it["id"]})
    d = r.json()
    check("increase accepted", r.status_code==201, r.text[:200])
    check("write hit the (fake) store", STATE["ZWO-X"]==5, STATE)
    check("before/after reported", d["before"]==3 and d["after"]==5, d)
    it2 = cl.get(f"/api/batches/{bid}").json()["items"][0]
    check("batch item's expected snapshot updated",
          it2["expected_qty"]==5, it2)

    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"]=="on-hand-updated"]
    check("logged in History with undo payload",
          len(ev)==1 and ev[0]["undo"]["kind"]=="on-hand"
          and ev[0]["detail"]=="3 → 5", ev)

    # Undo: two-phase. Unconfirmed answers with the exact consequence.
    cid = d["change_id"]
    r = cl.post(f"/api/onhand-updates/{cid}/undo", json={})
    check("undo asks for confirmation with the numbers",
          r.status_code==409 and "back to 3" in r.json()["detail"]
          and "Confirm to write it" in r.json()["detail"], r.text[:300])
    r = cl.post(f"/api/onhand-updates/{cid}/undo",
                json={"confirmed":True,"changed_by":"Steve"})
    check("undo writes the old number back", r.status_code==200
          and STATE["ZWO-X"]==3, (r.status_code, STATE))
    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"]=="on-hand-undone"]
    check("the undo is itself logged", len(ev)==1
          and ev[0]["detail"]=="5 → 3", ev)
    # A drifted value gets called out in the confirm text.
    STATE["ZWO-X"] = 9
    r = cl.post(f"/api/onhand-updates/{cid}/undo", json={})
    check("undo warns when the number moved since",
          r.status_code==409 and "something else changed it" in
          r.json()["detail"], r.text[:300])

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
