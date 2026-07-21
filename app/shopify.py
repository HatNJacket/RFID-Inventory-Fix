"""Shopify Admin API access.

This is your test_shopify.py logic, unchanged in behavior, refactored so
that nothing prints. Functions return Python objects; the web layer decides
how to present them. The barcode query and the stock.bin -> my_fields
fallback are copied verbatim from your working script.
"""
import time

import requests

from app import config

# Client-credentials tokens expire (Shopify documents ~24h). We cache the
# token in memory and refresh a few minutes before expiry rather than
# fetching a fresh one on every request.
_token_cache: dict = {"value": None, "expires_at": 0.0}
_TOKEN_SAFETY_WINDOW = 5 * 60  # refresh 5 minutes early


def get_access_token(force_refresh: bool = False) -> str:
    """Fetch (and cache) a Shopify Admin API access token."""
    now = time.time()
    if (
        not force_refresh
        and _token_cache["value"]
        and now < _token_cache["expires_at"]
    ):
        return _token_cache["value"]

    response = requests.post(
        config.ACCESS_TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": config.SHOPIFY_CLIENT_ID,
            "client_secret": config.SHOPIFY_CLIENT_SECRET,
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()

    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"No access token returned: {data}")

    # expires_in is in seconds when present; default to 23h to stay safe.
    expires_in = data.get("expires_in", 23 * 60 * 60)
    _token_cache["value"] = token
    _token_cache["expires_at"] = now + expires_in - _TOKEN_SAFETY_WINDOW
    return token


def query_shopify(query: str, variables: dict | None = None) -> dict:
    """Run a GraphQL query, refreshing the token once on auth failure."""
    token = get_access_token()
    payload = _post_graphql(token, query, variables)

    # If the cached token was revoked/expired early, retry once with a fresh
    # one before giving up.
    if payload is _AUTH_FAILED:
        token = get_access_token(force_refresh=True)
        payload = _post_graphql(token, query, variables)
        if payload is _AUTH_FAILED:
            raise RuntimeError("Shopify authentication failed after refresh.")

    return payload


_AUTH_FAILED = object()  # sentinel


def _post_graphql(token: str, query: str, variables: dict | None) -> dict:
    response = requests.post(
        config.GRAPHQL_URL,
        headers={
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
        },
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )

    if response.status_code in (401, 403):
        return _AUTH_FAILED

    try:
        response.raise_for_status()
    except requests.HTTPError as error:
        raise RuntimeError(
            f"Shopify API request failed with status "
            f"{response.status_code}:\n{response.text}"
        ) from error

    body = response.json()
    if "errors" in body:
        raise RuntimeError(f"Shopify GraphQL errors: {body['errors']}")

    return body["data"]


# The barcode lookup query, carried over from test_shopify.py including the
# variant stock.bin metafield and the product my_fields.bin_location fallback.
_FIND_VARIANT_QUERY = """
query FindVariant($search: String!) {
  productVariants(first: 1, query: $search) {
    nodes {
      id
      title
      sku
      barcode

      bin: metafield(namespace: "stock", key: "bin") {
        value
      }

      product {
        id
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


def lookup_barcode(term: str) -> dict | None:
    """Look up a variant by barcode — or by SKU when the barcode search
    misses, since some products have bad or missing barcodes. Returns a
    flat dict or None if not found.

    The bin resolution order matches your terminal script exactly:
    variant stock.bin -> product my_fields.bin_location -> "No bin assigned".
    """
    quoted = term.replace('"', "")  # SKUs can contain spaces; quote the query
    nodes = None
    for search in (f'barcode:"{quoted}"', f'sku:"{quoted}"'):
        data = query_shopify(_FIND_VARIANT_QUERY, {"search": search})
        nodes = data["productVariants"]["nodes"]
        if nodes:
            break
    if not nodes:
        return None

    variant = nodes[0]
    product = variant["product"]

    variant_bin = variant["bin"]["value"] if variant["bin"] else None
    easy_scan_bin = (
        product["easyScanBin"]["value"] if product["easyScanBin"] else None
    )
    bin_location = variant_bin or easy_scan_bin or "No bin assigned"

    return {
        "shopify_variant_id": variant["id"],
        "shopify_product_id": product["id"],
        "product_title": product["title"],
        "variant_title": variant["title"],
        "sku": variant["sku"],
        "barcode": variant["barcode"],
        "bin_location": bin_location,
    }
