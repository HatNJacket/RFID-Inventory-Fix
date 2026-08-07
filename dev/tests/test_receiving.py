"""Receiving batches: bin-less collect → PRINT → pair loop.

Contract: kind="receiving" starts with no bin and no pre-seed; PRINT is
repeatable and only queues boxes not yet labelled, each label carrying the
ITEM's home bin (the shelving instruction); no-bin items are held out and
named; pairing records the home bin on the tag; verify/side-trips refuse;
finishing (no verify gate) files one bin-check Review task per bin that
received stock plus the usual unresolved/orphan-label flags; receiving
never claims a bin as done and History calls it Receiving.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_receiving_test.db")
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
A = prod("t:1","RECA-1","Alpha Scope","I1-5","901")
B = prod("t:2","RECB-1","Beta Mount","J2-3","902")
C = prod("t:3","RECC-1","Gamma New Product",None,"903")   # no bin yet
CAT = {p["barcode"]: p for p in (A,B,C)}
def look(t):
    p = CAT.get(t) or next((x for x in CAT.values() if x["sku"]==t), None)
    return dict(p) if p else None

with patch("app.shopify.lookup_barcode", side_effect=look), \
     patch("app.shopify.lookup_barcode_all", side_effect=lambda t:([look(t)] if look(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=[]), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy import select as sa_select
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import BatchItem, BinMapEntry, PrintJob

    with S(get_engine()) as s:
        s.add(BinMapEntry(sku="OTHER-1", bin="I1-2", qty=1,
                          product_title="Rack neighbour",
                          shopify_variant_id="t:9"))
        s.commit()

    # A normal batch still demands a bin.
    r = cl.post("/api/batches", json={"created_by":"Nick"})
    check("bin-less create without kind=receiving is refused",
          r.status_code == 422, r.text)

    r = cl.post("/api/batches",
                json={"kind":"receiving","created_by":"Nick"})
    check("receiving batch starts with no bin", r.status_code == 201, r.text)
    rb = r.json()
    bid = rb["id"]
    check("it is marked kind=receiving on the RECEIVING sentinel",
          rb["kind"] == "receiving" and rb["bin_name"] == "RECEIVING", rb)
    check("no pre-seeded items", rb["items"] == [], rb)

    open_list = cl.get("/api/batches", params={"status":"open"}).json()
    mine = next((b for b in open_list["batches"] if b["id"] == bid), None)
    check("open-batch list carries kind for the pickers",
          mine is not None and mine.get("kind") == "receiving", mine)

    # ---- pass 1: collect ------------------------------------------------
    for code in ("901", "901", "902", "903"):
        r = cl.post(f"/api/batches/{bid}/scan", json={"code": code})
        if r.status_code not in (200, 201):
            check(f"scan {code} accepted", False, r.text)
        elif r.json().get("bin_mismatch"):
            check(f"scan {code} must NOT raise the keep-or-move prompt "
                  f"(receiving has no shelf)", False, r.json())
    r = cl.post(f"/api/batches/{bid}/scan", json={"code": "999"})
    check("unknown barcode still counts (unresolved row)",
          r.status_code in (200, 201)
          and r.json()["item"]["resolved"] is False, r.text)

    review = cl.get(f"/api/batches/{bid}/review").json()
    flags = [f for e in review.get("flagged", review.get("items", []))
             for f in e.get("flags", [])]
    check("check step raises no wrong-bin flags (receiving has no shelf)",
          "wrong-bin" not in flags, flags)
    check("check step raises no count-mismatch flags either",
          "count-mismatch" not in flags, flags)

    # ---- pass 1: print --------------------------------------------------
    r = cl.post(f"/api/batches/{bid}/queue-labels", json={})
    check("PRINT queues one label per labelable box",
          r.status_code == 201 and r.json()["count"] == 3, r.text)
    check("the no-bin product is held out BY NAME",
          r.json().get("skipped_no_bin") == ["Gamma New Product"], r.json())
    check("receiving stays collecting after printing (the loop)",
          r.json()["batch"]["status"] == "collecting", r.json()["batch"])
    with S(get_engine()) as s:
        jobs = s.scalars(sa_select(PrintJob)
                         .where(PrintJob.batch_id == bid)).all()
        bins_on_labels = sorted(j.bin_location for j in jobs)
    check("labels carry each item's HOME bin, not RECEIVING",
          bins_on_labels == ["I1-5", "I1-5", "J2-3"], bins_on_labels)

    # Everything labelable is labelled; only the no-bin hold-out remains —
    # PRINT answers count 0 and NAMES it rather than erroring, so the UI
    # can say "nothing printed — Gamma needs a bin".
    r = cl.post(f"/api/batches/{bid}/queue-labels", json={})
    check("re-printing with nothing new queues nothing (no doubles)",
          r.status_code == 201 and r.json()["count"] == 0
          and r.json()["skipped_no_bin"] == ["Gamma New Product"], r.text)

    # ---- pass 2: one more box, assign the missing bin -------------------
    cl.post(f"/api/batches/{bid}/scan", json={"code": "901"})
    with S(get_engine()) as s:
        gamma = s.scalar(sa_select(BatchItem).where(
            BatchItem.batch_id == bid, BatchItem.sku == "RECC-1"))
        gamma.bin_location = "K3-1"
        s.commit()
        gamma_id = gamma.id
    r = cl.post(f"/api/batches/{bid}/queue-labels", json={})
    check("next pass queues ONLY the new box and the newly-binned one",
          r.status_code == 201 and r.json()["count"] == 2
          and r.json().get("skipped_no_bin") == [], r.text)
    with S(get_engine()) as s:
        k3 = s.scalars(sa_select(PrintJob).where(
            PrintJob.batch_id == bid,
            PrintJob.bin_location == "K3-1")).all()
    check("the newly-binned label says K3-1", len(k3) == 1, len(k3))

    # A cancelled label frees its box for the next pass.
    with S(get_engine()) as s:
        j = s.scalars(sa_select(PrintJob).where(
            PrintJob.batch_id == bid,
            PrintJob.bin_location == "J2-3")).first()
        j.status = "cancelled"
        s.commit()
    r = cl.post(f"/api/batches/{bid}/queue-labels", json={})
    check("a cancelled label re-queues on the next pass",
          r.status_code == 201 and r.json()["count"] == 1, r.text)

    # ---- pair: the tag records the HOME bin -----------------------------
    with S(get_engine()) as s:
        alpha = s.scalar(sa_select(BatchItem).where(
            BatchItem.batch_id == bid, BatchItem.sku == "RECA-1"))
        alpha_id = alpha.id
    r = cl.post(f"/api/batches/{bid}/pair",
                json={"epc":"ABCD00000000000000000001","item_id":alpha_id,
                      "created_by":"Nick"})
    check("pairing works mid-loop", r.status_code in (200, 201), r.text)
    check("the tag's bin is the product's home shelf, not RECEIVING",
          r.json()["assignment"]["bin_location"] == "I1-5", r.json())

    # ---- guardrails -----------------------------------------------------
    r = cl.post(f"/api/batches/{bid}/verify", json={"epcs":[]})
    check("verify refuses receiving batches", r.status_code == 422, r.text)
    r = cl.post(f"/api/batches/{bid}/divert",
                json={"bin":"I1-5","created_by":"Nick"})
    check("side trips refuse receiving batches", r.status_code == 422, r.text)

    # ---- finish ---------------------------------------------------------
    r = cl.post(f"/api/batches/{bid}/complete",
                json={"finalize": False, "created_by":"Nick"})
    check("receiving closes without the web-verify parking gate",
          r.status_code == 200, r.text)
    done = r.json()
    check("batch is done", done["batch"]["status"] == "done", done["batch"])
    tasks = done["review_tasks"]
    cats = sorted(t["category"] for t in tasks)
    bin_checks = [t for t in tasks if t["category"] == "bin-check"]
    check("one bin-check per bin that received stock (I1-5, J2-3, K3-1)",
          sorted(t["detail"].split(":")[0] for t in bin_checks)
          == ["Bin I1-5", "Bin J2-3", "Bin K3-1"], bin_checks)
    check("box counts ride the bin-check details",
          any("3 box(es)" in t["detail"] and "I1-5" in t["detail"]
              for t in bin_checks), bin_checks)
    check("unpaired labels flag as pairing-incomplete",
          "pairing-incomplete" in cats, cats)
    check("the unknown barcode flags as unresolved-barcode",
          "unresolved-barcode" in cats, cats)
    check("no shelf-count inventory-check tasks from receiving",
          "inventory-check" not in cats, cats)
    check("bins_touched sums boxes per bin",
          done["bins_touched"] == {"I1-5": 3, "J2-3": 1, "K3-1": 1},
          done["bins_touched"])

    # ---- exclusions -----------------------------------------------------
    hist = cl.get("/api/history").json()
    types = [e["type"] for e in hist.get("events", [])]
    check("History says receiving-started / receiving-completed",
          "receiving-started" in types and "receiving-completed" in types,
          [t for t in types if "receiv" in t or "batch" in t][:8])
    check("History never calls it a bin batch",
          not any(e["type"] in ("batch-started","batch-completed")
                  and f"#{bid}" in (e.get("detail") or "")
                  for e in hist.get("events", [])), None)

    # ---- manual mark-for-check ------------------------------------------
    r = cl.post("/api/review/bin-checks",
                json={"bins":["Z9-9"],"created_by":"Nick","note":"dusty"})
    check("manual bin marks file a bin-check task",
          r.status_code == 201 and r.json()["count"] == 1, r.text)
    r = cl.post("/api/review/bin-checks",
                json={"bins":["I1-5"],"created_by":"Nick"})
    check("a bin with an OPEN check isn't double-filed",
          r.status_code == 201 and r.json()["count"] == 0
          and r.json()["already_open"] == 1, r.text)
    r = cl.post("/api/review/bin-checks",
                json={"rack":"I1","created_by":"Nick"})
    check("rack prefix expands via the bin map, minus open dupes",
          r.status_code == 201 and r.json()["count"] == 1
          and "I1-2" in r.json()["tasks"][0]["detail"], r.text)
    r = cl.post("/api/review/bin-checks", json={"created_by":"Nick"})
    check("no bins and no rack is refused", r.status_code == 422, r.text)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
