"""Already-tagged flow (prior_tags + per-item tagged-before) and side
trips no longer masquerading as finished bins (overview + history)."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_priortag_test.db")
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
STRAY = prod("t:3","DEEP-1","Deep Stray","G1-1","333")
CAT = {p["barcode"]: p for p in (HOME,STRAY)}
def look(t):
    p = CAT.get(t) or next((x for x in CAT.values() if x["sku"]==t), None)
    return dict(p) if p else None
ROWS=[{"shopify_variant_id":p["shopify_variant_id"],
       "shopify_product_id":p["shopify_product_id"],
       "product_title":p["product_title"],"variant_title":None,
       "sku":p["sku"],"barcode":p["barcode"],"bin":p["bin_location"],
       "qty":4,"image_url":None,"vendor":"X"} for p in (HOME,STRAY)]

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import RfidAssignment

    # Two tags already on file for HOME-1 from an earlier session (one in
    # lower-case sku to pin the CI match), none of them from any batch.
    with S(get_engine()) as s:
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000A1",
                             shopify_variant_id="t:1",
                             product_title="Telescope Cap", sku="HOME-1",
                             bin_location="D2-2"))
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000A2",
                             shopify_variant_id="t:1",
                             product_title="Telescope Cap", sku="home-1",
                             bin_location="F9-9"))
        s.commit()

    bid = cl.post("/api/batches",
                  json={"bin":"D2-2","created_by":"Steve"}).json()["id"]
    # A tag paired IN this batch must not count as "prior".
    with S(get_engine()) as s:
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000A3",
                             shopify_variant_id="t:1",
                             product_title="Telescope Cap", sku="HOME-1",
                             bin_location="D2-2", batch_id=bid))
        s.commit()

    items = cl.get(f"/api/batches/{bid}").json()["items"]
    home = next(i for i in items if i["sku"]=="HOME-1")
    check("prior_tags counts earlier tags case-insensitively, not this "
          "batch's own", home["prior_tags"]==2, home)

    # ---- the per-product already-tagged answer --------------------------
    for _ in range(3):
        cl.post(f"/api/batches/{bid}/scan", json={"code":"111"})
    r = cl.put(f"/api/batches/{bid}/items/{home['id']}/tagged-before",
               json={"count":2,"updated_by":"Steve"})
    check("tagged-before accepted while collecting", r.status_code==200,
          r.text[:200])
    it = r.json()["item"]
    check("tagged boxes count as units but never as labels",
          it["tagged_before"]==2 and it["units_total"]==5
          and it["labels_total"]==3, it)
    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"]=="already-tagged-set"]
    check("the answer is logged in History",
          len(ev)==1 and ev[0]["sku"]=="HOME-1", ev[:2])

    r = cl.post(f"/api/batches/{bid}/queue-labels",
                json={"requested_by":"Steve"})
    check("labels queue only for the un-stickered boxes",
          r.status_code==201 and r.json()["count"]==3, r.text[:200])
    # Guard relaxed 2026-08-06: verify-time resolution corrects this count
    # after labels exist, so only a CLOSED batch refuses.
    r = cl.put(f"/api/batches/{bid}/items/{home['id']}/tagged-before",
               json={"count":1})
    check("tagged-before allowed after labels queue (verify-time fix)",
          r.status_code==200, r.status_code)
    cl.put(f"/api/batches/{bid}/items/{home['id']}/tagged-before",
           json={"count":2})
    rev = cl.get(f"/api/batches/{bid}/review").json()
    hentry = next((e for e in rev["items"]
                   if e["item"]["sku"]=="HOME-1"), None)
    check("scans + already-tagged together raise the double-count flag",
          hentry is not None and "double-count" in hentry["flags"], hentry)

    # A stray scanned mid-batch gets prior_tags on its scan response too.
    with S(get_engine()) as s:
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000A4",
                             shopify_variant_id="t:3",
                             product_title="Deep Stray", sku="DEEP-1",
                             bin_location="G1-1"))
        s.commit()
    bid2 = cl.post("/api/batches",
                   json={"bin":"D2-2","created_by":"Steve"}).json()["id"]
    r = cl.post(f"/api/batches/{bid2}/scan", json={"code":"333"})
    check("scan response carries prior_tags for a mid-batch stray",
          r.json()["item"]["prior_tags"]==1, r.json()["item"])

    # The Check step tells the keep-or-move dialog how many tagged boxes
    # are already RECORDED at the stray's home shelf.
    rev = cl.get(f"/api/batches/{bid2}/review").json()
    stray = next((e for e in rev["items"]
                  if e["item"]["sku"]=="DEEP-1"), None)
    check("wrong-bin stray carries record_bin_tags for its home shelf",
          stray is not None and "wrong-bin" in stray["flags"]
          and stray.get("record_bin_tags")==1, stray)

    # ---- bin_check: tags_here vs tags_on_file ---------------------------
    r = cl.post("/api/bins/G1-1/check", json={"epcs":[]}).json()
    row = next(i for i in r["items"] if i["sku"]=="DEEP-1")
    check("bin check separates this-bin tags from store-wide",
          row["tags_on_file"]==1 and row["tags_here"]==1, row)
    r = cl.post("/api/bins/F9-9/check", json={"epcs":[]}).json()
    check("a bin with no mapped products stays empty", r["count"]==0, r)

    # ---- bin_check reports requested SKUs the map doesn't put here ------
    # (the F9198F-OPEN-BOX / F9384A bug: paired in this bin, mapped to
    # another bin or to none, C72 popup read "seen 0 of 0")
    with S(get_engine()) as s:
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000A5",
                             shopify_variant_id="t:9",
                             product_title="Open Box Twin",
                             sku="HOME-1 - OPEN BOX",
                             bin_location="D2-2"))
        s.commit()
    r = cl.post("/api/bins/D2-2/check",
                json={"epcs":["AAAA000000000000000000A5"],
                      "skus":["home-1 - open box","HOME-1"]}).json()
    row = next((i for i in r["items"]
                if (i["sku"] or "").upper()=="HOME-1 - OPEN BOX"), None)
    check("unmapped batch SKU gets a real row (CI-matched)",
          row is not None and row["tags_here"]==1 and row["detected"]==1
          and row["in_bin_map"] is False
          and row["product_title"]=="Open Box Twin", row)
    home_row = next(i for i in r["items"] if i["sku"]=="HOME-1")
    check("mapped SKUs are not duplicated by the request",
          sum(1 for i in r["items"]
              if (i["sku"] or "").upper()=="HOME-1")==1
          and home_row["in_bin_map"] is True, r["items"])

    # ---- verify: already-tagged boxes are an exception, not a miss ------
    # A second earlier tag, so a PARTIAL detection (between X and X+Y)
    # exists to test — Nick's rule: accept X or X+Y, flag in between.
    with S(get_engine()) as s:
        s.add(RfidAssignment(rfid_id="AAAA000000000000000000A6",
                             shopify_variant_id="t:3",
                             product_title="Deep Stray", sku="DEEP-1",
                             bin_location="G1-1"))
        s.commit()
    bidv = cl.post("/api/batches",
                   json={"bin":"G1-1","created_by":"Steve"}).json()["id"]
    itv = next(i for i in cl.get(f"/api/batches/{bidv}").json()["items"]
               if i["sku"]=="DEEP-1")
    cl.put(f"/api/batches/{bidv}/items/{itv['id']}/tagged-before",
           json={"count":2,"updated_by":"Steve"})
    rep = cl.post(f"/api/batches/{bidv}/verify",
                  json={"epcs":["AAAA000000000000000000A4",
                                "AAAA000000000000000000A6"]}).json()
    row = next(i for i in rep["items"] if i["sku"]=="DEEP-1")
    check("verify row carries tagged_before and counts the tags detected",
          row["tagged_before"]==2 and row["detected"]==2
          and row["qty_scanned"]==0 and row["paired_count"]==0, row)
    check("verify row says where the detected tags' records point",
          row.get("detected_bins")==[{"bin":"G1-1","count":2}]
          and "image_url" in row, row)
    check("hearing pairs + ALL already-tagged (X+Y) = verify ok",
          rep["ok"] is True, rep)
    rep = cl.post(f"/api/batches/{bidv}/verify",
                  json={"epcs":["AAAA000000000000000000A4"]}).json()
    check("hearing only PART of the already-tagged bundle = flagged",
          rep["ok"] is False, rep)
    rep = cl.post(f"/api/batches/{bidv}/verify", json={"epcs":[]}).json()
    check("hearing only this batch's own pairs (X, none of the earlier "
          "tags) = accepted", rep["ok"] is True, rep)
    # Abandoned, not completed: a done batch on G1-1 would break the
    # side-trip assertions below, which need that bin still to-do.
    cl.post(f"/api/batches/{bidv}/abandon", json={"remove_ties": False})
    r = cl.put(f"/api/batches/{bidv}/items/{itv['id']}/tagged-before",
               json={"count":3})
    check("tagged-before refused on a closed batch",
          r.status_code==409, r.status_code)

    # ---- side trips are not finished bins --------------------------------
    cl.post(f"/api/batches/{bid2}/scan", json={"code":"111"})
    r = cl.post(f"/api/batches/{bid2}/divert", json={"bin":"G1-1"})
    trip = r.json()["batch"]
    check("side trip created", r.status_code==201
          and trip["parent_batch_id"]==bid2, r.text[:300])
    ov = cl.get("/api/bins/overview").json()
    row = next((b for b in ov["todo"] if b["bin"]=="G1-1"), None)
    check("an OPEN side trip is not offered as the bin's continue-batch",
          row is not None and row["open_batch_id"] is None, row)
    r = cl.post(f"/api/batches/{trip['id']}/close-divert", json={})
    check("side trip closed", r.status_code==200, r.text[:200])
    cl.post(f"/api/batches/{bid2}/complete", json={"finalize":True})

    ov = cl.get("/api/bins/overview").json()
    bins_todo = [b["bin"] for b in ov["todo"]]
    check("the side trip's bin is still to-do", "G1-1" in bins_todo,
          bins_todo)
    check("the parent's bin counts as done", "D2-2" not in bins_todo
          and ov["done_bins"]==1, (bins_todo, ov["done_bins"]))
    rec = {r_["batch_id"]: r_ for r_ in ov["recent"]}
    check("recently-done labels the side trip",
          rec[trip["id"]]["side_trip"] is True
          and rec[bid2]["side_trip"] is False, ov["recent"])

    evs = cl.get("/api/history").json()["events"]
    types_for_trip = {e["type"] for e in evs
                      if f"#{trip['id']}" in (e.get("detail") or "")
                      and e["title"]=="Bin G1-1"}
    check("history calls the trip a side trip, not a batch",
          "side-trip-started" in types_for_trip
          and "side-trip-completed" in types_for_trip
          and not any(t.startswith("batch-") for t in types_for_trip),
          types_for_trip)
    check("side trip detail names its parent",
          any(f"(from batch #{bid2})" in (e.get("detail") or "")
              for e in evs if e["type"]=="side-trip-completed"), None)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
