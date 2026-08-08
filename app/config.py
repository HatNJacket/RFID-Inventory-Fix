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
#   "auto" (default) — live bin map first, Shopify API fallback
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

# Access control for everything else. When set, every page/API request must
# carry this key (X-Station-Key header, or ?key= once in the URL) OR a valid
# Shopify session token (embedded admin use). Unset = open, for local dev.
STATION_KEY = os.getenv("STATION_KEY")

# Shopify write protection, enforced server-side (hiding buttons in the
# browser is not enough). New features must never touch the live store
# until explicitly promoted:
#   "scan_station_only" (default) — only the original, individually
#       confirmed Scan Station flows (barcode/SKU/bin edits) may write
#   "disabled"   — no Shopify writes at all (safe development mode)
#   "production" — all confirmed write features enabled
SHOPIFY_WRITE_MODE = os.getenv(
    "SHOPIFY_WRITE_MODE", "scan_station_only"
).strip().lower()

# Read-only bridge to TC-Planner (Steve's purchase-order app). The RFID
# side only ever READS the PO ledger — "is this product on an open order,
# how many are still expected" — never files receipts, changes statuses,
# emails vendors, or pushes stock. Unset token = bridge off; every surface
# that uses it degrades to "no planner info" instead of erroring.
PLANNER_URL = os.getenv(
    "PLANNER_URL", "https://tc-planner-app.azurewebsites.net"
).rstrip("/")
PLANNER_TOKEN = os.getenv("PLANNER_TOKEN")

# Per-operator planner tokens, "Name:token,Name:token" — the same format
# (and the same tokens) as the planner's own TC_PLANNER_USER_TOKENS.
# When the "Who's scanning?" operator has an entry here, planner calls
# carry THEIR token so the planner attributes the action to the person;
# anyone else rides the dedicated RFID token above.
def _parse_user_tokens(raw: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for pair in (raw or "").split(","):
        name, _, tok = pair.strip().partition(":")
        if name.strip() and tok.strip():
            mapping[name.strip().lower()] = tok.strip()
    return mapping


PLANNER_USER_TOKENS = _parse_user_tokens(os.getenv("PLANNER_USER_TOKENS", ""))

# Who can be picked in the UI's operator dropdown, comma-separated.
OPERATORS = [
    name.strip()
    for name in os.getenv("OPERATORS", "Steve,Matt,Clay,Nick").split(",")
    if name.strip()
]

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
