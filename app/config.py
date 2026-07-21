"""Configuration and environment loading.

All environment access lives here so every other module imports settled
values instead of calling os.getenv() in scattered places. Locally these
come from .env; on Azure App Service they come from Environment variables.
"""
import os
import sys

from dotenv import load_dotenv

# Local development reads .env. On Azure the variables are already present
# in the process environment, so load_dotenv() simply finds nothing and the
# real App Service settings win.
load_dotenv()

SHOPIFY_STORE = os.getenv("SHOPIFY_STORE")
SHOPIFY_CLIENT_ID = os.getenv("SHOPIFY_CLIENT_ID")
SHOPIFY_CLIENT_SECRET = os.getenv("SHOPIFY_CLIENT_SECRET")

# Present in production (Azure SQL), absent locally until you want the full
# loop. The app still runs Shopify lookups without it; only assignment
# storage needs it. Locally, sqlite:///./local.db works for testing.
DATABASE_URL = os.getenv("DATABASE_URL")

# Where barcode lookups go first:
#   "auto" (default) — TELCAN catalog tables first, Shopify API fallback
#   "db"             — TELCAN only
#   "api"            — Shopify API only (the original behavior)
BARCODE_LOOKUP = os.getenv("BARCODE_LOOKUP", "auto").strip().lower()

# Label printing. Jobs are always queued server-side; this flag controls who
# sees the Print button. False (default): only pages opened with ?printer=1
# (bookmark that URL on the printer laptop). True: every device, including
# the iPad, gets the button — flip it on later, no code changes needed.
ALLOW_REMOTE_PRINT = os.getenv("ALLOW_REMOTE_PRINT", "false").strip().lower() in (
    "1", "true", "yes", "on"
)

# Optional shared secret for the print agent. When set, the agent must send
# it as an X-Agent-Key header on claim/complete/fail calls.
PRINT_AGENT_KEY = os.getenv("PRINT_AGENT_KEY")

API_VERSION = "2026-07"
GRAPHQL_URL = f"https://{SHOPIFY_STORE}/admin/api/{API_VERSION}/graphql.json"
ACCESS_TOKEN_URL = f"https://{SHOPIFY_STORE}/admin/oauth/access_token"


def check_shopify_env() -> list[str]:
    """Return the names of any missing Shopify variables (empty list = OK)."""
    return [
        name
        for name, value in {
            "SHOPIFY_STORE": SHOPIFY_STORE,
            "SHOPIFY_CLIENT_ID": SHOPIFY_CLIENT_ID,
            "SHOPIFY_CLIENT_SECRET": SHOPIFY_CLIENT_SECRET,
        }.items()
        if not value
    ]


def require_shopify_env() -> None:
    """Exit hard if Shopify credentials are missing (used by CLI scripts)."""
    missing = check_shopify_env()
    if missing:
        sys.exit(f"Missing .env variables: {', '.join(missing)}")
