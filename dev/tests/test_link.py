"""LINK relay: the C72 forwards BT barcodes + trigger RFID reads to the
web terminal over the server (no Bluetooth to the PC).

Contract under test: the gun POSTs scans; the terminal opens with a
cursor call (after=-1) so pre-toggle scans never replay, polls forward,
acts, and posts outcomes back; the gun polls its scan by id for the
ding/buzz. Rows older than a day are swept on the next submit.
"""
import os, sys, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_link_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

with TestClient(app) as cl:
    # A scan fired BEFORE the web toggle turns on...
    r = cl.post("/api/link/scans",
                json={"kind": "barcode", "value": " 507641 ",
                      "device": "C72"})
    check("gun can submit a barcode scan", r.status_code == 200, r.text)
    first = r.json()["scan"]
    check("submitted value is trimmed", first["value"] == "507641", first)

    # ...must never replay: the toggle-on call just returns the cursor.
    r = cl.get("/api/link/scans", params={"after": -1})
    check("toggle-on cursor call returns no rows",
          r.status_code == 200 and r.json()["scans"] == [], r.text)
    cursor = r.json()["cursor"]
    check("cursor starts at the latest scan id", cursor == first["id"],
          (cursor, first["id"]))

    r = cl.get("/api/link/scans", params={"after": cursor})
    check("no new scans → empty poll", r.json()["scans"] == [], r.text)
    check("empty poll keeps the cursor", r.json()["cursor"] == cursor)

    # Now the gun fires while the terminal is listening.
    r = cl.post("/api/link/scans",
                json={"kind": "epc", "value": "AAAA0000000000000000000A",
                      "rssi": "-41.2", "device": "C72"})
    epc_scan = r.json()["scan"]
    r = cl.get("/api/link/scans", params={"after": cursor})
    got = r.json()["scans"]
    check("poll returns exactly the new scan",
          len(got) == 1 and got[0]["id"] == epc_scan["id"], got)
    check("scan carries kind/value/rssi",
          got[0]["kind"] == "epc" and got[0]["rssi"] == "-41.2", got)
    check("poll advances the cursor", r.json()["cursor"] == epc_scan["id"])
    cursor = r.json()["cursor"]

    # Terminal acts on it and reports back; gun sees the outcome.
    r = cl.post(f"/api/link/scans/{epc_scan['id']}/result",
                json={"ok": True, "outcome": "Paired to Svbony SA206 ✓"})
    check("terminal can post an outcome", r.status_code == 200, r.text)
    r = cl.get(f"/api/link/scans/{epc_scan['id']}")
    s = r.json()["scan"]
    check("gun's poll sees ok + outcome",
          s["ok"] is True and "Paired" in (s["outcome"] or ""), s)
    check("acted-on scan is marked consumed", s["consumed_at"] is not None, s)

    # A failure outcome for the buzz path.
    r = cl.post("/api/link/scans",
                json={"kind": "epc", "value": "BBBB0000000000000000000B",
                      "device": "C72"})
    dup = r.json()["scan"]
    cl.post(f"/api/link/scans/{dup['id']}/result",
            json={"ok": False, "outcome": "Already linked to another product"})
    s = cl.get(f"/api/link/scans/{dup['id']}").json()["scan"]
    check("failed outcome round-trips ok=false", s["ok"] is False, s)
    cursor = dup["id"]

    # A second gun's scans don't leak into a device-filtered poll.
    cl.post("/api/link/scans",
            json={"kind": "barcode", "value": "111", "device": "C72-2"})
    r = cl.get("/api/link/scans",
               params={"after": cursor, "device": "C72"})
    check("device filter hides the other gun's scans",
          r.json()["scans"] == [], r.json())
    r = cl.get("/api/link/scans", params={"after": cursor})
    check("unfiltered poll still sees every gun",
          len(r.json()["scans"]) == 1, r.json())

    # Garbage in gets refused, not stored.
    r = cl.post("/api/link/scans", json={"kind": "junk", "value": "x"})
    check("unknown kind is rejected", r.status_code == 422, r.text)
    r = cl.post("/api/link/scans", json={"kind": "barcode", "value": ""})
    check("empty value is rejected", r.status_code == 422, r.text)
    r = cl.get("/api/link/scans/999999")
    check("unknown scan id is a 404", r.status_code == 404, r.text)

    # Day-old plumbing is swept on the next submit.
    from sqlalchemy import select as sa_select
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import LinkScan
    with S(get_engine()) as s2:
        s2.add(LinkScan(kind="barcode", value="OLD-1", device="C72",
                        created_at=datetime.now(timezone.utc)
                        - timedelta(days=2)))
        s2.commit()
        old_id = s2.scalar(sa_select(LinkScan.id)
                           .where(LinkScan.value == "OLD-1"))
    check("backdated scan landed", old_id is not None)
    cl.post("/api/link/scans",
            json={"kind": "barcode", "value": "fresh", "device": "C72"})
    # By VALUE, not id — sqlite reuses a deleted row's id for the next
    # insert, so a GET by id can accidentally find the fresh scan.
    with S(get_engine()) as s3:
        gone = s3.scalar(sa_select(LinkScan.id)
                         .where(LinkScan.value == "OLD-1"))
    check("day-old scans are swept on the next submit", gone is None, gone)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
