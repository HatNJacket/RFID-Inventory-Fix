"""Access control.

Two ways in, matching the two kinds of users:

1. Shopify admin (embedded app): App Bridge attaches a session-token JWT to
   every request. We verify it ourselves — HS256 signed with the app's
   client secret, audience = client id — no extra dependencies needed.
2. Warehouse stations (browser outside Shopify, and the print agent):
   a shared STATION_KEY sent as an X-Station-Key header (the UI captures it
   once from a ?key=... URL and remembers it).

Enforcement is on only when STATION_KEY is set in the environment, so local
development with a bare .env keeps working with no ceremony.
"""
import base64
import hashlib
import hmac
import json
import time

from fastapi import Header, HTTPException, Request

from app import config


def _b64url_decode(chunk: str) -> bytes:
    return base64.urlsafe_b64decode(chunk + "=" * (-len(chunk) % 4))


def verify_session_token(token: str) -> bool:
    """Verify a Shopify App Bridge session token (JWT, HS256)."""
    if not (config.SHOPIFY_CLIENT_ID and config.SHOPIFY_CLIENT_SECRET):
        return False
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
        expected = hmac.new(
            config.SHOPIFY_CLIENT_SECRET.encode(),
            f"{header_b64}.{payload_b64}".encode(),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
            return False
        payload = json.loads(_b64url_decode(payload_b64))
        if payload.get("aud") != config.SHOPIFY_CLIENT_ID:
            return False
        if payload.get("exp", 0) < time.time():
            return False
        return True
    except Exception:
        return False


def require_user(
    request: Request,
    authorization: str | None = Header(default=None),
    x_station_key: str | None = Header(default=None),
) -> None:
    """FastAPI dependency guarding the app's routes."""
    if not config.STATION_KEY:
        return  # enforcement off (local development)

    if x_station_key and hmac.compare_digest(x_station_key, config.STATION_KEY):
        return
    # The UI bootstraps its stored key from ?key= on page loads.
    url_key = request.query_params.get("key")
    if url_key and hmac.compare_digest(url_key, config.STATION_KEY):
        return
    if authorization and authorization.startswith("Bearer "):
        if verify_session_token(authorization.removeprefix("Bearer ")):
            return
    raise HTTPException(
        401,
        "Not authorized. Open the app from Shopify admin, or use the "
        "station link with the access key.",
    )
