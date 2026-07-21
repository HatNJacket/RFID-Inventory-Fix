"""Diagnostic terminal script — 'does Shopify still work?'

This is NOT what Azure runs. It's a quick command-line check that your
Shopify credentials and barcode lookup are healthy, using the same
app/shopify.py logic the web app uses. Run it any time a lookup misbehaves:

    python test_shopify.py
"""
from app import config, shopify


def main() -> None:
    config.require_shopify_env()

    while True:
        barcode = input("\nScan barcode (or type 'quit'): ").strip()
        if barcode.lower() in {"quit", "exit"}:
            break

        product = shopify.lookup_barcode(barcode)
        if product is None:
            print("\nNo product found for that barcode.")
            continue

        print("\n----------------------------------------")
        print(f"Product : {product['product_title']}")
        print(f"Variant : {product['variant_title']}")
        print(f"SKU     : {product['sku']}")
        print(f"Barcode : {product['barcode']}")
        print(f"Bin     : {product['bin_location']}")
        print("----------------------------------------")


if __name__ == "__main__":
    main()
