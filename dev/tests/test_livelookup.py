"""Lookups answer from the LIVE bin map, not the dead TELCAN mirror.

The mirror's sync died Dec 2025 and still returns SKUs the store renamed
months ago — F9394B printed as its six-month-old DB24010501 (2026-08-06).
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

BARCODE = "50764126849243"
# What the DEAD mirror still believes: the SKU from six months ago.
STALE = {"shopify_variant_id":"telcan:4482",
         "shopify_product_id":"handle:svbony-...-copy",
         "product_title":"Svbony SA206 Night Vision Goggles",
         "variant_title":None, "sku":"DB24010501", "barcode":BARCODE,
         "bin_location":"No bin assigned", "source":"telcan",
         "image_url":None}
# Unbinned product: the mirror is the ONLY source, and must still answer.
ORPHAN = dict(STALE, sku="ORPHAN-1", barcode="999000111",
              product_title="Unbinned Widget")

def fake_mirror(session, term):
    t = (term or "").strip()
    if t in (BARCODE, "DB24010501"):
        return dict(STALE)
    if t in ("999000111", "ORPHAN-1"):
        return dict(ORPHAN)
    return None

with patch("app.catalog.lookup_barcode", side_effect=fake_mirror), \
     patch("app.catalog.lookup_barcode_all",
           side_effect=lambda s,t: ([dict(STALE)] if fake_mirror(s,t) else [])), \
     patch("app.shopify.lookup_barcode", return_value=None), \
     patch("app.shopify.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.fetch_all_variant_bins", return_value=[]), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import BinMapEntry
    with S(get_engine()) as s:
        # The LIVE catalog: same barcode, the CURRENT sku.
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
    check("scanning the barcode answers with the LIVE sku, not the mirror's",
          p["sku"]=="F9394B" and p["source"]=="binmap", p)
    check("the live answer carries real Shopify gids, not telcan: ids",
          str(p["shopify_variant_id"]).startswith("gid://"), p)
    check("and the live bin, which the mirror didn't have",
          p["bin_location"]=="I1-5", p)

    p = look("DB24010501")
    check("typing the OLD sku still finds it, corrected to the live sku",
          p["sku"]=="F9394B" and p["source"]=="binmap", p)

    p = look("F9394B")
    check("the live sku resolves directly", p["sku"]=="F9394B", p)

    p = look("777111")
    check("a shared barcode prefers the primary listing over OPEN BOX",
          p["sku"]=="TWIN-1", p)

    p = look("888222")
    check("a split-shelf product resolves once, naming its other shelf",
          p["sku"]=="SPLIT-1" and p["other_bins"] in ("B1-1","B2-2"), p)

    # The mirror is still the fallback — never removed, just demoted.
    p = look("999000111")
    check("a product the live map has never binned still answers (mirror)",
          p["sku"]=="ORPHAN-1" and p["source"]=="telcan", p)

    r = cl.get("/api/products/by-barcode/NOTHING-ANYWHERE")
    check("a genuine miss is still a 404", r.status_code==404, r.status_code)

# A Shopify outage must degrade, not crash: requests raises HTTPError (not
# RuntimeError), which used to escape as a 500 and took the product window
# down with it.
import requests
with patch("app.catalog.lookup_barcode", return_value=None), \
     patch("app.catalog.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.lookup_barcode",
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
