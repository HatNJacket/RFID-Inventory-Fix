import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()

STORE = os.getenv("SHOPIFY_STORE")
CLIENT_ID = os.getenv("SHOPIFY_CLIENT_ID")
CLIENT_SECRET = os.getenv("SHOPIFY_CLIENT_SECRET")

API_VERSION = "2026-07"
GRAPHQL_URL = f"https://{STORE}/admin/api/{API_VERSION}/graphql.json"


def check_environment() -> None:
    missing = [
        name
        for name, value in {
            "SHOPIFY_STORE": STORE,
            "SHOPIFY_CLIENT_ID": CLIENT_ID,
            "SHOPIFY_CLIENT_SECRET": CLIENT_SECRET,
        }.items()
        if not value
    ]

    if missing:
        sys.exit(f"Missing .env variables: {', '.join(missing)}")


def get_access_token() -> str:
    response = requests.post(
        f"https://{STORE}/admin/oauth/access_token",
        data={
            "grant_type": "client_credentials",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
        },
        timeout=30,
    )

    response.raise_for_status()
    data = response.json()

    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"No access token returned: {data}")

    return token


def query_shopify(
    token: str,
    query: str,
    variables: dict | None = None,
) -> dict:
    response = requests.post(
        GRAPHQL_URL,
        headers={
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
        },
        json={
            "query": query,
            "variables": variables or {},
        },
        timeout=30,
    )

    try:
        response.raise_for_status()
    except requests.HTTPError as error:
        raise RuntimeError(
            f"Shopify API request failed with status "
            f"{response.status_code}:\n{response.text}"
        ) from error

    payload = response.json()

    if "errors" in payload:
        raise RuntimeError(
            f"Shopify GraphQL errors: {payload['errors']}"
        )

    return payload["data"]


def main() -> None:
    check_environment()
    token = get_access_token()

    while True:
        barcode = input("\nScan barcode (or type 'quit'): ").strip()

        if barcode.lower() in {"quit", "exit"}:
            break

        query = """
        query FindVariant($search: String!) {
          productVariants(first: 1, query: $search) {
            nodes {
              title
              sku
              barcode

              bin: metafield(namespace: "stock", key: "bin") {
                value
              }

              product {
                title

                easyScanBin: metafield(
                  namespace: "my_fields"
                  key: "bin_location"
                ) {
                  value
                }
              }
            }
          }
        }
        """

        variables = {
            "search": f"barcode:{barcode}"
        }

        data = query_shopify(token, query, variables)

        variants = data["productVariants"]["nodes"]

        if not variants:
            print("\nNo product found for that barcode.")
            continue

        variant = variants[0]
        product = variant["product"]

        variant_bin = (
            variant["bin"]["value"]
            if variant["bin"] is not None
            else None
        )

        easy_scan_bin = (
            product["easyScanBin"]["value"]
            if product["easyScanBin"] is not None
            else None
        )

        bin_location = (
            variant_bin
            or easy_scan_bin
            or "No bin assigned"
        )

        print("\n----------------------------------------")
        print(f"Product : {product['title']}")
        print(f"Variant : {variant['title']}")
        print(f"SKU     : {variant['sku']}")
        print(f"Barcode : {variant['barcode']}")
        print(f"Bin     : {bin_location}")
        print("----------------------------------------")

if __name__ == "__main__":
    main()