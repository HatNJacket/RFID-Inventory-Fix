"""Barcode lookup against the TELCAN catalog mirror.

TELCAN already mirrors the whole Shopify catalog (Shopify_Variants,
Shopify_Products, Shopify_Inventory), so most scans can be answered straight
from SQL — faster than the Shopify API and immune to API hiccups. TELCAN
keys products by handle + SKU rather than Shopify's variant ids, so results
carry surrogate ids ("telcan:<Variant_ID>"); the app anchors tag lists on
SKU/barcode, which both lookup sources provide.

Read-only: this module only ever SELECTs from the mirror tables.
"""
from sqlalchemy import text
from sqlalchemy.orm import Session

# Matches the scanned/typed term against barcode first, SKU second — some
# products have bad or missing barcodes, so operators can type the SKU into
# the same field. Bin resolution mirrors the Shopify metafield fallback:
# Shopify_Inventory.Bin_Name when populated, else "No bin assigned".
_LOOKUP_SQL = text(
    """
    SELECT TOP 1
        v.Variant_ID,
        v.Handle_ID,
        v.Variant_SKU,
        v.Variant_Barcode,
        v.Option1_Name,
        v.Option1_Value,
        v.Option2_Value,
        v.Option3_Value,
        p.Title AS Product_Title,
        i.Bin_Name
    FROM dbo.Shopify_Variants v
    LEFT JOIN dbo.Shopify_Products p
           ON p.Handle_ID = v.Handle_ID
    LEFT JOIN dbo.Shopify_Inventory i
           ON i.Handle_ID = v.Handle_ID
          AND i.Variant_SKU = v.Variant_SKU
    WHERE v.Variant_Barcode = :term OR v.Variant_SKU = :term
    ORDER BY CASE WHEN v.Variant_Barcode = :term THEN 0 ELSE 1 END
    """
)


def _variant_title(row) -> str | None:
    """Combine option values ("0.5m", "Blue / Large"); Shopify's placeholder
    'Default Title' means the product has no real variants."""
    values = [
        v for v in (row.Option1_Value, row.Option2_Value, row.Option3_Value)
        if v and str(v).strip()
    ]
    title = " / ".join(str(v).strip() for v in values)
    return None if (not title or title == "Default Title") else title


def lookup_barcode(session: Session, term: str) -> dict | None:
    """Look up a variant by barcode or SKU in TELCAN. Returns the same flat
    dict shape as shopify.lookup_barcode (plus source='telcan'), or None."""
    row = session.execute(_LOOKUP_SQL, {"term": term}).first()
    if row is None:
        return None

    return {
        "shopify_variant_id": f"telcan:{row.Variant_ID}",
        "shopify_product_id": f"handle:{row.Handle_ID}",
        "product_title": row.Product_Title or row.Handle_ID or "(unknown)",
        "variant_title": _variant_title(row),
        "sku": row.Variant_SKU,
        "barcode": row.Variant_Barcode,
        "bin_location": (
            str(row.Bin_Name).strip()
            if row.Bin_Name and str(row.Bin_Name).strip()
            else "No bin assigned"
        ),
        "source": "telcan",
    }
