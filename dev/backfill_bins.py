"""One-off: write RFID tag placements to Shopify for every product whose
bin is MISSING there (Nick, 2026-08-08).

Reads /api/inventory/summary and, for each row where tags record a real
shelf but Shopify has no bin at all, drives the NORMAL audited write —
POST /api/bin-updates — so Shopify (variant + EasyScan), the bin map,
the tags and open-batch snapshots all move together and every write
leaves a History receipt (changed_by "bin-backfill", undoable like any
bin change).

Rows where Shopify HAS a bin that merely disagrees are REPORTED, never
written: those need per-product judgment (the tab's per-row button).

Usage:
    py dev/backfill_bins.py                # dry run (default)
    py dev/backfill_bins.py --apply        # do the writes
Env: RFID_SERVER (default prod), STATION_KEY (required for prod).
"""
import argparse
import os
import sys
import time

import requests

SERVER = os.environ.get(
    "RFID_SERVER", "https://telcan-rfid.azurewebsites.net"
).rstrip("/")
KEY = os.environ.get("STATION_KEY", "")


def api(method: str, path: str, body: dict | None = None) -> dict:
    r = requests.request(
        method, SERVER + path, json=body,
        headers={"X-Station-Key": KEY} if KEY else {},
        timeout=60,
    )
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", "")
        except Exception:
            detail = r.text[:200]
        raise RuntimeError(f"HTTP {r.status_code}: {detail}")
    return r.json()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="actually write (default is a dry run)")
    ap.add_argument("--sleep", type=float, default=0.6,
                    help="pause between writes (Shopify rate limits)")
    args = ap.parse_args()

    rows = api("GET", "/api/inventory/summary")["products"]
    missing, differs = [], []
    for p in rows:
        sku = (p.get("sku") or "").strip()
        bin_ = (p.get("bin_location") or "").strip()
        if not sku or not bin_ or bin_.lower() == "no bin assigned":
            continue
        if not (p.get("shopify_bin") or "").strip():
            missing.append(p)
        elif p.get("bin_differs"):
            differs.append(p)

    print(f"{len(rows)} inventory rows -> "
          f"{len(missing)} missing on Shopify (will write), "
          f"{len(differs)} differ (report only)\n")

    if differs:
        print("DIFFERS (not touched — use the tab's per-row button):")
        for p in differs:
            print(f"  {p['sku']:24} tags at {p['bin_location']:12} "
                  f"Shopify says {p['shopify_bin']}")
        print()

    if not missing:
        print("Nothing to write.")
        return 0

    print(("WRITING" if args.apply else "WOULD WRITE (dry run)")
          + " tag placement -> Shopify:")
    wrote = failed = 0
    for p in missing:
        line = f"  {p['sku']:24} -> {p['bin_location']}"
        if not args.apply:
            print(line)
            continue
        try:
            api("POST", "/api/bin-updates", {
                "target": p["sku"],
                "bin": p["bin_location"],
                "changed_by": "bin-backfill",
            })
            wrote += 1
            print(line + "   OK")
        except Exception as exc:  # noqa: BLE001 — report and continue
            failed += 1
            print(line + f"   FAILED: {exc}")
        time.sleep(args.sleep)

    if args.apply:
        print(f"\ndone: {wrote} written, {failed} failed, "
              f"{len(differs)} left for per-row judgment")
    else:
        print(f"\ndry run only — rerun with --apply to write "
              f"{len(missing)} bins")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
