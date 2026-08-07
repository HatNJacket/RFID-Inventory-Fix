"""Read-only bridge to TC-Planner (the inventory planner).

The planner owns the purchase-order ledger: what was ordered from which
vendor and how much of it has already been received. This module READS
that ledger so scanning surfaces can say "this product is on an open PO,
N more are expected". It must never write — no receipts, no status
changes, no Shopify pushes, no vendor email. Filing a receive against a
PO is a future, explicitly operator-confirmed feature (ROADMAP: Steve's
TODO #2), and when it lands it belongs behind its own write gate.

Auth is the planner's Bearer token (PLANNER_TOKEN). With it unset the
bridge is OFF and every helper answers the "not configured" shape rather
than raising — planner hints are decoration on the scan flow and a
planner outage must never break a scan.
"""
import time

import requests

from app import config

_TIMEOUT = 10
# The per-SKU answer barely moves during a receiving session; a short
# cache keeps repeat scans of the same product from hammering the planner
# (whose PO-detail endpoint does its own live Shopify metafield fetch).
_TTL_SECONDS = 300
_cache: dict[str, tuple[float, dict]] = {}

# A SKU search can also match PO references, vendor names, or comments;
# only this many candidate POs get the (slow) detail fetch before we stop.
_MAX_DETAIL_FETCHES = 6


def configured() -> bool:
    return bool(config.PLANNER_TOKEN)


def _get(path: str, params: dict | None = None) -> dict:
    response = requests.get(
        f"{config.PLANNER_URL}{path}",
        params=params,
        headers={"Authorization": f"Bearer {config.PLANNER_TOKEN}"},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def health() -> dict:
    """Connectivity probe. /api/health is unauthenticated; whoami proves
    the token works too. Never raises — returns ok/error."""
    if not configured():
        return {"configured": False, "ok": False}
    try:
        h = _get("/api/health")
        who = _get("/api/auth/whoami")
        return {
            "configured": True,
            "ok": h.get("status") == "ok",
            "service": h.get("service"),
            "identified_as": who.get("user"),
        }
    except Exception as exc:  # noqa: BLE001 — probe reports, never raises
        return {"configured": True, "ok": False, "error": str(exc)[:200]}


def on_order_for_sku(sku: str) -> dict:
    """Every open-PO line for this SKU with units still expected.

    Answer shape (also on failure — hint surfaces fail soft):
        {configured, ok, sku, total_remaining, orders: [
            {order_id, reference_number, vendor, status, expected_date,
             ordered, received, remaining}]}
    """
    base = {"configured": configured(), "ok": False,
            "sku": sku, "total_remaining": 0, "orders": []}
    if not configured() or not (sku or "").strip():
        return base
    key = sku.strip().upper()
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _TTL_SECONDS:
        return hit[1]
    try:
        found = _get("/api/stock-orders",
                     params={"status": "open", "search": sku.strip()})
        orders = []
        for summary in (found.get("orders") or [])[:_MAX_DETAIL_FETCHES]:
            detail = _get(f"/api/stock-orders/{summary['id']}")
            for item in detail.get("items") or []:
                if (item.get("sku") or "").strip().upper() != key:
                    continue
                ordered = int(item.get("ordered_qty") or 0)
                received = int(item.get("received_qty") or 0)
                if ordered - received <= 0:
                    continue
                orders.append({
                    "order_id": detail.get("id"),
                    "reference_number": detail.get("reference_number"),
                    "vendor": detail.get("vendor"),
                    "status": detail.get("status"),
                    "expected_date": detail.get("expected_date"),
                    "ordered": ordered,
                    "received": received,
                    "remaining": ordered - received,
                })
        result = {**base, "ok": True, "orders": orders,
                  "total_remaining": sum(o["remaining"] for o in orders)}
    except Exception as exc:  # noqa: BLE001 — hints never break a scan
        result = {**base, "error": str(exc)[:200]}
    _cache[key] = (time.monotonic(), result)
    return result
