"""Lookups answer from the LIVE bin map, then the LIVE Shopify API — the
TELCAN mirror is GONE (removed 2026-08-07).

History: the mirror's sync died Dec 2025 but it kept answering for
products the bin map didn't know, stamping renamed SKUs (F9394B as its
six-month-old DB24010501; batch 126's ToupTek G3M662C for the live
G3M662C-L) and cross-wired handles onto tags. dev/repair_mirror_records.py
cleaned the poisoned records; this suite pins the mirror-free order.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_livelookup_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

# The mirror module itself must be gone — not just unused.
check("app/catalog.py (the mirror) no longer exists",
      not os.path.exists(os.path.join(os.path.dirname(os.path.dirname(
          os.path.dirname(os.path.abspath(__file__)))), "app", "catalog.py")))

BARCODE = "50764126849243"
# An UNBINNED product: not in the bin map — must now come from the live
# API (this was the hole the mirror used to answer through, wrongly).
UNBINNED = {"shopify_variant_id":"gid://shopify/ProductVariant/467",
            "shopify_product_id":"gid://shopify/Product/887",
            "product_title":"ToupTek G3M662C Camera - G3M662C",
            "variant_title":None, "sku":"ToupTek G3M662C-L",
            "barcode":"79030393969755",
            "bin_location":"No bin assigned", "image_url":None}

def fake_api(term):
    t = (term or "").strip()
    if t in ("79030393969755", "ToupTek G3M662C-L"):
        return dict(UNBINNED)
    return None

with patch("app.shopify.lookup_barcode", side_effect=fake_api), \
     patch("app.shopify.lookup_barcode_all",
           side_effect=lambda t: ([fake_api(t)] if fake_api(t) else [])), \
     patch("app.shopify.fetch_all_variant_bins", return_value=[]), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import BinMapEntry
    with S(get_engine()) as s:
        # The LIVE catalog: this barcode's CURRENT sku.
        s.add(BinMapEntry(
            sku="F9394B", barcode=BARCODE, bin="I1-5", qty=3,
            product_title="Svbony SA206 Night Vision Goggles",
            variant_title="Green",
            shopify_variant_id="gid://shopify/ProductVariant/46636606849243",
            shopify_product_id="gid://shopify/Product/8816238199003",
            vendor="Svbony"))
        # A barcode two listings share — the primary must win over OPEN BOX.
        for sku, title in (("OPEN BOX - TWIN-1", "OPEN BOX - Twin Scope"),
                           ("TWIN-1", "Twin Scope")):
            s.add(BinMapEntry(sku=sku, barcode="777111", bin="A1-1", qty=1,
                              product_title=title,
                              shopify_variant_id="gid://v/" + sku))
        # Split across two shelves: one row per bin, one candidate.
        for b in ("B1-1", "B2-2"):
            s.add(BinMapEntry(sku="SPLIT-1", barcode="888222", bin=b, qty=1,
                              product_title="Split Product",
                              other_bins="B2-2" if b == "B1-1" else "B1-1",
                              shopify_variant_id="gid://v/SPLIT-1"))
        s.commit()

    def look(term):
        return cl.get(f"/api/products/by-barcode/{term}").json()

    p = look(BARCODE)
    check("a binned barcode answers from the live bin map",
          p["sku"]=="F9394B" and p["source"]=="binmap", p)
    check("the answer carries real Shopify gids",
          str(p["shopify_variant_id"]).startswith("gid://"), p)
    check("and the live bin", p["bin_location"]=="I1-5", p)

    p = look("F9394B")
    check("the live sku resolves directly", p["sku"]=="F9394B", p)

    p = look("777111")
    check("a shared barcode prefers the primary listing over OPEN BOX",
          p["sku"]=="TWIN-1", p)

    p = look("888222")
    check("a split-shelf product resolves once, naming its other shelf",
          p["sku"]=="SPLIT-1" and p["other_bins"] in ("B1-1","B2-2"), p)

    # The mirror's old job, done right: unbinned products come from the
    # LIVE API with current SKUs and real gids.
    p = look("79030393969755")
    check("an unbinned product answers from the LIVE API",
          p["sku"]=="ToupTek G3M662C-L" and p["source"]=="shopify", p)
    check("...with gid ids, never telcan:/handle: surrogates",
          str(p["shopify_variant_id"]).startswith("gid://")
          and not str(p["shopify_product_id"]).startswith("handle:"), p)

    # A SKU the store renamed away resolves NOWHERE — records were
    # repaired to the live SKUs; the dead ones must not resurrect.
    r = cl.get("/api/products/by-barcode/DB24010501")
    check("a dead mirror-era SKU is a clean 404", r.status_code == 404,
          r.status_code)

    r = cl.get("/api/products/by-barcode/NOTHING-ANYWHERE")
    check("a genuine miss is still a 404", r.status_code==404, r.status_code)

# A Shopify outage must degrade, not crash: requests raises HTTPError (not
# RuntimeError), which used to escape as a 500 and took the product window
# down with it.
import requests
with patch("app.shopify.lookup_barcode",
           side_effect=requests.exceptions.HTTPError("404 token endpoint")), \
     patch("app.shopify.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.fetch_all_variant_bins", return_value=[]), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app, raise_server_exceptions=False) as cl:
    r = cl.get("/api/products/by-barcode/UNKNOWN-TO-ALL")
    check("a failing Shopify token call is a 502, never a 500",
          r.status_code == 502, r.status_code)
    r = cl.get("/api/product-history?term=UNKNOWN-TO-ALL")
    check("the product window survives a Shopify outage",
          r.status_code != 500, r.status_code)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
