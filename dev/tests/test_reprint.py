"""Fix-and-reprint at the Pair step (the ZWO USB2.0 Type-C 2Pack case):
bad labels voided, ties released only after the operator confirms the old
stickers are off, fresh labels pick up the corrected store-wide name, and
the tracker reads 0/N - never old-plus-new."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_reprint_test.db")
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
     "product_title":"ZWO USB2.0 Type-C 2Pack","variant_title":None,
     "sku":"ZWO-USB2","barcode":"777","bin_location":"A1-1"}
def look(t):
    return dict(P) if t in ("777","ZWO-USB2") else None
ROWS=[{"shopify_variant_id":P["shopify_variant_id"],"shopify_product_id":P["shopify_product_id"],
       "product_title":P["product_title"],"variant_title":None,"sku":P["sku"],
       "barcode":P["barcode"],"bin":"A1-1","qty":4,"image_url":None,"vendor":"ZWO"}]

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=4), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    bid = cl.post("/api/batches", json={"bin":"A1-1","created_by":"Steve"}).json()["id"]
    for _ in range(4):
        cl.post(f"/api/batches/{bid}/scan", json={"code":"777"})
    # The wrong preferred name that caused the mess: set on the SKU line.
    cl.put("/api/label-names/ZWO-USB2",
           json={"label_name":"ZWO USB2.0 Type-C 2Pack","placement":"sku"})
    r = cl.post(f"/api/batches/{bid}/queue-labels", json={})
    check("4 labels queued", r.json()["count"]==4, r.json())
    items = cl.get(f"/api/batches/{bid}").json()["items"]
    it = items[0]
    check("tracker shows 4 printed", it["printed_count"]==4, it)

    # Pair two tags to the (bad) labels.
    for epc in ("AAAA0000000000000000000A","AAAA0000000000000000000B"):
        cl.post(f"/api/batches/{bid}/pair",
                json={"epc":epc,"item_id":it["id"]})
    it = cl.get(f"/api/batches/{bid}").json()["items"][0]
    check("2 paired", it["paired_count"]==2, it)

    # Without confirming the old stickers are off -> refused.
    r = cl.post(f"/api/batches/{bid}/items/{it['id']}/reprint-labels",
                json={"count":4,"top_text":"ZWO USB2.0 Type-C 2Pack",
                      "sku_line":"ZWO-USB2"})
    check("refused until old stickers confirmed off", r.status_code==409,
          r.status_code)

    # Confirmed: the custom name goes on the TOP line, SKU line back to
    # default -> saved as placement 'header'.
    r = cl.post(f"/api/batches/{bid}/items/{it['id']}/reprint-labels",
                json={"count":4,"top_text":"ZWO USB2.0 Type-C 2Pack",
                      "sku_line":"ZWO-USB2","old_stickers_removed":True,
                      "created_by":"Steve"})
    d = r.json()
    check("reprint accepted", r.status_code==200, r.text[:300])
    check("4 fresh labels queued", d.get("queued")==4, d)
    check("4 old labels voided", d.get("voided")==4, d)
    check("2 ties released", d.get("ties_released")==2, d)
    it = cl.get(f"/api/batches/{bid}").json()["items"][0]
    check("tracker back to 0 paired", it["paired_count"]==0, it)
    check("tracker denominator stays 4, not 8", it["printed_count"]==4, it)

    # The tag ties are really gone, and the saved name is fixed store-wide.
    tags = cl.get("/api/products/tags?sku=ZWO-USB2").json()
    check("no tags left on file", tags["count"]==0, tags)
    nm = cl.get("/api/label-names/ZWO-USB2").json()
    check("saved name now replaces the header line",
          nm["placement"]=="header"
          and nm["label_name"]=="ZWO USB2.0 Type-C 2Pack", nm)

    # The fresh jobs carry the corrected name/placement.
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import PrintJob
    with S(get_engine()) as s:
        pend = [j for j in s.query(PrintJob).all() if j.status=="pending"]
        old = [j for j in s.query(PrintJob).all()
               if j.status in ("voided","canceled")]
    check("4 pending fresh jobs", len(pend)==4, len(pend))
    check("fresh jobs wear the corrected placement",
          all(j.label_placement=="header" for j in pend),
          [(j.label_placement) for j in pend])
    check("old jobs voided/canceled, EPCs retired",
          len(old)==4, len(old))

    # Paired=0 case (Steve's actual 0/4): no confirmation needed.
    r = cl.post(f"/api/batches/{bid}/items/{it['id']}/reprint-labels",
                json={"count":4,"top_text":"ZWO USB2.0 Type-C 2Pack",
                      "sku_line":"ZWO-USB2"})
    check("with nothing paired, no confirmation required",
          r.status_code==200, r.status_code)
    it = cl.get(f"/api/batches/{bid}").json()["items"][0]
    check("still 0/4 after second reprint", it["printed_count"]==4
          and it["paired_count"]==0, it)

    # BOTH lines custom with DIFFERENT text: needs the sku_text column and
    # the jobs must carry label_sku for the print agent.
    r = cl.post(f"/api/batches/{bid}/items/{it['id']}/reprint-labels",
                json={"count":2,"top_text":"ZWO USB Cables",
                      "sku_line":"USB-C x2"})
    check("both-lines-different accepted", r.status_code==200, r.text[:200])
    nm = cl.get("/api/label-names/ZWO-USB2").json()
    check("saved: top on header, centre in sku_text",
          nm["label_name"]=="ZWO USB Cables" and nm["placement"]=="header"
          and nm["sku_text"]=="USB-C x2", nm)
    with S(get_engine()) as s:
        pend2 = [j for j in s.query(PrintJob).all() if j.status=="pending"]
    check("fresh jobs carry label_sku for the agent",
          len(pend2)==2 and all(j.label_sku=="USB-C x2" for j in pend2),
          [(j.label_sku, j.label_name) for j in pend2])
    check("tracker now 0/2 after a smaller reprint",
          cl.get(f"/api/batches/{bid}").json()["items"][0]["printed_count"]==2,
          None)

    # Reset both boxes to their defaults -> the saved name clears entirely.
    r = cl.post(f"/api/batches/{bid}/items/{it['id']}/reprint-labels",
                json={"count":4,"top_text":"Telescopes Canada",
                      "sku_line":"ZWO-USB2"})
    check("defaults accepted", r.status_code==200, r.text[:200])
    nm = cl.get("/api/label-names/ZWO-USB2").json()
    check("saved name cleared back to the standard label",
          nm["label_name"] is None, nm)
    with S(get_engine()) as s:
        pend3 = [j for j in s.query(PrintJob).all() if j.status=="pending"]
    check("standard jobs carry no custom fields",
          len(pend3)==4 and all(j.label_sku is None and j.label_name is None
                                for j in pend3),
          [(j.label_sku, j.label_name) for j in pend3])

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
