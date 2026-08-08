"""TC-Planner bridge: STRICTLY read-only PO hints. The bridge answers
"is this SKU on an open purchase order, how many are still expected" —
filtered to exact CI-SKU line matches, fully-received lines dropped,
failures soft (ok=False, never an exception, never a non-200), and a
short cache so repeat scans don't hammer the planner.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ["PLANNER_TOKEN"]="test-token"
os.environ["PLANNER_USER_TOKENS"]="Nick:tok-nick, Steve:tok-steve"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_planner_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app import config, planner
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

# The planner's answers, keyed by URL path. The search result includes a
# PO that only matched by reference/comment (no line for our SKU) — the
# bridge must fetch it, find nothing, and move on.
SEARCH = {"orders": [{"id": 10}, {"id": 11}, {"id": 12}], "total": 3}
DETAILS = {
    10: {"id": 10, "reference_number": 935, "vendor": "Sky-Watcher",
         "status": "partial_received", "expected_date": "2026-09-04",
         "items": [
             {"sku": "s11710", "ordered_qty": 6, "received_qty": 2},
             {"sku": "OTHER-1", "ordered_qty": 3, "received_qty": 0},
         ]},
    11: {"id": 11, "reference_number": 936, "vendor": "Sky-Watcher",
         "status": "shipped", "expected_date": None,
         "items": [{"sku": "S11710", "ordered_qty": 1, "received_qty": 1}]},
    12: {"id": 12, "reference_number": 940, "vendor": "ZWO",
         "status": "open", "expected_date": None,
         "items": [{"sku": "ZWO-X", "ordered_qty": 2, "received_qty": 0}]},
}
calls = []
tokens_seen = []

class FakeResponse:
    def __init__(self, data): self.data = data
    def raise_for_status(self): pass
    def json(self): return self.data

VALID = {"Bearer test-token", "Bearer tok-nick", "Bearer tok-steve"}

def fake_get(url, params=None, headers=None, timeout=None):
    calls.append(url)
    auth = (headers or {}).get("Authorization")
    tokens_seen.append(auth)
    if auth not in VALID:
        raise AssertionError("missing/unknown bearer token: " + repr(auth))
    if url.endswith("/api/health"):
        return FakeResponse({"status": "ok", "service": "tc-inventory-planner"})
    if url.endswith("/api/auth/whoami"):
        return FakeResponse({"user": "Unknown", "identified": False})
    if url.endswith("/api/stock-orders"):
        return FakeResponse(SEARCH)
    for oid, d in DETAILS.items():
        if url.endswith(f"/api/stock-orders/{oid}"):
            return FakeResponse(d)
    raise AssertionError("unexpected url " + url)

with TestClient(app) as cl:
    with patch("app.planner.requests.get", side_effect=fake_get):
        r = cl.get("/api/planner/status")
        check("status probes health + whoami through the token",
              r.status_code == 200 and r.json()["ok"] is True
              and r.json()["identified_as"] == "Unknown", r.text)

        r = cl.get("/api/planner/on-order/S11710")
        body = r.json()
        check("on-order answers 200 with only this SKU's open lines",
              r.status_code == 200 and body["ok"] is True
              and len(body["orders"]) == 1, r.text)
        o = body["orders"][0]
        check("the line matched case-insensitively with remaining math",
              o["reference_number"] == 935 and o["ordered"] == 6
              and o["received"] == 2 and o["remaining"] == 4
              and body["total_remaining"] == 4, body)
        check("a fully-received line and other-SKU POs are dropped",
              all(x["reference_number"] != 936 for x in body["orders"]), body)

        before = len(calls)
        cl.get("/api/planner/on-order/s11710")
        check("repeat scans answer from cache (no new planner calls)",
              len(calls) == before, calls[before:])

        # Attribution: the operator pick rides to the planner as THEIR
        # token; unknown names (and no name) fall back to the RFID token.
        planner._cache.clear()
        n = len(tokens_seen)
        cl.get("/api/planner/on-order/S11710", params={"operator": "nick"})
        check("a known operator's calls carry their own planner token",
              set(tokens_seen[n:]) == {"Bearer tok-nick"}, tokens_seen[n:])
        planner._cache.clear()
        n = len(tokens_seen)
        cl.get("/api/planner/on-order/S11710", params={"operator": "Matt"})
        check("an unmapped operator falls back to the RFID token",
              set(tokens_seen[n:]) == {"Bearer test-token"}, tokens_seen[n:])
        n = len(tokens_seen)
        r = cl.get("/api/planner/status", params={"operator": "Steve"})
        check("status carries the operator's token to whoami",
              r.status_code == 200 and "Bearer tok-steve" in tokens_seen[n:],
              tokens_seen[n:])

    with patch("app.planner.requests.get",
               side_effect=RuntimeError("planner down")):
        r = cl.get("/api/planner/on-order/FRESH-1")
        check("a planner outage fails SOFT: 200, ok=False, error text",
              r.status_code == 200 and r.json()["ok"] is False
              and "planner down" in r.json().get("error", ""), r.text)

    # Bridge off: no token → configured False everywhere, zero HTTP.
    planner._cache.clear()
    old = config.PLANNER_TOKEN
    config.PLANNER_TOKEN = None
    try:
        with patch("app.planner.requests.get",
                   side_effect=AssertionError("must not call")) as m:
            r = cl.get("/api/planner/status")
            check("unconfigured status: configured False, no HTTP",
                  r.json() == {"configured": False, "ok": False}, r.text)
            r = cl.get("/api/planner/on-order/S11710")
            check("unconfigured on-order: empty shape, no HTTP",
                  r.json()["configured"] is False and r.json()["orders"] == []
                  and m.call_count == 0, r.text)
    finally:
        config.PLANNER_TOKEN = old

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
