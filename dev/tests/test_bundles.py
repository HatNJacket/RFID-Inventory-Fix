"""Bundle contents (the W9184B case): define once what ONE bundle
contains, and (1) batch collect stops listing the bundle as its own
countable product — the component's count covers it, reported as a
covered_bundles note; (2) the could-not-scan resolve context offers the
components; (3) clearing the contents makes the bundle countable again.
Every change leaves a History receipt.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_bundles_test.db")
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
    from app.models import BinMapEntry, ReviewTask

    # A shelf with the component and two bundle listings of it.
    with S(get_engine()) as s:
        s.add(BinMapEntry(sku="W9184B", barcode="1", bin="D4-2", qty=63,
                          product_title="Antlia 3nm filter",
                          shopify_variant_id="t:1"))
        s.add(BinMapEntry(sku="W9184B-B10", barcode="2", bin="D4-2", qty=6,
                          product_title="BUNDLE: Antlia 3nm x10",
                          shopify_variant_id="t:2"))
        s.add(BinMapEntry(sku="W9184B-B5", barcode="3", bin="D4-2", qty=12,
                          product_title="BUNDLE: Antlia 3nm x5",
                          shopify_variant_id="t:3"))
        s.add(ReviewTask(category="could-not-scan", sku="W9184B-B10",
                         product_title="BUNDLE: Antlia 3nm x10",
                         detail="Bin D4-2: skipped during tagging."))
        s.commit()

    # ---- define contents ------------------------------------------------
    r = cl.post("/api/bundle-contents",
                json={"bundle_sku": "W9184B-B10",
                      "contents": [{"component_sku": "W9184B", "qty": 10}],
                      "updated_by": "Nick"})
    check("contents saved with a human-readable message",
          r.status_code == 201
          and "10× W9184B" in r.json()["message"], r.text)
    r = cl.get("/api/bundle-contents?sku=w9184b-b10")
    check("lookup is case-insensitive",
          r.json()["contents"] == [{"component_sku": "W9184B", "qty": 10}],
          r.text)
    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"] == "bundle-contents-set"]
    check("History carries the definition receipt",
          len(ev) == 1 and "10× W9184B" in ev[0]["detail"], ev)
    r = cl.post("/api/bundle-contents",
                json={"bundle_sku": "W9184B-B10",
                      "contents": [{"component_sku": "W9184B", "qty": 0}]})
    check("a zero quantity is refused", r.status_code == 422, r.text)

    # ---- batch collect holds the defined bundle out --------------------
    r = cl.post("/api/batches", json={"bin": "D4-2", "created_by": "Nick"})
    b = r.json()
    seeded = {i["sku"] for i in b["items"]}
    check("the component and the UNDEFINED bundle still seed",
          "W9184B" in seeded and "W9184B-B5" in seeded, seeded)
    check("the DEFINED bundle is held out of the countable list",
          "W9184B-B10" not in seeded, seeded)
    cov = b.get("covered_bundles") or []
    check("…and reported as covered by its components",
          len(cov) == 1 and cov[0]["sku"] == "W9184B-B10"
          and cov[0]["contents"][0]["qty"] == 10, cov)
    cl.post(f"/api/batches/{b['id']}/abandon", json={"remove_ties": False})

    # ---- could-not-scan context offers the components ------------------
    tid = cl.get("/api/review-tasks?status=open").json()["tasks"]
    tid = next(t["id"] for t in tid if t["category"] == "could-not-scan")
    ctx = cl.get(f"/api/review-tasks/{tid}/context").json()
    check("resolve context knows it's a bundle and lists the contents",
          ctx["kind"] == "bundle"
          and ctx["bundle_contents"] == [{"component_sku": "W9184B",
                                          "qty": 10}], ctx)

    # ---- clearing restores countability --------------------------------
    r = cl.post("/api/bundle-contents",
                json={"bundle_sku": "W9184B-B10", "contents": [],
                      "updated_by": "Nick"})
    check("clearing answers with the countable-again message",
          "countable again" in r.json()["message"], r.text)
    r = cl.post("/api/batches", json={"bin": "D4-2", "created_by": "Nick"})
    seeded = {i["sku"] for i in r.json()["items"]}
    check("a cleared bundle seeds as countable once more",
          "W9184B-B10" in seeded, seeded)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
