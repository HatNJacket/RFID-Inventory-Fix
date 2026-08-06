"""The Inventory tab's quantity call must return ON-HAND, not AVAILABLE.

available = on_hand - committed, so it sinks as orders are placed and goes
negative on oversells: SKU 44135 showed -3 in the Inventory tab while two
boxes sat on the shelf (2026-08-06). Everything else moved to on_hand in
July; this call was missed.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
from unittest.mock import patch
from app import shopify
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

def variant(sku, available, on_hand_levels):
    """on_hand_levels=None means the store exposes no levels at all."""
    node = {"sku": sku, "inventoryQuantity": available}
    if on_hand_levels is None:
        node["inventoryItem"] = {"inventoryLevels": {"nodes": []}}
    else:
        node["inventoryItem"] = {"inventoryLevels": {"nodes": [
            {"quantities": [{"name": "on_hand", "quantity": q}]}
            for q in on_hand_levels
        ]}}
    return node

NODES = [
    # The real case: oversold, so available is negative while stock exists.
    variant("44135", -3, [2]),
    variant("22016", -1, [0]),
    # Committed stock makes available lag on-hand.
    variant("44410", 1, [2]),
    # Split across two locations: on-hand sums.
    variant("MULTI-1", 4, [3, 2]),
    # Shopify's own on-hand is genuinely negative for a few store rows —
    # report it faithfully rather than inventing a floor.
    variant("21024-ACC", -3, [-1]),
    # No levels exposed: fall back to inventoryQuantity rather than crash.
    variant("NOLEVELS-1", 7, None),
]

captured = {}
def fake_query(q, variables=None):
    captured["query"] = q
    return {"productVariants": {"nodes": NODES}}

with patch("app.shopify.query_shopify", side_effect=fake_query):
    got = shopify.get_quantities_by_skus([n["sku"] for n in NODES])

check("the query actually asks Shopify for on_hand",
      'quantities(names: ["on_hand"])' in captured.get("query", ""),
      captured.get("query", "")[:120])
check("oversold product reports its real shelf count, not -3",
      got["44135"] == 2, got.get("44135"))
check("available 0 vs on-hand 0 still agrees", got["22016"] == 0,
      got.get("22016"))
check("committed stock no longer hides a box", got["44410"] == 2,
      got.get("44410"))
check("on-hand sums across locations", got["MULTI-1"] == 5,
      got.get("MULTI-1"))
check("a genuinely negative on-hand is reported as-is",
      got["21024-ACC"] == -1, got.get("21024-ACC"))
check("no inventory levels falls back to inventoryQuantity",
      got["NOLEVELS-1"] == 7, got.get("NOLEVELS-1"))
check("nothing returns the raw available value by mistake",
      all(got[n["sku"]] != n["inventoryQuantity"]
          or n["sku"] in ("22016", "NOLEVELS-1")
          for n in NODES), got)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
