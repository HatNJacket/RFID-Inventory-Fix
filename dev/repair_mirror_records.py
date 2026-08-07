"""One-off repair: re-resolve every mirror-poisoned record via the live API.

The TELCAN mirror (sync dead since Dec 2025) answered lookups for products
the bin map didn't know and stamped its stale SKUs and `telcan:`/`handle:`
surrogate ids onto tags and batch rows — G3M662C instead of the live
G3M662C-L, admin links that can't be built, several handles cross-wired to
the WRONG product entirely. This script finds every such row, asks the
LIVE Shopify API what its barcode really is, and rewrites the identity
fields (sku / titles / variant + product gids). Bin locations, quantities
and EPCs are never touched.

Run with prod credentials in the environment:

    set DATABASE_URL=<prod url>          (plus SHOPIFY_STORE / CLIENT_ID /
    py dev/repair_mirror_records.py       CLIENT_SECRET for the API)
    py dev/repair_mirror_records.py --apply

Dry-run (no --apply) prints the full before/after receipt and writes
nothing. --apply also updates open Review tasks carrying a dead SKU and
leaves one History receipt (changed_field="sku", by "mirror-repair") per
distinct old->new SKU transition.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import or_, select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app import shopify  # noqa: E402
from app.database import get_engine  # noqa: E402
from app.models import (  # noqa: E402
    BarcodeChange,
    BatchItem,
    ReviewTask,
    RfidAssignment,
)

APPLY = "--apply" in sys.argv
MIRROR_SHAPE = lambda cls: or_(  # noqa: E731
    cls.shopify_variant_id.like("telcan:%"),
    cls.shopify_product_id.like("handle:%"),
)

import re  # noqa: E402

live_by_term: dict[str, list] = {}
_SECONDARY = re.compile(r"open[\s-]?box|used|demo|refurb", re.I)


def live_all(term: str) -> list:
    t = (term or "").strip()
    if not t:
        return []
    if t not in live_by_term:
        try:
            cands = shopify.lookup_barcode_all(t) or []
            if not cands:
                single = shopify.lookup_barcode(t)
                cands = [single] if single else []
            # Primary listing first (same rule the Check step uses).
            cands.sort(key=lambda p: 1 if _SECONDARY.search(
                f"{p.get('product_title') or ''} "
                f"{p.get('variant_title') or ''}") else 0)
            live_by_term[t] = cands
        except Exception as error:
            print(f"  !! API error for {t}: {error}")
            live_by_term[t] = []
    return live_by_term[t]


def best_for(row, *terms) -> dict | None:
    """The live candidate this row should become. A row whose OLD sku still
    exists among the barcode's live listings keeps that identity (an
    operator may have deliberately picked the OPEN BOX twin) — only its
    ids/titles refresh. Otherwise the primary listing wins."""
    cands: list = []
    for t in terms:
        cands = live_all(t)
        if cands:
            break
    if not cands:
        return None
    old = (row.sku or "").strip().upper()
    if old:
        for c in cands:
            if (c.get("sku") or "").strip().upper() == old:
                return c
    return cands[0]


def fix(row, p, kind_label, receipts):
    old_sku = (row.sku or "").strip()
    new_sku = (p.get("sku") or "").strip()
    print(f"  {kind_label}: {old_sku or '(no sku)'} -> {new_sku}"
          f"  [{row.shopify_variant_id} -> {p.get('shopify_variant_id')}]")
    if old_sku.upper() != new_sku.upper() and new_sku:
        receipts[(old_sku, new_sku)] = p
    if not APPLY:
        return
    row.sku = new_sku or row.sku
    row.product_title = p.get("product_title") or row.product_title
    if hasattr(row, "variant_title"):
        row.variant_title = p.get("variant_title")
    row.shopify_variant_id = p.get("shopify_variant_id")
    row.shopify_product_id = p.get("shopify_product_id")


def main() -> int:
    print(f"{'APPLY' if APPLY else 'DRY RUN'} — mirror-record repair\n")
    unfixable: list[str] = []
    receipts: dict[tuple, dict] = {}
    fixed = {"assignment": 0, "batch-item": 0, "review-task": 0}

    with Session(get_engine()) as s:
        assignments = s.scalars(
            select(RfidAssignment).where(MIRROR_SHAPE(RfidAssignment))
        ).all()
        items = s.scalars(
            select(BatchItem).where(MIRROR_SHAPE(BatchItem))
        ).all()
        print(f"{len(assignments)} assignment(s), {len(items)} batch "
              f"item(s) carry mirror-shaped ids.\n")

        for row in assignments:
            p = best_for(row, row.barcode, row.sku)
            if p is None:
                unfixable.append(
                    f"assignment {row.rfid_id} (sku {row.sku}, barcode "
                    f"{row.barcode}) — live API knows neither"
                )
                continue
            fix(row, p, f"tag {row.rfid_id}", receipts)
            fixed["assignment"] += 1

        for row in items:
            p = best_for(row, row.barcode or row.scanned_code, row.sku)
            if p is None:
                unfixable.append(
                    f"batch {row.batch_id} item {row.id} (sku {row.sku}, "
                    f"barcode {row.barcode}) — live API knows neither"
                )
                continue
            fix(row, p, f"batch {row.batch_id} item {row.id}", receipts)
            fixed["batch-item"] += 1

        # Open Review tasks whose SKU is one of the dead ones follow along
        # so their images and product links come back.
        old_to_new = {o.upper(): (n, p) for (o, n), p in receipts.items()
                      if o}
        if old_to_new:
            for t in s.scalars(
                select(ReviewTask).where(ReviewTask.status == "open")
            ):
                hit = old_to_new.get((t.sku or "").strip().upper())
                if hit is None:
                    continue
                new_sku, p = hit
                print(f"  review task #{t.id} [{t.category}]: "
                      f"{t.sku} -> {new_sku}")
                if APPLY:
                    t.sku = new_sku
                    t.product_title = (p.get("product_title")
                                       or t.product_title)
                fixed["review-task"] += 1

        if APPLY:
            for (old_sku, new_sku), p in receipts.items():
                s.add(BarcodeChange(
                    sku=new_sku,
                    product_title=p.get("product_title"),
                    shopify_variant_id=p.get("shopify_variant_id"),
                    changed_field="sku",
                    old_barcode=old_sku or None,
                    new_barcode=new_sku,
                    changed_by="mirror-repair",
                ))
            s.commit()

    print(f"\n{'Fixed' if APPLY else 'Would fix'}: "
          f"{fixed['assignment']} tag(s), {fixed['batch-item']} batch "
          f"item(s), {fixed['review-task']} review task(s); "
          f"{len(receipts)} distinct SKU transition(s).")
    if unfixable:
        print(f"\nLEFT UNTOUCHED ({len(unfixable)}):")
        for u in unfixable:
            print("  -", u)
    if not APPLY:
        print("\nDry run only — re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
