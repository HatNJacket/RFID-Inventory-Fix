"""Review-task reopen (History undo of resolve/dismiss) + task list image
annotation."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
os.environ["SHOPIFY_STORE"]="t.myshopify.com"; os.environ["SHOPIFY_CLIENT_ID"]="x"
os.environ["SHOPIFY_CLIENT_SECRET"]="x"
os.environ.pop("STATION_KEY", None); os.environ.pop("PRINT_AGENT_KEY", None)
db = os.path.join(tempfile.gettempdir(), "rfid_reopen_test.db")
if os.path.exists(db): os.remove(db)
os.environ["DATABASE_URL"] = "sqlite:///" + db.replace("\\","/")
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
fails=[]
def check(l,c,x=""):
    print(("PASS  " if c else "FAIL  ")+l+("" if c else f"  <- {x}"))
    if not c: fails.append(l)

ROWS=[{"shopify_variant_id":"t:1","shopify_product_id":"gid://p/1",
       "product_title":"Test Prod","variant_title":None,"sku":"TP-1",
       "barcode":"111","bin":"A1-1","qty":1,
       "image_url":"https://img.example/tp1.jpg","vendor":"X"}]

with patch("app.shopify.lookup_barcode", return_value=None), \
     patch("app.shopify.lookup_barcode_all", return_value=[]), \
     patch("app.shopify.fetch_all_variant_bins", return_value=ROWS), \
     patch("app.shopify.get_on_hand", return_value=None), \
     patch("app.shopify.get_stock_info_by_skus", return_value={}), \
     patch("app.shopify.get_quantities_by_skus", return_value={}):
  with TestClient(app) as cl:
    from sqlalchemy.orm import Session as S
    from app.database import get_engine
    from app.models import ReviewTask
    with S(get_engine()) as s:
        s.add(ReviewTask(category="inventory-check", sku="TP-1",
                         product_title="Test Prod",
                         detail="Bin A1-1: 2 unit(s) counted but Shopify "
                                "on-hand is 5. Recommend a product-specific "
                                "count."))
        s.commit()

    tasks = cl.get("/api/review-tasks").json()["tasks"]
    tid = tasks[0]["id"]
    check("task list carries the bin-map image for the preview",
          tasks[0]["image_url"]=="https://img.example/tp1.jpg", tasks[0])

    r = cl.post(f"/api/review-tasks/{tid}/reopen", json={})
    check("reopening an open task refused", r.status_code==409, r.status_code)

    cl.post(f"/api/review-tasks/{tid}/resolve",
            json={"resolved_by":"Steve","dismissed":True})
    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"]=="review-dismissed"]
    check("dismissal in History with reopen undo payload",
          len(ev)==1 and ev[0]["undo"]["kind"]=="review-reopen"
          and ev[0]["undo"]["task_id"]==tid, ev)

    r = cl.post(f"/api/review-tasks/{tid}/reopen", json={})
    check("reopen accepted", r.status_code==200 and r.json()["status"]=="open",
          r.text[:200])
    tasks = cl.get("/api/review-tasks").json()["tasks"]
    check("task back in the open inbox",
          any(t["id"]==tid for t in tasks), tasks)
    ev = [e for e in cl.get("/api/history").json()["events"]
          if e["type"]=="review-dismissed"]
    check("stale resolution event no longer offered (task is open)",
          len(ev)==0, ev)

print()
print("FAILED: "+", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
