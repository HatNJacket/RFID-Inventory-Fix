"""FastAPI application: pages + JSON API.

Request flow (mirrors what runs on Azure):
  Browser scan -> JS fetch -> FastAPI route -> shopify.py / database -> JSON

No terminal input anywhere. The scanner types into browser fields exactly
as it would type into Notepad, and JavaScript forwards each scan here.
"""
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import bindparam, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.requests import Request

from app import catalog, config, shopify
from app.auth import require_user
from app.database import (
    DatabaseNotConfigured,
    database_configured,
    get_session,
    init_db,
)
from app.models import (
    BarcodeAlias,
    BarcodeChange,
    Batch,
    BatchItem,
    BinMapEntry,
    EpcCapture,
    HiddenBin,
    LabelName,
    PrintJob,
    ReviewTask,
    RfidAssignment,
    SerialPrefix,
)

logger = logging.getLogger("rfid")

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Cache-buster for static assets: changes on every app start (i.e. every
# deploy), so browsers stop serving stale JS/CSS after updates.
ASSET_VERSION = str(int(time.time()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on startup only when a database is configured. Locally,
    # before you provision PostgreSQL, the app still boots and does lookups.
    if database_configured():
        init_db()
        # Warm the bin map (Shopify metafield walk) in the background; the
        # persisted table keeps answering while a refresh runs.
        if not config.check_shopify_env():
            _maybe_refresh_bin_map()
    yield


app = FastAPI(title="RFID Inventory", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.middleware("http")
async def frame_ancestors_for_shopify(request: Request, call_next):
    """Allow the page to be iframed by Shopify admin (embedded app) and
    nothing else."""
    response = await call_next(request)
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Content-Security-Policy"] = (
            "frame-ancestors https://admin.shopify.com https://*.myshopify.com"
        )
        # The page must never be cached: it carries the version-stamped
        # asset URLs, so a cached page pins stale JS/CSS across deploys
        # (the "feature didn't reach the warehouse browser" bug, twice).
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(DatabaseNotConfigured)
def _db_not_configured(request: Request, exc: DatabaseNotConfigured):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=503,
        content={"detail": "Database not configured. Set DATABASE_URL to "
                           "enable saving and listing assignments."},
    )


def require_shopify_write(feature: str = "scan_station") -> None:
    """Server-side Shopify write gate (config.SHOPIFY_WRITE_MODE). All
    current write endpoints are the confirmed Scan Station flows; anything
    new must call this with its own feature name and stays blocked until
    the mode is promoted to 'production'."""
    mode = config.SHOPIFY_WRITE_MODE
    if mode == "disabled":
        raise HTTPException(
            403, "Shopify writes are disabled (SHOPIFY_WRITE_MODE=disabled)."
        )
    if mode != "production" and feature != "scan_station":
        raise HTTPException(
            403,
            f"Shopify write '{feature}' is not enabled yet "
            f"(SHOPIFY_WRITE_MODE={mode}). It only creates proposals for "
            f"the Review tab until promoted.",
        )


# ---------------------------------------------------------------- schemas ---
class AssignmentIn(BaseModel):
    # max_length values mirror the column sizes in models.py so bad input
    # fails as a clear 422 here, not a SQL Server truncation error.
    rfid_id: str = Field(max_length=128)
    shopify_variant_id: str = Field(max_length=64)
    shopify_product_id: str | None = Field(default=None, max_length=300)
    product_title: str = Field(max_length=255)
    variant_title: str | None = Field(default=None, max_length=255)
    sku: str | None = Field(default=None, max_length=100)
    barcode: str | None = Field(default=None, max_length=64)
    bin_location: str | None = Field(default=None, max_length=100)
    assigned_by: str | None = Field(default=None, max_length=100)

    @field_validator("rfid_id", "shopify_variant_id", "product_title")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


# ------------------------------------------------------------------ pages ---
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    missing = config.check_shopify_env()
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "shopify_ready": not missing,
            "missing_env": missing,
            "db_ready": database_configured(),
            "allow_remote_print": config.ALLOW_REMOTE_PRINT,
            "operators": config.OPERATORS,
            "asset_version": ASSET_VERSION,
            # App Bridge only when loaded inside Shopify admin (it adds a
            # 'host' query param); the script is inert/broken outside it.
            "app_bridge_key": (
                config.SHOPIFY_CLIENT_ID
                if request.query_params.get("host")
                else None
            ),
        },
    )


@app.get("/health")
def health():
    return {
        "status": "running",
        "shopify_env_ok": not config.check_shopify_env(),
        "database_configured": database_configured(),
    }


# -------------------------------------------------------------- lookup API ---
def _lookup_db(barcode: str) -> dict | None:
    """TELCAN catalog lookup. Returns None on miss; raises on real errors."""
    from app.database import get_engine

    with Session(get_engine()) as session:
        return catalog.lookup_barcode(session, barcode)


def _lookup_api(barcode: str) -> dict | None:
    product = shopify.lookup_barcode(barcode)
    if product is not None:
        product["source"] = "shopify"
    return product

MISSING_BIN_VALUES = (None, "", "No bin assigned")


def _enrich_bin_from_shopify(
    product: dict,
    lookup_term: str,
    api_ok: bool,
) -> dict:
    """Fill a missing TELCAN bin using the matching Shopify variant."""

    if not api_ok:
        return product

    if product.get("bin_location") not in MISSING_BIN_VALUES:
        return product

    try:
        api_product = shopify.lookup_barcode(lookup_term)

        if (
            api_product
            and api_product.get("bin_location") not in MISSING_BIN_VALUES
        ):
            product["bin_location"] = api_product["bin_location"]

    except RuntimeError as error:
        logger.warning(
            "Shopify bin enrichment failed for %s: %s",
            lookup_term,
            error,
        )

    return product


@app.get(
    "/api/products/by-barcode/{barcode}",
    dependencies=[Depends(require_user)],
)
def product_by_barcode(barcode: str):
    """Barcode-or-SKU -> product (bad/missing barcodes happen, so the same
    field accepts a typed SKU). Source order is config.BARCODE_LOOKUP:
    auto = TELCAN first, Shopify API fallback; or force 'db' / 'api'."""
    barcode = barcode.strip()
    mode = config.BARCODE_LOOKUP
    db_ok = database_configured()
    api_ok = not config.check_shopify_env()
    errors: list[str] = []

    if mode in ("auto", "db") and db_ok:
        try:
            product = _lookup_db(barcode)

            if product is not None:
                return _enrich_bin_from_shopify(
                    product=product,
                    lookup_term=barcode,
                    api_ok=api_ok,
                )

        except Exception as error:
            logger.warning("TELCAN lookup failed: %s", error)
            errors.append(f"TELCAN lookup failed: {error}")

            if mode == "db":
                raise HTTPException(502, errors[-1])

    if mode in ("auto", "api") and api_ok:
        try:
            product = _lookup_api(barcode)
            if product is not None:
                return product
        except RuntimeError as error:
            errors.append(f"Shopify lookup failed: {error}")
            raise HTTPException(502, errors[-1])

    # Not a real barcode/SKU — maybe an operator-linked alias (a foreign
    # barcode, e.g. the manufacturer's, confirmed to mean one of our
    # products). Resolves normally but flagged so the UI can confirm.
    if db_ok:
        from app.database import get_engine

        with Session(get_engine()) as session:
            alias = session.scalar(
                select(BarcodeAlias).where(
                    BarcodeAlias.alias_barcode == barcode
                )
            )
        if alias is not None:
            product = _resolve(alias.sku or alias.barcode, mode, db_ok, api_ok)
            if product is not None:
                product["alias_barcode"] = alias.alias_barcode
                product["alias_warning"] = True
                return product

        # Or a brand serial number whose leading digits identify the
        # product (Astronomik barcodes each unit's serial; the first 4
        # digits are the item). Length-bounded so ordinary UPC/EAN-13/14
        # retail barcodes never fall in here.
        if barcode.isdigit() and 5 <= len(barcode) <= 12:
            with Session(get_engine()) as session:
                sp = session.get(SerialPrefix, barcode[:4])
            if sp is not None:
                product = _resolve(sp.sku, mode, db_ok, api_ok)
                if product is not None:
                    product["serial_brand"] = sp.brand
                    product["serial_prefix"] = sp.prefix
                    product["serial_number"] = barcode
                    product["serial_item_name"] = sp.item_name
                    product["serial_label"] = (
                        sp.label_name or _default_serial_label(sp.item_name)
                    )
                    # True only when an operator has saved the name — the
                    # UI's auto-print trusts confirmed names, not defaults.
                    product["serial_label_saved"] = sp.label_name is not None
                    if sp.scan_note:
                        product["serial_note"] = sp.scan_note
                    return product
                # Structured detail: the UI prefills its SKU-update flow
                # with the manufacturer's current SKU for this prefix.
                raise HTTPException(
                    404,
                    {
                        "message": (
                            f"Recognized an {sp.brand} serial number "
                            f"(prefix {sp.prefix} = {sp.item_name}), but no "
                            f"product with SKU {sp.sku} exists in the "
                            f"catalog — the store's SKU may be outdated."
                        ),
                        "suggested_sku": sp.sku,
                        "serial_prefix": sp.prefix,
                        "brand": sp.brand,
                    },
                )

    if not db_ok and not api_ok:
        raise HTTPException(
            500, "Neither the database nor Shopify credentials are configured."
        )
    raise HTTPException(404, "No product found for that barcode or SKU.")


def _default_serial_label(item_name: str | None) -> str:
    """Sensible label default from the manufacturer's item name: drop the
    ', Made in Germany' tail, cut at the first parenthesis, drop the leading
    brand word. (Their sizes use decimal commas — '1,25"' — so cutting at
    the first comma would mangle most names.) Operators overwrite this with
    whatever the physical product label actually says."""
    if not item_name:
        return ""
    name = re.sub(r",?\s*made in germany\s*$", "", item_name, flags=re.I)
    name = name.split("(")[0]
    name = re.sub(r"^\s*astronomik\s+", "", name, flags=re.I)
    return name.strip(" ,")


def _resolve(term: str, mode: str, db_ok: bool, api_ok: bool) -> dict | None:
    """Resolve a barcode or SKU without alias/serial handling."""

    if not term:
        return None

    if mode in ("auto", "db") and db_ok:
        try:
            product = _lookup_db(term)

            if product is not None:
                return _enrich_bin_from_shopify(
                    product=product,
                    lookup_term=term,
                    api_ok=api_ok,
                )

        except Exception as error:
            logger.warning("TELCAN lookup failed: %s", error)

    if mode in ("auto", "api") and api_ok:
        try:
            return _lookup_api(term)
        except RuntimeError as error:
            logger.warning("Shopify lookup failed: %s", error)

    return None


# Titles that mark secondary listings — the primary listing should be the
# default pick when one barcode matches several products.
_SECONDARY_TITLE = re.compile(r"open[\s-]?box|used|demo|refurb", re.I)


def _candidate_rank(p: dict) -> tuple:
    title = f"{p.get('product_title') or ''} {p.get('variant_title') or ''}"
    return (1 if _SECONDARY_TITLE.search(title) else 0,)


def products_by_barcode_all(code: str) -> list[dict]:
    """All catalog matches for a barcode, primary listing first. Falls back
    to the single-product resolver chain (alias/serial) when the direct
    barcode search finds nothing."""
    code = code.strip()
    mode = config.BARCODE_LOOKUP
    db_ok = database_configured()
    api_ok = not config.check_shopify_env()
    candidates: list[dict] = []
    if mode in ("auto", "db") and db_ok:
        try:
            from app.database import get_engine

            with Session(get_engine()) as session:
                candidates = catalog.lookup_barcode_all(session, code)
        except Exception as error:
            logger.warning("TELCAN multi-lookup failed: %s", error)
    if not candidates and mode in ("auto", "api") and api_ok:
        try:
            candidates = shopify.lookup_barcode_all(code)
        except Exception as error:
            logger.warning("Shopify multi-lookup failed: %s", error)
    if not candidates:
        try:
            single = product_by_barcode(code)
            if single is not None:
                candidates = [single]
        except HTTPException:
            candidates = []
    # De-dup by variant id (mirror + API can both contribute).
    seen: set = set()
    unique = []
    for p in candidates:
        key = p.get("shopify_variant_id") or p.get("sku")
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    unique.sort(key=_candidate_rank)
    return unique


@app.get(
    "/api/products/candidates", dependencies=[Depends(require_user)]
)
def product_candidates(barcode: str):
    items = products_by_barcode_all(barcode)
    return {"count": len(items), "candidates": items}


@app.get("/api/products/tags", dependencies=[Depends(require_user)])
def tags_for_product(
    sku: str | None = None,
    barcode: str | None = None,
    session: Session = Depends(get_session),
):
    """All RFID tags on file for a product, matched by exact SKU or barcode.
    (Anchored on SKU/barcode because TELCAN and the Shopify API identify
    variants differently; these two fields both sources agree on.)"""
    if not sku and not barcode:
        raise HTTPException(422, "Provide sku or barcode.")
    conditions = []
    if sku:
        conditions.append(RfidAssignment.sku == sku.strip())
    if barcode:
        conditions.append(RfidAssignment.barcode == barcode.strip())
    rows = session.scalars(
        select(RfidAssignment)
        .where(or_(*conditions))
        .order_by(RfidAssignment.assigned_at.desc())
    ).all()
    return {"count": len(rows), "assignments": [r.as_dict() for r in rows]}


# ---------------------------------------------------------- assignment API ---
@app.post(
    "/api/rfid-assignments",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def create_assignment(
    payload: AssignmentIn, session: Session = Depends(get_session)
):
    assignment = RfidAssignment(**payload.model_dump())
    # Every real tag is a 96-bit EPC = 24 hex chars. Anything else is
    # probably a mangled read (e.g. Bluetooth relay dropping characters):
    # save it anyway, but flag it for a re-scan.
    assignment.suspect = (
        re.fullmatch(r"[0-9A-Fa-f]{24}", payload.rfid_id) is None
    )
    session.add(assignment)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            409,
            f"RFID tag {payload.rfid_id} is already assigned. Unassign it "
            f"first to reassign.",
        )
    session.refresh(assignment)
    return assignment.as_dict()


@app.get("/api/rfid-assignments", dependencies=[Depends(require_user)])
def list_assignments(
    q: str | None = None,
    limit: int = 100,
    session: Session = Depends(get_session),
):
    """List assignments, optionally filtered by a free-text query that
    matches EPC, barcode, SKU, or product title."""
    stmt = select(RfidAssignment).order_by(RfidAssignment.assigned_at.desc())
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                RfidAssignment.rfid_id.ilike(like),
                RfidAssignment.barcode.ilike(like),
                RfidAssignment.sku.ilike(like),
                RfidAssignment.product_title.ilike(like),
            )
        )
    stmt = stmt.limit(min(limit, 500))
    rows = session.scalars(stmt).all()
    return {"count": len(rows), "assignments": [r.as_dict() for r in rows]}


@app.get(
    "/api/rfid-assignments/{rfid_id}", dependencies=[Depends(require_user)]
)
def get_assignment(rfid_id: str, session: Session = Depends(get_session)):
    row = session.scalar(
        select(RfidAssignment).where(RfidAssignment.rfid_id == rfid_id.strip())
    )
    if row is None:
        raise HTTPException(404, "No assignment for that RFID tag.")
    return row.as_dict()


@app.delete(
    "/api/rfid-assignments/{rfid_id}",
    status_code=204,
    dependencies=[Depends(require_user)],
)
def unassign(rfid_id: str, session: Session = Depends(get_session)):
    row = session.scalar(
        select(RfidAssignment).where(RfidAssignment.rfid_id == rfid_id.strip())
    )
    if row is None:
        raise HTTPException(404, "No assignment for that RFID tag.")
    session.delete(row)
    session.commit()


# ------------------------------------------------------------ print queue ---
# Any device queues jobs; print_agent.py on the printer laptop claims them,
# drives the Zebra (print + RFID encode in one pass), and reports back.
# Success auto-creates the RfidAssignment — printed labels need no tag scan.

def require_agent_key(x_agent_key: str | None = Header(default=None)):
    """Protects agent endpoints when PRINT_AGENT_KEY is configured."""
    if config.PRINT_AGENT_KEY and x_agent_key != config.PRINT_AGENT_KEY:
        raise HTTPException(401, "Missing or wrong X-Agent-Key header.")


def _new_epc() -> str:
    """Random 96-bit EPC as 24 uppercase hex chars. Uniqueness is enforced
    by the DB; the collision odds on random 96 bits are negligible."""
    return secrets.token_hex(12).upper()


class PrintJobIn(BaseModel):
    quantity: int = Field(default=1, ge=1, le=100)
    shopify_variant_id: str = Field(max_length=64)
    shopify_product_id: str | None = Field(default=None, max_length=300)
    product_title: str = Field(max_length=255)
    variant_title: str | None = Field(default=None, max_length=255)
    sku: str | None = Field(default=None, max_length=100)
    barcode: str | None = Field(default=None, max_length=64)
    bin_location: str | None = Field(default=None, max_length=100)
    other_bins: str | None = Field(default=None, max_length=255)
    label_name: str | None = Field(default=None, max_length=255)
    label_placement: str | None = Field(
        default=None, pattern="^(header|sku|both)$"
    )
    requested_by: str | None = Field(default=None, max_length=100)

    @field_validator("shopify_variant_id", "product_title")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/print-jobs", status_code=201, dependencies=[Depends(require_user)]
)
def create_print_jobs(
    payload: PrintJobIn, session: Session = Depends(get_session)
):
    """Queue N labels for one product; each gets its own EPC."""
    fields = payload.model_dump(exclude={"quantity"})
    jobs = [
        PrintJob(epc=_new_epc(), status="pending", **fields)
        for _ in range(payload.quantity)
    ]
    session.add_all(jobs)
    session.commit()
    for job in jobs:
        session.refresh(job)
    return {"count": len(jobs), "jobs": [j.as_dict() for j in jobs]}


@app.get("/api/print-jobs", dependencies=[Depends(require_user)])
def list_print_jobs(
    status: str | None = None,
    ids: str | None = None,
    batch_id: int | None = None,
    limit: int = 50,
    session: Session = Depends(get_session),
):
    stmt = select(PrintJob).order_by(PrintJob.id.desc())
    if status:
        stmt = stmt.where(PrintJob.status == status.strip())
    if batch_id is not None:
        stmt = stmt.where(PrintJob.batch_id == batch_id)
    if ids:
        try:
            id_list = [int(i) for i in ids.split(",") if i.strip()]
        except ValueError:
            raise HTTPException(422, "ids must be comma-separated integers.")
        stmt = stmt.where(PrintJob.id.in_(id_list))
    rows = session.scalars(stmt.limit(min(limit, 200))).all()
    return {"count": len(rows), "jobs": [j.as_dict() for j in rows]}


# Print-agent heartbeat: the agent polls claim every ~10 s, so a recent
# claim means the printer PC is up. In-memory is fine — after an app
# restart the next poll repopulates it within seconds.
_agent_last_seen: float | None = None


@app.get("/api/print-agent/status", dependencies=[Depends(require_user)])
def print_agent_status():
    seen = _agent_last_seen
    return {
        "online": seen is not None and time.time() - seen < 35,
        "last_seen_seconds": (
            None if seen is None else int(time.time() - seen)
        ),
    }


@app.post("/api/print-jobs/claim", dependencies=[Depends(require_agent_key)])
def claim_print_jobs(
    limit: int = 5, session: Session = Depends(get_session)
):
    """Agent: take the oldest pending jobs and mark them printing."""
    global _agent_last_seen
    _agent_last_seen = time.time()
    rows = session.scalars(
        select(PrintJob)
        .where(PrintJob.status == "pending")
        .order_by(PrintJob.id)
        .limit(min(limit, 20))
    ).all()
    for job in rows:
        job.status = "printing"
    session.commit()
    return {"count": len(rows), "jobs": [j.as_dict() for j in rows]}


@app.post(
    "/api/print-jobs/{job_id}/complete",
    dependencies=[Depends(require_agent_key)],
)
def complete_print_job(
    job_id: int,
    create_assignment: bool = True,
    session: Session = Depends(get_session),
):
    """Agent: label printed OK. With an RFID-encoding printer the EPC was
    written to the tag, so the assignment is auto-created. Non-RFID printers
    (agent --no-rfid) pass create_assignment=false — the label is just a
    barcode, and the tag gets linked later via the normal two-scan flow."""
    job = session.get(PrintJob, job_id)
    if job is None:
        raise HTTPException(404, "No such print job.")
    if job.status not in ("printing", "pending"):
        raise HTTPException(409, f"Job is already {job.status}.")

    job.status = "done"
    job.printed_at = datetime.now(timezone.utc)
    if not create_assignment:
        session.commit()
        return {"job": job.as_dict(), "assignment": None}
    assignment = RfidAssignment(
        rfid_id=job.epc,
        shopify_variant_id=job.shopify_variant_id,
        shopify_product_id=job.shopify_product_id,
        product_title=job.product_title,
        variant_title=job.variant_title,
        sku=job.sku,
        barcode=job.barcode,
        bin_location=job.bin_location,
        assigned_by=job.requested_by or "printer",
    )
    session.add(assignment)
    try:
        session.commit()
    except IntegrityError:
        # EPC already assigned (e.g. a re-run after a crash) — keep the job
        # done; the tag <-> product link already exists.
        session.rollback()
        job = session.get(PrintJob, job_id)
        job.status = "done"
        job.printed_at = datetime.now(timezone.utc)
        session.commit()
        return {"job": job.as_dict(), "assignment": None}
    session.refresh(job)
    session.refresh(assignment)
    return {"job": job.as_dict(), "assignment": assignment.as_dict()}


class PrintJobFail(BaseModel):
    error: str = Field(max_length=500)


@app.post(
    "/api/print-jobs/{job_id}/fail",
    dependencies=[Depends(require_agent_key)],
)
def fail_print_job(
    job_id: int, payload: PrintJobFail, session: Session = Depends(get_session)
):
    job = session.get(PrintJob, job_id)
    if job is None:
        raise HTTPException(404, "No such print job.")
    job.status = "error"
    job.error = payload.error
    session.commit()
    return job.as_dict()


# --------------------------------------------------------- barcode aliases ---
class AliasIn(BaseModel):
    alias_barcode: str = Field(max_length=64)
    target: str = Field(max_length=100)  # the known/internal barcode or SKU
    created_by: str | None = Field(default=None, max_length=100)

    @field_validator("alias_barcode", "target")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/barcode-aliases",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def create_alias(payload: AliasIn, session: Session = Depends(get_session)):
    """Link a foreign barcode to a known product (identified by its real
    barcode or SKU). Returns the alias and the resolved product."""
    db_ok = database_configured()
    api_ok = not config.check_shopify_env()
    mode = config.BARCODE_LOOKUP

    # The alias must not itself be a real barcode/SKU of some product.
    if _resolve(payload.alias_barcode, mode, db_ok, api_ok) is not None:
        raise HTTPException(
            409,
            "That scanned code already matches a real product — it can't "
            "be linked as an alias.",
        )

    product = _resolve(payload.target, mode, db_ok, api_ok)
    if product is None:
        raise HTTPException(404, "No product found for that barcode or SKU.")

    alias = BarcodeAlias(
        alias_barcode=payload.alias_barcode,
        sku=product.get("sku"),
        barcode=product.get("barcode"),
        product_title=product.get("product_title"),
        created_by=payload.created_by,
    )
    session.add(alias)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            409, "That scanned code is already linked to a product."
        )
    session.refresh(alias)
    product["alias_barcode"] = alias.alias_barcode
    return {"alias": alias.as_dict(), "product": product}


@app.delete(
    "/api/barcode-aliases/{alias_barcode}",
    status_code=204,
    dependencies=[Depends(require_user)],
)
def delete_alias(alias_barcode: str, session: Session = Depends(get_session)):
    row = session.scalar(
        select(BarcodeAlias).where(
            BarcodeAlias.alias_barcode == alias_barcode.strip()
        )
    )
    if row is None:
        raise HTTPException(404, "No such linked barcode.")
    session.delete(row)
    session.commit()


# ------------------------------------------------------- serial prefixes ---
class SerialPrefixIn(BaseModel):
    """Register a new 4-digit Astronomik serial prefix -> product link,
    for items missing from the loaded manufacturer sheet."""

    prefix: str = Field(min_length=4, max_length=4)
    target: str = Field(max_length=100)  # known barcode or SKU
    scan_note: str | None = Field(default=None, max_length=255)
    created_by: str | None = Field(default=None, max_length=100)

    @field_validator("prefix")
    @classmethod
    def four_digits(cls, v: str) -> str:
        v = v.strip()
        if not (len(v) == 4 and v.isdigit()):
            raise ValueError("must be exactly 4 digits")
        return v

    @field_validator("target")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.get(
    "/api/serial-prefixes/{prefix}",
    dependencies=[Depends(require_user)],
)
def get_serial_prefix(prefix: str, session: Session = Depends(get_session)):
    """Peek at a prefix — the UI uses the manufacturer sheet's SKU as a
    recommendation when operators fix products."""
    row = session.get(SerialPrefix, prefix.strip())
    if row is None:
        raise HTTPException(404, "No such serial prefix.")
    return row.as_dict()


@app.post(
    "/api/serial-prefixes",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def create_serial_prefix(
    payload: SerialPrefixIn, session: Session = Depends(get_session)
):
    db_ok = database_configured()
    api_ok = not config.check_shopify_env()
    product = _resolve(payload.target, config.BARCODE_LOOKUP, db_ok, api_ok)
    if product is None:
        raise HTTPException(404, "No product found for that barcode or SKU.")

    name = product.get("product_title") or ""
    if product.get("variant_title"):
        name += f" ({product['variant_title']})"
    row = session.get(SerialPrefix, payload.prefix)
    if row is None:
        row = SerialPrefix(prefix=payload.prefix, brand="Astronomik")
        session.add(row)
    row.sku = product.get("sku")
    row.item_name = name[:255]  # label_name untouched if one was saved
    row.scan_note = (payload.scan_note or "").strip() or None
    session.commit()
    return {"serial_prefix": row.as_dict(), "product": product}


# ---------------------------------------------------------- filter sets ---
_FILTER_SET_SQL = text(
    """
    SELECT v.Variant_SKU, v.Variant_Barcode, v.Option1_Value,
           p.Title AS Product_Title
    FROM dbo.Shopify_Variants v
    JOIN dbo.Shopify_Products p ON p.Handle_ID = v.Handle_ID
    WHERE p.Title LIKE '%Astronomik%'
      AND (p.Title LIKE '%RGB%' OR p.Title LIKE '%set%'
           OR p.Title LIKE '%LRGB%' OR p.Title LIKE '%SHO%')
    ORDER BY p.Title, v.Option1_Value
    """
)


@app.get("/api/filter-sets", dependencies=[Depends(require_user)])
def list_filter_sets(session: Session = Depends(get_session)):
    """Candidate multi-filter set products, for the set-registration window
    ("which set might these three filters belong to?")."""
    try:
        rows = session.execute(_FILTER_SET_SQL).all()
    except Exception as error:
        logger.warning("filter-set candidates failed: %s", error)
        return {"count": 0, "sets": []}
    sets = [
        {
            "sku": r.Variant_SKU,
            "barcode": r.Variant_Barcode,
            "variant": r.Option1_Value,
            "title": r.Product_Title,
        }
        for r in rows
    ]
    return {"count": len(sets), "sets": sets}


class FilterSetIn(BaseModel):
    """Register a 3-box filter set: three component serials (Red, Green,
    Blue order) all mapped to one set product."""

    serials: list[str] = Field(min_length=3, max_length=3)
    target: str = Field(max_length=100)  # the set's SKU or barcode
    created_by: str | None = Field(default=None, max_length=100)

    @field_validator("serials")
    @classmethod
    def serial_shaped(cls, v: list[str]) -> list[str]:
        v = [s.strip() for s in v]
        for s in v:
            if not (s.isdigit() and 5 <= len(s) <= 12):
                raise ValueError(f"'{s}' doesn't look like a serial number")
        if len({s[:4] for s in v}) != 3:
            raise ValueError(
                "the three serials must have three different prefixes — "
                "was the same filter scanned twice?"
            )
        return v

    @field_validator("target")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/filter-sets/register",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def register_filter_set(
    payload: FilterSetIn, session: Session = Depends(get_session)
):
    db_ok = database_configured()
    api_ok = not config.check_shopify_env()
    product = _resolve(payload.target, config.BARCODE_LOOKUP, db_ok, api_ok)
    if product is None:
        raise HTTPException(404, "No product found for that barcode or SKU.")

    name = product.get("product_title") or ""
    if product.get("variant_title"):
        name += f" ({product['variant_title']})"
    prefixes = [s[:4] for s in payload.serials]
    note = (
        f"Part of the SET: {name} — 3 boxes "
        f"(R={prefixes[0]}, G={prefixes[1]}, B={prefixes[2]}). "
        f"Apply ONE tag to the set, not one per filter."
    )[:255]
    for prefix, color in zip(prefixes, ("Red", "Green", "Blue")):
        row = session.get(SerialPrefix, prefix)
        if row is None:
            row = SerialPrefix(prefix=prefix, brand="Astronomik")
            session.add(row)
        row.sku = product.get("sku")
        row.item_name = f"{name} ({color} component)"[:255]
        row.scan_note = note
    session.commit()
    return {"product": product, "prefixes": prefixes}


# -------------------------------------------------------- serial labels ---
class SerialLabelIn(BaseModel):
    label_name: str = Field(max_length=255)

    @field_validator("label_name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.put(
    "/api/serial-prefixes/{prefix}/label",
    dependencies=[Depends(require_user)],
)
def set_serial_label(
    prefix: str, payload: SerialLabelIn, session: Session = Depends(get_session)
):
    """Save the operator's preferred label name for a serial prefix (what
    prints at the top of that product's labels)."""
    row = session.get(SerialPrefix, prefix.strip())
    if row is None:
        raise HTTPException(404, "No such serial prefix.")
    row.label_name = payload.label_name
    session.commit()
    return row.as_dict()


# ------------------------------------------------------ barcode overwrite ---
class OverwriteIn(BaseModel):
    """Adopt a scanned (manufacturer) barcode as the product's REAL barcode,
    replacing the one in Shopify."""

    new_barcode: str = Field(max_length=64)
    target: str = Field(max_length=100)  # current barcode or SKU
    changed_by: str | None = Field(default=None, max_length=100)
    confirmed: bool = False  # the UI checkbox; server refuses without it

    @field_validator("new_barcode", "target")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/barcode-overwrites",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def overwrite_barcode(
    payload: OverwriteIn, session: Session = Depends(get_session)
):
    """Replace a product's barcode in Shopify with the scanned one, and log
    who did it and when. TELCAN's mirror catches up on its next sync; until
    then the Shopify-API lookup fallback resolves the new barcode."""
    if not payload.confirmed:
        raise HTTPException(
            422, "Confirmation checkbox is required for barcode replacement."
        )
    require_shopify_write("scan_station")
    if config.check_shopify_env():
        raise HTTPException(500, "Shopify credentials are not configured.")

    db_ok = database_configured()
    if _resolve(payload.new_barcode, config.BARCODE_LOOKUP, db_ok, True):
        raise HTTPException(
            409,
            "That scanned code already belongs to a product — it can't "
            "replace another product's barcode.",
        )

    # Must resolve via the Shopify API: the mutation needs real Shopify ids,
    # which the TELCAN mirror doesn't store.
    try:
        product = _lookup_api(payload.target)
    except RuntimeError as error:
        raise HTTPException(502, f"Shopify lookup failed: {error}")
    if product is None:
        raise HTTPException(
            404, "No product found in Shopify for that barcode or SKU."
        )

    try:
        shopify.update_variant_barcode(
            product["shopify_product_id"],
            product["shopify_variant_id"],
            payload.new_barcode,
        )
    except RuntimeError as error:
        raise HTTPException(502, f"Shopify barcode update failed: {error}")

    change = BarcodeChange(
        sku=product.get("sku"),
        product_title=product.get("product_title"),
        shopify_variant_id=product.get("shopify_variant_id"),
        old_barcode=product.get("barcode"),
        new_barcode=payload.new_barcode,
        changed_by=payload.changed_by,
    )
    session.add(change)
    # If this code was previously linked as an alias, the link is now
    # redundant (and would shadow nothing, but keep the table honest).
    stale_alias = session.scalar(
        select(BarcodeAlias).where(
            BarcodeAlias.alias_barcode == payload.new_barcode
        )
    )
    if stale_alias is not None:
        session.delete(stale_alias)
    session.commit()
    session.refresh(change)

    product["barcode"] = payload.new_barcode
    return {"change": change.as_dict(), "product": product}


class BinUpdateIn(BaseModel):
    """Set a product's bin location (Shopify stock.bin metafield)."""

    target: str = Field(max_length=100)  # barcode or SKU
    bin: str = Field(max_length=100)
    changed_by: str | None = Field(default=None, max_length=100)

    @field_validator("target", "bin")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/bin-updates",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def update_bin(payload: BinUpdateIn, session: Session = Depends(get_session)):
    require_shopify_write("scan_station")
    if config.check_shopify_env():
        raise HTTPException(500, "Shopify credentials are not configured.")
    # Shopify API resolution: the metafield write needs the variant GID.
    try:
        product = _lookup_api(payload.target)
    except RuntimeError as error:
        raise HTTPException(502, f"Shopify lookup failed: {error}")
    if product is None:
        raise HTTPException(
            404, "No product found in Shopify for that barcode or SKU."
        )
    try:
        shopify.set_variant_bin(product["shopify_variant_id"], payload.bin)
    except RuntimeError as error:
        raise HTTPException(502, f"Shopify bin update failed: {error}")

    session.add(BarcodeChange(
        sku=product.get("sku"),
        product_title=product.get("product_title"),
        shopify_variant_id=product.get("shopify_variant_id"),
        changed_field="bin",
        old_barcode=(product.get("bin_location") or "")[:64] or None,
        new_barcode=payload.bin[:64],
        changed_by=payload.changed_by,
    ))
    session.commit()

    product["bin_location"] = payload.bin
    return {"product": product}


class SkuOverwriteIn(BaseModel):
    """Replace a product's SKU in Shopify (e.g. store SKU is outdated vs
    the manufacturer's current item number)."""

    new_sku: str = Field(max_length=100)
    target: str = Field(max_length=100)  # current barcode or SKU
    changed_by: str | None = Field(default=None, max_length=100)
    confirmed: bool = False

    @field_validator("new_sku", "target")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/sku-overwrites",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def overwrite_sku(
    payload: SkuOverwriteIn, session: Session = Depends(get_session)
):
    if not payload.confirmed:
        raise HTTPException(
            422, "Confirmation checkbox is required for SKU replacement."
        )
    require_shopify_write("scan_station")
    if config.check_shopify_env():
        raise HTTPException(500, "Shopify credentials are not configured.")

    db_ok = database_configured()
    if _resolve(payload.new_sku, config.BARCODE_LOOKUP, db_ok, True):
        raise HTTPException(
            409,
            "That SKU already belongs to a product — it can't replace "
            "another product's SKU.",
        )

    try:
        product = _lookup_api(payload.target)
    except RuntimeError as error:
        raise HTTPException(502, f"Shopify lookup failed: {error}")
    if product is None:
        raise HTTPException(
            404, "No product found in Shopify for that barcode or SKU."
        )

    try:
        shopify.update_variant_sku(
            product["shopify_product_id"],
            product["shopify_variant_id"],
            payload.new_sku,
        )
    except RuntimeError as error:
        raise HTTPException(502, f"Shopify SKU update failed: {error}")

    old_sku = product.get("sku")
    session.add(BarcodeChange(
        sku=payload.new_sku,
        product_title=product.get("product_title"),
        shopify_variant_id=product.get("shopify_variant_id"),
        changed_field="sku",
        old_barcode=old_sku,
        new_barcode=payload.new_sku,
        changed_by=payload.changed_by,
    ))
    # Serial prefixes that pointed at the old SKU follow the product.
    if old_sku:
        for row in session.scalars(
            select(SerialPrefix).where(SerialPrefix.sku == old_sku)
        ):
            row.sku = payload.new_sku
    session.commit()

    product["sku"] = payload.new_sku
    return {"product": product}


@app.get("/api/barcode-overwrites", dependencies=[Depends(require_user)])
def list_barcode_overwrites(
    limit: int = 100, session: Session = Depends(get_session)
):
    rows = session.scalars(
        select(BarcodeChange)
        .order_by(BarcodeChange.id.desc())
        .limit(min(limit, 500))
    ).all()
    return {"count": len(rows), "changes": [c.as_dict() for c in rows]}


# -------------------------------------------------------- inventory view ---
# Live-quantity cache: refreshing on every tab visit is the useful moment,
# but scan sessions reload the tab constantly — cache briefly.
_qty_cache: dict = {"key": None, "at": 0.0, "data": {}}
_QTY_CACHE_TTL = 120  # seconds


def _live_quantities(skus: list[str]) -> dict[str, int]:
    key = tuple(sorted(skus))
    now = time.time()
    if _qty_cache["key"] == key and now - _qty_cache["at"] < _QTY_CACHE_TTL:
        return _qty_cache["data"]
    data = shopify.get_quantities_by_skus(skus)
    _qty_cache.update(key=key, at=now, data=data)
    return data


@app.get("/api/inventory/summary", dependencies=[Depends(require_user)])
def inventory_summary(session: Session = Depends(get_session)):
    """One row per product in the RFID system: identity, bin, tag count,
    newest tag date — plus current Shopify quantity from the TELCAN mirror
    when available, so tag counts can be eyeballed against stock levels."""
    rows = session.execute(
        select(
            RfidAssignment.sku,
            RfidAssignment.barcode,
            func.max(RfidAssignment.product_title).label("product_title"),
            func.max(RfidAssignment.variant_title).label("variant_title"),
            func.max(RfidAssignment.bin_location).label("bin_location"),
            func.count().label("tag_count"),
            func.max(RfidAssignment.assigned_at).label("last_assigned_at"),
        ).group_by(RfidAssignment.sku, RfidAssignment.barcode)
    ).all()

    products = [
        {
            "sku": r.sku,
            "barcode": r.barcode,
            "product_title": r.product_title,
            "variant_title": r.variant_title,
            "bin_location": r.bin_location,
            "tag_count": r.tag_count,
            "last_assigned_at": (
                r.last_assigned_at.isoformat() if r.last_assigned_at else None
            ),
            "shopify_qty": None,
        }
        for r in rows
    ]
    products.sort(key=lambda p: p["last_assigned_at"] or "", reverse=True)

    # Enrich with live stock counts from the TELCAN catalog mirror.
    skus = [p["sku"] for p in products if p["sku"]]
    if skus and session.get_bind().dialect.name == "mssql":
        try:
            qty_rows = session.execute(
                text(
                    "SELECT Variant_SKU, MAX(Variant_Inventory_Qty) AS qty "
                    "FROM dbo.Shopify_Variants "
                    "WHERE Variant_SKU IN :skus GROUP BY Variant_SKU"
                ).bindparams(bindparam("skus", expanding=True)),
                {"skus": skus},
            ).all()
            qty_by_sku = {r.Variant_SKU: r.qty for r in qty_rows}
            for p in products:
                p["shopify_qty"] = qty_by_sku.get(p["sku"])
        except Exception as error:
            logger.warning("inventory qty enrichment failed: %s", error)

    # Overlay live Shopify quantities (the mirror lags its sync schedule);
    # mirror values remain as the fallback when the API is unreachable.
    if skus and not config.check_shopify_env():
        try:
            live = _live_quantities(skus)
            for p in products:
                if p["sku"] in live:
                    p["shopify_qty"] = live[p["sku"]]
        except RuntimeError as error:
            logger.warning("live quantity fetch failed: %s", error)

    return {"count": len(products), "products": products}


@app.post(
    "/api/print-jobs/{job_id}/cancel", dependencies=[Depends(require_user)]
)
def cancel_print_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(PrintJob, job_id)
    if job is None:
        raise HTTPException(404, "No such print job.")
    if job.status != "pending":
        raise HTTPException(409, f"Only pending jobs can be canceled "
                                 f"(job is {job.status}).")
    job.status = "canceled"
    session.commit()
    return job.as_dict()


# ------------------------------------------------------------ bin batches ---
# The warehouse walk-around workflow (Batch Tagging tab):
#   collect (scan every box at a bin) -> prepare labels -> print (queue)
#   -> pair (barcode selects product, EPC scans attach) -> verify -> done.
# Batches only OBSERVE — no Shopify writes anywhere in this flow. Count and
# bin mismatches become ReviewTasks at completion, never live edits.

# --- Bin map: which bin each variant lives in (Shopify metafields) --------
# Rebuilt by a daemon thread (full catalog walk, ~1 min); the table itself
# persists across restarts so reads never wait on the walk.
import threading

_BIN_MAP_TTL = 6 * 60 * 60  # refresh when older than 6 hours
_bin_map_state = {"checked_at": 0.0, "running": False}
_bin_map_lock = threading.Lock()


def _rebuild_bin_map() -> None:
    from app.database import get_engine

    try:
        # Entries carry LIVE on-hand straight from Shopify inventory levels
        # (never the TELCAN mirror's quantities — its sync can stall for
        # months and it burned us once with 8-month-old numbers).
        entries = shopify.fetch_all_variant_bins()
        with Session(get_engine()) as session:
            # Serialize rewrites across gunicorn workers: without this,
            # two workers booting onto a stale map both insert and the
            # table doubles.
            if session.get_bind().dialect.name == "mssql":
                session.execute(text(
                    "EXEC sp_getapplock @Resource='rfid_bin_map_rebuild', "
                    "@LockMode='Exclusive', @LockOwner='Transaction', "
                    "@LockTimeout=120000"
                ))
            session.query(BinMapEntry).delete()
            rows = []
            for e in entries:
                # A product split across shelves ("G2-1 & B17") belongs to
                # BOTH bins — one row each, each naming the others.
                bins = parse_bins(e["bin"]) or [e["bin"]]
                for name in bins:
                    others = [b for b in bins if b != name]
                    rows.append(BinMapEntry(
                        sku=e["sku"],
                        barcode=e["barcode"],
                        product_title=(e["product_title"] or "")[:255] or None,
                        variant_title=(e["variant_title"] or "")[:255] or None,
                        shopify_variant_id=e["shopify_variant_id"],
                        shopify_product_id=e["shopify_product_id"],
                        bin=name[:100],
                        other_bins=(", ".join(others))[:255] or None,
                        qty=e["qty"],
                        image_url=(e.get("image_url") or "")[:500] or None,
                    ))
            session.add_all(rows)
            session.commit()
        logger.info("bin map rebuilt: %d binned variants -> %d bin rows",
                    len(entries), len(rows))
    except Exception as error:
        logger.warning("bin map rebuild failed: %s", error)
    finally:
        with _bin_map_lock:
            _bin_map_state["running"] = False


def _bin_map_age(session: Session) -> float | None:
    """Seconds since the newest entry; None when the table is empty."""
    newest = session.scalar(select(func.max(BinMapEntry.updated_at)))
    if newest is None:
        return None
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - newest).total_seconds()


def _maybe_refresh_bin_map(force: bool = False,
                           max_age: float | None = None) -> bool:
    """Kick a background rebuild when the map is stale/empty. Returns True
    if a rebuild is running after the call. `max_age` overrides the normal
    TTL — batch start uses a short one so bin edits land quickly."""
    if config.check_shopify_env() or not database_configured():
        return False
    with _bin_map_lock:
        if _bin_map_state["running"]:
            return True
        try:
            from app.database import get_engine

            with Session(get_engine()) as session:
                age = _bin_map_age(session)
        except Exception as error:
            logger.warning("bin map age check failed: %s", error)
            return False
        ttl = _BIN_MAP_TTL if max_age is None else max_age
        if not force and age is not None and age < ttl:
            return False
        _bin_map_state["running"] = True
    threading.Thread(target=_rebuild_bin_map, daemon=True).start()
    return True


# Some products are one sellable item split across shelves, and the bin
# field says so: "G2-1 & B17", "MOUNT: B18-1, BATTERY: G1-4",
# "SCOPE: B17-2, TOOL: G3-2, KIT: G3-2". Each of those is a real bin the
# product legitimately lives in.
_BIN_SPLIT_RE = re.compile(r"\s*(?:[&,;/+]|\band\b)\s*", re.I)


def parse_bins(value: str | None) -> list[str]:
    """Every bin named in a bin field, in order, de-duplicated. Part
    labels ("MOUNT: B18-1") are dropped — the shelf code is what matters."""
    if not value:
        return []
    bins: list[str] = []
    seen: set = set()
    for part in _BIN_SPLIT_RE.split(str(value)):
        part = part.strip()
        if not part:
            continue
        if ":" in part:  # "MOUNT: B18-1" -> "B18-1"
            part = part.rsplit(":", 1)[-1].strip()
        if not part or part.lower() == "no bin assigned":
            continue
        if part.lower() not in seen:
            seen.add(part.lower())
            bins.append(part)
    return bins


def bin_contains(value: str | None, wanted: str) -> bool:
    """Is `wanted` one of the bins this product lives in?"""
    target = (wanted or "").strip().lower()
    return any(b.lower() == target for b in parse_bins(value))


def bins_other_than(value: str | None, wanted: str) -> list[str]:
    target = (wanted or "").strip().lower()
    return [b for b in parse_bins(value) if b.lower() != target]


# A well-formed bin is one letter + 1-99, a dash, then 1-99 (D2-2, E14-3).
# Anything else — extra letters like "B19B-2", missing parts, stray text —
# usually means one product's stock is split across shelves, which needs
# sorting out in Shopify before that bin can be tagged cleanly.
_BIN_NAME_RE = re.compile(r"[A-Za-z](?:[1-9]|[1-9][0-9])-(?:[1-9]|[1-9][0-9])")


@app.get("/api/bins/overview", dependencies=[Depends(require_user)])
def bins_overview(recent: int = 8, session: Session = Depends(get_session)):
    """Every bin in the store (from the Shopify bin map) split into
    still-to-do and recently finished, so Batch Tagging can offer a work
    list instead of an empty box."""
    counts = session.execute(
        select(BinMapEntry.bin, func.count())
        .where(BinMapEntry.bin.isnot(None))
        .group_by(BinMapEntry.bin)
    ).all()

    last_done: dict = {}
    open_by_bin: dict = {}
    done_batches: list = []
    for b in session.scalars(select(Batch).order_by(Batch.id)):
        key = (b.bin_name or "").strip().lower()
        if b.status == "done":
            last_done[key] = b
            done_batches.append(b)
        elif b.status != "abandoned":
            open_by_bin[key] = b

    # Box/tag totals for the recent list.
    recent_batches = sorted(
        done_batches,
        key=lambda b: (_aware(b.completed_at) or datetime.min.replace(
            tzinfo=timezone.utc)),
        reverse=True,
    )[: max(1, min(recent, 20))]
    totals: dict = {}
    if recent_batches:
        for r in session.execute(
            select(
                BatchItem.batch_id,
                func.count().label("products"),
                func.sum(BatchItem.qty_scanned).label("boxes"),
                func.sum(BatchItem.paired_count).label("tags"),
            )
            .where(BatchItem.batch_id.in_([b.id for b in recent_batches]))
            .group_by(BatchItem.batch_id)
        ):
            totals[r.batch_id] = r

    hidden = {
        (h.bin or "").strip().lower()
        for h in session.scalars(select(HiddenBin))
    }

    todo = []
    done_bins = 0
    malformed_total = 0
    for name, products in counts:
        key = (name or "").strip().lower()
        if not key:
            continue
        odd_name = _BIN_NAME_RE.fullmatch((name or "").strip()) is None
        if odd_name:
            malformed_total += 1
        if key in last_done:
            done_bins += 1
            continue
        openb = open_by_bin.get(key)
        todo.append({
            "bin": name,
            "products": products,
            "open_batch_id": openb.id if openb else None,
            "hidden": key in hidden,
            "malformed": odd_name,
        })
    # Bins already in progress first, then the biggest jobs.
    todo.sort(key=lambda b: (b["open_batch_id"] is None, -b["products"],
                             b["bin"]))

    return {
        "total_bins": len(counts),
        "done_bins": done_bins,
        "todo_count": sum(1 for b in todo if not b["hidden"]),
        "hidden_count": sum(1 for b in todo if b["hidden"]),
        "malformed_count": malformed_total,
        "todo": todo,
        "recent": [
            {
                "batch_id": b.id,
                "bin": b.bin_name,
                "completed_at": (
                    b.completed_at.isoformat() if b.completed_at else None
                ),
                "by": b.created_by,
                "products": totals[b.id].products if b.id in totals else 0,
                "boxes": int(totals[b.id].boxes or 0) if b.id in totals else 0,
                "tags": int(totals[b.id].tags or 0) if b.id in totals else 0,
            }
            for b in recent_batches
        ],
    }


class HideBinIn(BaseModel):
    hidden: bool = True
    hidden_by: str | None = Field(default=None, max_length=100)


@app.put(
    "/api/bins/{bin_name}/hidden", dependencies=[Depends(require_user)]
)
def set_bin_hidden(
    bin_name: str,
    payload: HideBinIn,
    session: Session = Depends(get_session),
):
    """Tick a bin off the work list (or put it back). Local only — the bin
    and its products are untouched, it just stops nagging."""
    name = bin_name.strip()
    if not name:
        raise HTTPException(422, "Bin required.")
    row = session.get(HiddenBin, name)
    if payload.hidden:
        if row is None:
            session.add(HiddenBin(bin=name, hidden_by=payload.hidden_by))
    elif row is not None:
        session.delete(row)
    session.commit()
    return {"bin": name, "hidden": payload.hidden}


@app.get(
    "/api/bins/{bin_name}/odd-barcodes", dependencies=[Depends(require_user)]
)
def bin_odd_barcodes(
    bin_name: str,
    scanned: str | None = None,
    session: Session = Depends(get_session),
):
    """Products in a bin whose Shopify barcode isn't a real 13-digit code —
    the usual reason a box scans as unresolved (the barcode field was left
    as the SKU or a placeholder). Prime suspects first: barcode identical
    to the SKU, then blank, then other odd lengths.

    `scanned` (the code that wouldn't resolve) also returns `recommended`:
    a product whose SKU matches it exactly."""
    rows = session.scalars(
        select(BinMapEntry)
        .where(func.lower(BinMapEntry.bin) == bin_name.strip().lower())
        .order_by(BinMapEntry.product_title)
    ).all()

    def odd(entry) -> bool:
        bc = (entry.barcode or "").strip()
        return not (len(bc) == 13 and bc.isdigit())

    def rank(entry) -> tuple:
        bc = (entry.barcode or "").strip()
        sku = (entry.sku or "").strip()
        if bc and sku and bc.lower() == sku.lower():
            return (0,)  # barcode field holds the SKU — classic placeholder
        if not bc:
            return (1,)
        return (2,)

    candidates = sorted([e for e in rows if odd(e)], key=rank)
    payload = [
        {
            "shopify_variant_id": e.shopify_variant_id,
            "shopify_product_id": e.shopify_product_id,
            "product_title": e.product_title,
            "variant_title": e.variant_title,
            "sku": e.sku,
            "barcode": e.barcode,
            "bin_location": e.bin,
            "image_url": e.image_url,
            "reason": (
                "barcode is the SKU" if rank(e) == (0,)
                else "no barcode set" if rank(e) == (1,)
                else "barcode isn't 13 digits"
            ),
        }
        for e in candidates
    ]
    recommended = None
    if scanned:
        term = scanned.strip().lower()
        recommended = next(
            (p for p in payload if (p["sku"] or "").lower() == term), None
        )
    return {
        "count": len(payload),
        "candidates": payload,
        "recommended": recommended,
    }


class BinCheckIn(BaseModel):
    epcs: list[str] = Field(default_factory=list, max_length=5000)


@app.post("/api/bins/{bin_name}/check", dependencies=[Depends(require_user)])
def bin_check(
    bin_name: str,
    payload: BinCheckIn,
    session: Session = Depends(get_session),
):
    """What a sweep says about ANY bin: for every product Shopify expects
    there, how many of its tags on file were detected. Read-only."""
    swept = {(e or "").strip().upper() for e in payload.epcs if e}
    rows = session.scalars(
        select(BinMapEntry)
        .where(func.lower(BinMapEntry.bin) == bin_name.strip().lower())
        .order_by(BinMapEntry.product_title)
    ).all()
    report = []
    for e in rows:
        if not e.sku:
            continue
        tags = session.scalars(
            select(RfidAssignment).where(RfidAssignment.sku == e.sku)
        ).all()
        detected = [t for t in tags if t.rfid_id.upper() in swept]
        report.append({
            "sku": e.sku,
            "product_title": e.product_title,
            "variant_title": e.variant_title,
            "image_url": e.image_url,
            "expected_qty": e.qty,
            "tags_on_file": len(tags),
            "detected": len(detected),
        })
    return {
        "bin": bin_name.strip(),
        "swept": len(swept),
        "count": len(report),
        "items": report,
    }


@app.post("/api/bin-map/refresh", dependencies=[Depends(require_user)])
def bin_map_refresh():
    """Force a full re-read of every product's bin from Shopify. Takes
    ~a minute in the background; poll /api/bin-map/status for progress."""
    started = _maybe_refresh_bin_map(force=True)
    return {"refreshing": started}


@app.get("/api/bin-map/status", dependencies=[Depends(require_user)])
def bin_map_status(session: Session = Depends(get_session)):
    age = _bin_map_age(session)
    return {
        "entries": session.scalar(
            select(func.count()).select_from(BinMapEntry)
        ),
        "age_minutes": None if age is None else int(age / 60),
        "refreshing": _bin_map_state["running"],
    }


def _get_batch(session: Session, batch_id: int) -> Batch:
    batch = session.get(Batch, batch_id)
    if batch is None:
        raise HTTPException(404, "No such batch.")
    return batch


def _batch_items(session: Session, batch_id: int) -> list[BatchItem]:
    return session.scalars(
        select(BatchItem)
        .where(BatchItem.batch_id == batch_id)
        .order_by(BatchItem.id)
    ).all()


def _mirror_qty(session: Session, sku: str | None) -> int | None:
    """Expected shelf count for one SKU: LIVE Shopify on-hand first (the
    mirror's quantities proved stale by months), mirror as the fallback
    when the API is unreachable."""
    if not sku:
        return None
    if not config.check_shopify_env():
        try:
            live = shopify.get_on_hand(sku)
            if live is not None:
                return live
        except Exception as error:
            logger.warning("live on-hand failed for %s: %s", sku, error)
    if session.get_bind().dialect.name != "mssql":
        return None
    try:
        row = session.execute(
            text(
                "SELECT MAX(i.On_Hand_Current) AS oh, "
                "       MAX(v.Variant_Inventory_Qty) AS avail "
                "FROM dbo.Shopify_Variants v "
                "LEFT JOIN dbo.Shopify_Inventory i "
                "  ON i.Handle_ID = v.Handle_ID "
                " AND i.Variant_SKU = v.Variant_SKU "
                "WHERE v.Variant_SKU = :sku"
            ),
            {"sku": sku},
        ).first()
        if row is None:
            return None
        return row.oh if row.oh is not None else row.avail
    except Exception as error:
        logger.warning("mirror qty lookup failed for %s: %s", sku, error)
        return None


class BatchIn(BaseModel):
    bin: str = Field(max_length=100)
    created_by: str | None = Field(default=None, max_length=100)

    @field_validator("bin")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/batches", status_code=201, dependencies=[Depends(require_user)]
)
def create_batch(payload: BatchIn, session: Session = Depends(get_session)):
    """Start a bin batch pre-seeded with everything Shopify expects in that
    bin (0/N tickers before the first scan). Scanning products not on the
    list still adds them — the seed is a head start, not a wall."""
    batch = Batch(bin_name=payload.bin, created_by=payload.created_by)
    session.add(batch)
    session.flush()

    # Expected products come from the bin map (Shopify metafields cache —
    # the mirror's Bin_Name column is empty store-wide).
    _maybe_refresh_bin_map()  # background top-up when stale; reads go on
    expected: list[dict] = []
    try:
        rows = session.scalars(
            select(BinMapEntry)
            .where(func.lower(BinMapEntry.bin) == payload.bin.lower())
            .order_by(BinMapEntry.product_title, BinMapEntry.sku)
        ).all()
        seen_variants: set = set()
        for r in rows:
            key = r.sku or r.barcode or r.shopify_variant_id
            if key in seen_variants:  # belt-and-braces vs duplicate rows
                continue
            seen_variants.add(key)
            expected.append({
                "shopify_variant_id": r.shopify_variant_id,
                "shopify_product_id": r.shopify_product_id,
                "product_title": r.product_title,
                "variant_title": r.variant_title,
                "sku": r.sku,
                "barcode": r.barcode,
                "bin_location": r.bin,
                "other_bins": r.other_bins,
                "expected_qty": r.qty,
                "image_url": r.image_url,
            })
    except Exception as error:
        logger.warning("bin pre-seed failed for %s: %s", payload.bin, error)

    # The bin map is a cache; starting a batch is exactly when it must be
    # THIS minute's truth. Re-check every seeded product live: refresh its
    # count, and drop it if its bin has since changed in Shopify.
    #
    # (Products that moved INTO this bin can't be found this way — Shopify
    # can't search variants by metafield value — so a background rebuild is
    # kicked off too, and scanning such a box adds it correctly anyway.)
    if expected and not config.check_shopify_env():
        try:
            live = shopify.get_stock_info_by_skus(
                [p["sku"] for p in expected if p.get("sku")]
            )
            wanted = payload.bin.strip().lower()
            fresh = []
            moved = []
            for p in expected:
                info = live.get(p.get("sku") or "")
                if info is None:
                    fresh.append(p)
                    continue
                p["expected_qty"] = info["on_hand"]
                actual = (info["bin"] or "").strip()
                # Multi-bin products legitimately live here AND elsewhere.
                if actual and not bin_contains(actual, wanted):
                    moved.append(f"{p.get('sku')}→{actual}")
                    continue
                if actual:
                    others = bins_other_than(actual, wanted)
                    p["other_bins"] = ", ".join(others) if others else None
                fresh.append(p)
            if moved:
                logger.info("bin %s: %d product(s) moved since the map was "
                            "built: %s", payload.bin, len(moved),
                            ", ".join(moved[:10]))
            expected = fresh
        except Exception as error:
            logger.warning("live bin/stock refresh failed for bin %s: %s",
                           payload.bin, error)
    # Keep the map itself moving so newly-arrived products show up soon.
    _maybe_refresh_bin_map(max_age=900)

    # Serialized brands print their operator-confirmed name; grab any
    # prefix rows for the seeded SKUs in one query.
    sp_by_sku: dict[str, SerialPrefix] = {}
    skus = [p["sku"] for p in expected if p.get("sku")]
    if skus:
        for sp in session.scalars(
            select(SerialPrefix).where(SerialPrefix.sku.in_(skus))
        ):
            sp_by_sku.setdefault(sp.sku, sp)

    items = []
    for p in expected:
        sp = sp_by_sku.get(p.get("sku") or "")
        items.append(BatchItem(
            batch_id=batch.id,
            scanned_code=(p.get("barcode") or p.get("sku") or "")[:64],
            resolved=True,
            shopify_variant_id=p.get("shopify_variant_id"),
            shopify_product_id=p.get("shopify_product_id"),
            product_title=p.get("product_title"),
            variant_title=p.get("variant_title"),
            sku=p.get("sku"),
            barcode=p.get("barcode"),
            bin_location=p.get("bin_location"),
            other_bins=(p.get("other_bins") or "")[:255] or None,
            serial_prefix=sp.prefix if sp else None,
            image_url=(p.get("image_url") or "")[:500] or None,
            # Batch labels use the standard store header + SKU; Astronomik
            # item names are set in Scan Station, not here.
            label_name=None,
            qty_scanned=0,
            expected_qty=p.get("expected_qty"),
        ))
    session.add_all(items)
    session.commit()
    session.refresh(batch)
    for item in items:
        session.refresh(item)
    result = batch.as_dict()
    result["items"] = [i.as_dict() for i in items]
    return result


@app.get("/api/batches", dependencies=[Depends(require_user)])
def list_batches(
    status: str | None = None,
    limit: int = 20,
    session: Session = Depends(get_session),
):
    stmt = select(Batch).order_by(Batch.id.desc())
    if status == "open":
        stmt = stmt.where(Batch.status.notin_(("done", "abandoned")))
    elif status:
        stmt = stmt.where(Batch.status == status.strip())
    rows = session.scalars(stmt.limit(min(limit, 100))).all()
    totals = {}
    if rows:
        for r in session.execute(
            select(
                BatchItem.batch_id,
                func.count().label("products"),
                func.sum(BatchItem.qty_scanned).label("boxes"),
                func.sum(BatchItem.paired_count).label("paired"),
            )
            .where(BatchItem.batch_id.in_([b.id for b in rows]))
            .group_by(BatchItem.batch_id)
        ).all():
            totals[r.batch_id] = r
    batches = []
    for b in rows:
        d = b.as_dict()
        t = totals.get(b.id)
        d["products"] = t.products if t else 0
        d["boxes"] = int(t.boxes or 0) if t else 0
        d["paired"] = int(t.paired or 0) if t else 0
        batches.append(d)
    return {"count": len(batches), "batches": batches}


@app.get("/api/batches/{batch_id}", dependencies=[Depends(require_user)])
def get_batch(batch_id: int, session: Session = Depends(get_session)):
    batch = _get_batch(session, batch_id)
    items = _batch_items(session, batch_id)
    # How many labels this batch actually printed per product — the pair
    # step compares tags paired against labels printed, not boxes scanned.
    printed: dict = {}
    for job in session.scalars(
        select(PrintJob).where(
            PrintJob.batch_id == batch_id,
            PrintJob.status.in_(("pending", "printing", "done")),
        )
    ):
        if job.sku:
            printed[job.sku] = printed.get(job.sku, 0) + 1
    payload = []
    for item in items:
        d = item.as_dict()
        d["printed_count"] = printed.get(item.sku or "", 0)
        payload.append(d)
    return {"batch": batch.as_dict(), "items": payload}


class BatchScanIn(BaseModel):
    code: str = Field(max_length=64)

    @field_validator("code")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/batches/{batch_id}/scan",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def batch_scan(
    batch_id: int, payload: BatchScanIn, session: Session = Depends(get_session)
):
    """One box scanned at the shelf. Resolves through the full Scan Station
    chain (TELCAN -> Shopify -> alias -> serial prefix); repeated scans of
    the same product bump its count. Unknown barcodes are kept as unresolved
    rows so the physical count survives — they never block the batch."""
    batch = _get_batch(session, batch_id)
    if batch.status in ("done", "abandoned"):
        raise HTTPException(409, f"This batch is {batch.status}.")

    code = payload.code
    product = None
    try:
        product = product_by_barcode(code)
    except HTTPException as error:
        if error.status_code != 404:
            raise

    items = _batch_items(session, batch_id)
    item = None
    if product is not None:
        sku = product.get("sku")
        barcode = product.get("barcode")
        for i in items:
            if i.resolved and (
                (sku and i.sku == sku)
                or (not sku and barcode and i.barcode == barcode)
            ):
                item = i
                break
    else:
        for i in items:
            if not i.resolved and i.scanned_code == code:
                item = i
                break

    if item is None:
        item = BatchItem(
            batch_id=batch.id, scanned_code=code[:64], qty_scanned=0
        )
        if product is not None:
            item.resolved = True
            item.shopify_variant_id = product.get("shopify_variant_id")
            item.shopify_product_id = product.get("shopify_product_id")
            item.product_title = product.get("product_title")
            item.variant_title = product.get("variant_title")
            item.sku = product.get("sku")
            item.barcode = product.get("barcode")
            item.bin_location = product.get("bin_location")
            others = bins_other_than(product.get("bin_location"),
                                     batch.bin_name)
            item.other_bins = (", ".join(others))[:255] if others else None
            item.serial_prefix = product.get("serial_prefix")
            item.image_url = (product.get("image_url") or "")[:500] or None
            # Batch labels print the store header + SKU (Astronomik naming
            # lives in Scan Station), so no per-item label name here.
            item.label_name = None
            item.expected_qty = _mirror_qty(session, item.sku)
        else:
            item.resolved = False
            item.product_title = f"Unresolved: {code}"
        session.add(item)

    # A pre-seeded row scanned via a brand serial learns its prefix on first
    # contact — the pair stage needs it to tell barcodes from EPCs. The label
    # name stays the store default; Astronomik naming is Scan Station only.
    if product is not None and product.get("serial_prefix"):
        if not item.serial_prefix:
            item.serial_prefix = product["serial_prefix"]

    item.qty_scanned += 1
    session.commit()
    session.refresh(item)

    # Bin mismatch is informational: the operator decides at the shelf
    # (keep saved bin / move it via the existing confirmed bin update).
    saved_bin = item.bin_location
    # A product split across shelves ("G2-1 & B17") is legitimately here as
    # long as this bin is one of the ones listed.
    bin_mismatch = bool(
        item.resolved
        and saved_bin
        and saved_bin not in MISSING_BIN_VALUES
        and not bin_contains(saved_bin, batch.bin_name)
    )
    return {
        "item": item.as_dict(),
        "bin_mismatch": bin_mismatch,
        "serial_note": (product or {}).get("serial_note"),
    }


@app.get(
    "/api/batches/{batch_id}/review", dependencies=[Depends(require_user)]
)
def batch_review(batch_id: int, session: Session = Depends(get_session)):
    """The Check step, shared by web and C72: which items need a human
    decision before labels print, and why. Flags: 'ambiguous' (barcode
    matches several listings — candidates included, primary first),
    'count-mismatch' (scanned != expected), 'unconfirmed-name' (serialized
    product whose label name was never operator-confirmed), 'unresolved'
    (barcode matched nothing)."""
    _get_batch(session, batch_id)
    flagged = []
    for item in _batch_items(session, batch_id):
        if item.qty_scanned == 0 and item.paired_count == 0:
            continue  # untouched pre-seeded rows need no checking
        flags = []
        candidates: list[dict] = []
        if not item.resolved:
            flags.append("unresolved")
        else:
            code = item.barcode or item.scanned_code
            if code:
                try:
                    candidates = products_by_barcode_all(code)
                except Exception as error:
                    logger.warning("candidates failed for %s: %s",
                                   code, error)
                if len(candidates) > 1:
                    flags.append("ambiguous")
                else:
                    candidates = []
            if (
                item.expected_qty is not None
                and item.qty_scanned != item.expected_qty
            ):
                flags.append("count-mismatch")
            if item.serial_prefix:
                sp = session.get(SerialPrefix, item.serial_prefix)
                if sp is not None and sp.label_name is None:
                    flags.append("unconfirmed-name")
            # Saved bin differs from the bin being walked: the boxes are on
            # the wrong shelf (or the record is). Never blocks — the
            # operator picks move / relabel here / ignore.
            saved = (item.bin_location or "").strip()
            if (
                saved
                and saved.lower() != "no bin assigned"
                and not bin_contains(
                    saved, _get_batch(session, batch_id).bin_name
                )
            ):
                flags.append("wrong-bin")
        if flags:
            flagged.append({
                "item": item.as_dict(),
                "flags": flags,
                "candidates": candidates,
            })
    return {"count": len(flagged), "items": flagged}


class ReassignIn(BaseModel):
    shopify_variant_id: str = Field(max_length=64)


@app.post(
    "/api/batches/{batch_id}/items/{item_id}/reassign",
    dependencies=[Depends(require_user)],
)
def batch_item_reassign(
    batch_id: int,
    item_id: int,
    payload: ReassignIn,
    session: Session = Depends(get_session),
):
    """Point an ambiguous item at a different listing sharing its barcode.
    The WHOLE scanned count moves (mixed shelves get fixed with -/+
    afterwards). If the target product is already in the batch, the counts
    merge into that row."""
    _get_batch(session, batch_id)
    item = session.get(BatchItem, item_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(404, "No such item in this batch.")
    code = item.barcode or item.scanned_code
    match = next(
        (
            p for p in products_by_barcode_all(code or "")
            if p.get("shopify_variant_id") == payload.shopify_variant_id
        ),
        None,
    )
    if match is None:
        raise HTTPException(404, "That listing doesn't share this barcode.")

    existing = next(
        (
            i for i in _batch_items(session, batch_id)
            if i.id != item.id and i.resolved and i.sku
            and i.sku == match.get("sku")
        ),
        None,
    )
    if existing is not None:
        existing.qty_scanned += item.qty_scanned
        existing.paired_count += item.paired_count
        session.delete(item)
        session.commit()
        session.refresh(existing)
        return {"item": existing.as_dict(), "merged": True}

    item.resolved = True
    item.shopify_variant_id = match.get("shopify_variant_id")
    item.shopify_product_id = match.get("shopify_product_id")
    item.product_title = match.get("product_title")
    item.variant_title = match.get("variant_title")
    item.sku = match.get("sku")
    item.barcode = match.get("barcode")
    item.bin_location = match.get("bin_location")
    item.image_url = (match.get("image_url") or "")[:500] or None
    item.expected_qty = _mirror_qty(session, item.sku)
    session.commit()
    session.refresh(item)
    return {"item": item.as_dict(), "merged": False}


class ItemQtyIn(BaseModel):
    qty: int = Field(ge=0, le=500)


@app.post(
    "/api/batches/{batch_id}/items/{item_id}/qty",
    dependencies=[Depends(require_user)],
)
def set_item_qty(
    batch_id: int,
    item_id: int,
    payload: ItemQtyIn,
    session: Session = Depends(get_session),
):
    _get_batch(session, batch_id)
    item = session.get(BatchItem, item_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(404, "No such item in this batch.")
    item.qty_scanned = payload.qty
    session.commit()
    return item.as_dict()


class ItemLabelIn(BaseModel):
    label_name: str = Field(max_length=255)

    @field_validator("label_name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.put(
    "/api/batches/{batch_id}/items/{item_id}/label",
    dependencies=[Depends(require_user)],
)
def set_item_label(
    batch_id: int,
    item_id: int,
    payload: ItemLabelIn,
    session: Session = Depends(get_session),
):
    _get_batch(session, batch_id)
    item = session.get(BatchItem, item_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(404, "No such item in this batch.")
    item.label_name = payload.label_name
    # Serialized brands: saving here confirms the name exactly like the
    # Scan Station's Save button, so future scans auto-print with it.
    if item.serial_prefix:
        sp = session.get(SerialPrefix, item.serial_prefix)
        if sp is not None:
            sp.label_name = payload.label_name
    session.commit()
    return item.as_dict()


class BatchQueueIn(BaseModel):
    requested_by: str | None = Field(default=None, max_length=100)


@app.post(
    "/api/batches/{batch_id}/queue-labels",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def batch_queue_labels(
    batch_id: int,
    payload: BatchQueueIn,
    session: Session = Depends(get_session),
):
    """One print job per scanned box. Labels carry the BATCH bin — that's
    where the boxes physically are. Only from 'collecting' so a double-click
    can't queue the whole batch twice; single reprints live in Print Queue."""
    batch = _get_batch(session, batch_id)
    if batch.status != "collecting":
        raise HTTPException(
            409,
            f"Labels were already queued for this batch (status "
            f"{batch.status}). Reprint individual labels from Print Queue.",
        )
    jobs = []
    for item in _batch_items(session, batch_id):
        if not item.resolved or not item.shopify_variant_id:
            continue
        # Preferred name, in order: this batch item's own override, the
        # serial brand's confirmed name, then the product's saved label
        # name (Check step / History panel). None = store header + SKU.
        label_name = None
        label_placement = "header"
        if item.serial_prefix:
            sp = session.get(SerialPrefix, item.serial_prefix)
            if sp is not None and sp.label_name:
                label_name = sp.label_name
        if label_name is None and item.sku:
            custom = session.get(LabelName, item.sku)
            if custom is not None:
                label_name = custom.label_name
                label_placement = custom.placement or "header"
        if label_name is None and item.label_name and (
            item.label_name != item.sku
        ):
            label_name = item.label_name
        for _ in range(item.qty_scanned):
            jobs.append(
                PrintJob(
                    epc=_new_epc(),
                    status="pending",
                    batch_id=batch.id,
                    shopify_variant_id=item.shopify_variant_id,
                    shopify_product_id=item.shopify_product_id,
                    product_title=item.product_title or "",
                    variant_title=item.variant_title,
                    sku=item.sku,
                    barcode=item.barcode,
                    bin_location=batch.bin_name,
                    # Split-shelf products print where their other boxes
                    # are, so a picker isn't left hunting.
                    other_bins=item.other_bins,
                    # Store header + SKU unless a preferred name exists:
                    # the batch item's own override first, else the
                    # product's saved label name (set in Check / History).
                    label_name=label_name,
                    label_placement=label_placement,
                    requested_by=payload.requested_by or batch.created_by,
                )
            )
    if not jobs:
        raise HTTPException(422, "No resolved products with boxes to label.")
    session.add_all(jobs)
    batch.status = "printing"
    session.commit()
    return {"count": len(jobs), "batch": batch.as_dict()}


class PairIn(BaseModel):
    epc: str = Field(max_length=128)
    item_id: int
    created_by: str | None = Field(default=None, max_length=100)

    @field_validator("epc")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post(
    "/api/batches/{batch_id}/pair",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def batch_pair(
    batch_id: int, payload: PairIn, session: Session = Depends(get_session)
):
    """Attach one applied label's EPC to the active product. Duplicate EPCs
    are rejected with what they're already assigned to; odd-looking EPCs
    save but come back flagged suspect (same rules as the Scan Station)."""
    batch = _get_batch(session, batch_id)
    item = session.get(BatchItem, payload.item_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(404, "No such item in this batch.")
    if not item.resolved:
        raise HTTPException(422, "That item never resolved to a product.")

    assignment = RfidAssignment(
        rfid_id=payload.epc,
        shopify_variant_id=item.shopify_variant_id,
        shopify_product_id=item.shopify_product_id,
        product_title=item.label_name or item.product_title or "",
        variant_title=item.variant_title,
        sku=item.sku,
        barcode=item.barcode,
        bin_location=batch.bin_name,
        assigned_by=payload.created_by,
        batch_id=batch.id,
    )
    assignment.suspect = (
        re.fullmatch(r"[0-9A-Fa-f]{24}", payload.epc) is None
    )
    session.add(assignment)
    item.paired_count += 1
    if batch.status == "printing":
        batch.status = "pairing"
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = session.scalar(
            select(RfidAssignment).where(
                RfidAssignment.rfid_id == payload.epc
            )
        )
        raise HTTPException(
            409,
            f"Duplicate EPC — already assigned to "
            f"{existing.product_title if existing else 'another product'}.",
        )
    session.refresh(assignment)
    session.refresh(item)
    return {"assignment": assignment.as_dict(), "item": item.as_dict()}


class PairUndoIn(BaseModel):
    epc: str = Field(max_length=128)
    item_id: int


@app.post(
    "/api/batches/{batch_id}/pair/undo",
    dependencies=[Depends(require_user)],
)
def batch_pair_undo(
    batch_id: int, payload: PairUndoIn, session: Session = Depends(get_session)
):
    _get_batch(session, batch_id)
    item = session.get(BatchItem, payload.item_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(404, "No such item in this batch.")
    row = session.scalar(
        select(RfidAssignment).where(
            RfidAssignment.rfid_id == payload.epc.strip()
        )
    )
    if row is None:
        raise HTTPException(404, "No assignment for that EPC.")
    session.delete(row)
    item.paired_count = max(0, item.paired_count - 1)
    session.commit()
    return {"item": item.as_dict()}


class VerifyIn(BaseModel):
    epcs: list[str] = Field(max_length=2000)


@app.post(
    "/api/batches/{batch_id}/verify", dependencies=[Depends(require_user)]
)
def batch_verify(
    batch_id: int, payload: VerifyIn, session: Session = Depends(get_session)
):
    """Final bin sweep: classify every detected EPC as ours-in-this-batch,
    a known tag from another product, or unknown; report per-product
    paired-vs-detected counts. Read-only — completion decides what becomes
    a ReviewTask."""
    batch = _get_batch(session, batch_id)
    items = [i for i in _batch_items(session, batch_id) if i.resolved]
    epcs = {e.strip().upper() for e in payload.epcs if e and e.strip()}
    if epcs and batch.verified_at is None:
        batch.verified_at = datetime.now(timezone.utc)
        session.commit()

    assignments = {}
    if epcs:
        rows = session.scalars(
            select(RfidAssignment).where(
                func.upper(RfidAssignment.rfid_id).in_(epcs)
            )
        ).all()
        assignments = {r.rfid_id.upper(): r for r in rows}

    batch_keys = {(i.sku, i.barcode) for i in items}
    detected = {}  # (sku, barcode) -> count
    foreign, unknown = [], []
    for epc in sorted(epcs):
        row = assignments.get(epc)
        if row is None:
            unknown.append(epc)
        elif (row.sku, row.barcode) in batch_keys:
            key = (row.sku, row.barcode)
            detected[key] = detected.get(key, 0) + 1
        else:
            foreign.append(
                {
                    "epc": row.rfid_id,
                    "product_title": row.product_title,
                    "sku": row.sku,
                    "bin_location": row.bin_location,
                }
            )

    report = [
        {
            "item_id": i.id,
            "sku": i.sku,
            "product_title": i.label_name or i.product_title,
            "qty_scanned": i.qty_scanned,
            "paired_count": i.paired_count,
            "detected": detected.get((i.sku, i.barcode), 0),
        }
        for i in items
    ]
    ok = (
        not unknown
        and not foreign
        and all(r["detected"] >= r["paired_count"] for r in report)
    )
    return {
        "bin": batch.bin_name,
        "scanned_epcs": len(epcs),
        "items": report,
        "foreign": foreign,
        "unknown_epcs": unknown,
        "ok": ok,
    }


class CompleteIn(BaseModel):
    created_by: str | None = Field(default=None, max_length=100)
    # Closing a bin is a deliberate sign-off made on a full screen, where
    # the counts and mismatches are readable. Only the web terminal sends
    # this; a scanner's "finish" hands the batch over instead.
    finalize: bool = False


@app.post(
    "/api/batches/{batch_id}/complete", dependencies=[Depends(require_user)]
)
def batch_complete(
    batch_id: int,
    payload: CompleteIn,
    session: Session = Depends(get_session),
):
    """Close the batch. Mismatches become Review tasks — recommendations
    for a future product check, never automatic fixes.

    A finish from the shelf (no `finalize`) doesn't close anything: it
    parks the batch as awaiting-verify so the counts get checked on a web
    terminal first."""
    batch = _get_batch(session, batch_id)
    if batch.status in ("done", "abandoned"):
        raise HTTPException(409, f"This batch is already {batch.status}.")
    if not payload.finalize:
        if batch.status != "awaiting-verify":
            batch.status = "awaiting-verify"
            # Point every terminal at the step that has to happen next.
            batch.ui_step = "verify"
            session.commit()
        raise HTTPException(
            409,
            f"Bin {batch.bin_name} is ready to close, but bins are closed "
            f"from a web terminal so the counts can be checked on a full "
            f"screen. Open Batch tagging on the PC or iPad — this bin is "
            f"waiting under unfinished batches — run Verify, then Complete "
            f"batch.",
        )
    tasks = []
    for item in _batch_items(session, batch_id):
        name = item.label_name or item.product_title
        if not item.resolved:
            tasks.append(ReviewTask(
                category="unresolved-barcode",
                detail=(
                    f"Barcode {item.scanned_code} was scanned "
                    f"{item.qty_scanned}x in bin {batch.bin_name} but never "
                    f"resolved to a product. Link or fix it at the Scan "
                    f"Station."
                )[:500],
                batch_id=batch.id,
                created_by=payload.created_by,
            ))
            continue
        if (
            item.expected_qty is not None
            and item.qty_scanned != item.expected_qty
        ):
            tasks.append(ReviewTask(
                category="inventory-check",
                sku=item.sku,
                product_title=name,
                detail=(
                    f"Bin {batch.bin_name}: {item.qty_scanned} box(es) "
                    f"scanned but Shopify on-hand is {item.expected_qty}. "
                    f"Recommend a product-specific count."
                )[:500],
                batch_id=batch.id,
                created_by=payload.created_by,
            ))
        if item.paired_count < item.qty_scanned:
            tasks.append(ReviewTask(
                category="pairing-incomplete",
                sku=item.sku,
                product_title=name,
                detail=(
                    f"Bin {batch.bin_name}: only {item.paired_count} of "
                    f"{item.qty_scanned} RFID tags were paired. Finish "
                    f"pairing at the Scan Station or re-check the shelf."
                )[:500],
                batch_id=batch.id,
                created_by=payload.created_by,
            ))
    session.add_all(tasks)
    batch.status = "done"
    batch.completed_at = datetime.now(timezone.utc)
    session.commit()
    return {
        "batch": batch.as_dict(),
        "review_tasks": [t.as_dict() for t in tasks],
    }


def _aware(dt: datetime | None) -> datetime | None:
    """Timestamps come back naive from some backends; compare in UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _batch_tie_rows(session: Session, batch: Batch) -> list[RfidAssignment]:
    """Every tag tie belonging to a batch.

    Ties made before rfid_assignments carried a batch_id are matched the
    only way left: the bin that batch walked, during the window it was
    open. Without this, old batches look untied but aren't."""
    rows = {
        r.id: r
        for r in session.scalars(
            select(RfidAssignment).where(RfidAssignment.batch_id == batch.id)
        )
    }
    bin_name = (batch.bin_name or "").strip().lower()
    start = _aware(batch.created_at)
    if not bin_name or start is None:
        return list(rows.values())
    end = _aware(batch.completed_at) or datetime.now(timezone.utc)
    for r in session.scalars(
        select(RfidAssignment).where(
            RfidAssignment.batch_id.is_(None),
            func.lower(func.coalesce(RfidAssignment.bin_location, ""))
            == bin_name,
        )
    ):
        at = _aware(r.assigned_at)
        if at is not None and start <= at <= end:
            rows[r.id] = r
    return list(rows.values())


def _unpair_batch(session: Session, batch: Batch) -> dict:
    """Remove every tag tie this batch created and zero its paired counts.
    Local records only — no Shopify, and the printed labels stay valid."""
    rows = _batch_tie_rows(session, batch)
    legacy = sum(1 for r in rows if r.batch_id is None)
    for row in rows:
        session.delete(row)
    for item in _batch_items(session, batch.id):
        item.paired_count = 0
    session.commit()
    return {"removed": len(rows), "legacy": legacy}


class AbandonIn(BaseModel):
    remove_ties: bool = True


@app.post(
    "/api/batches/{batch_id}/abandon", dependencies=[Depends(require_user)]
)
def batch_abandon(
    batch_id: int,
    payload: AbandonIn | None = None,
    session: Session = Depends(get_session),
):
    """Close a batch without completing it. By default the tag ties this
    batch created are removed too — an abandoned bin shouldn't leave
    products tied to labels that were never verified."""
    batch = _get_batch(session, batch_id)
    if batch.status == "done":
        raise HTTPException(409, "This batch is already done.")
    removed = 0
    if payload is None or payload.remove_ties:
        # Before flipping status: completed_at bounds the legacy window.
        removed = _unpair_batch(session, batch)["removed"]
    batch.status = "abandoned"
    batch.completed_at = datetime.now(timezone.utc)
    session.commit()
    result = batch.as_dict()
    result["ties_removed"] = removed
    return result


@app.post(
    "/api/batches/{batch_id}/unpair-all",
    dependencies=[Depends(require_user)],
)
def batch_unpair_all(batch_id: int, session: Session = Depends(get_session)):
    """Undo the pairing step: every tag this batch tied is released so the
    shelf can be re-scanned. Labels already printed stay valid."""
    batch = _get_batch(session, batch_id)
    return _unpair_batch(session, batch)


class StepIn(BaseModel):
    step: str = Field(pattern="^(collect|check|print|pair|verify)$")


@app.post(
    "/api/batches/{batch_id}/step", dependencies=[Depends(require_user)]
)
def batch_set_step(
    batch_id: int, payload: StepIn, session: Session = Depends(get_session)
):
    """Record which step the operator is on so other terminals watching
    this batch can follow. Purely a UI signal — nothing else reads it."""
    batch = _get_batch(session, batch_id)
    batch.ui_step = payload.step
    session.commit()
    return {"id": batch.id, "ui_step": batch.ui_step}


@app.post(
    "/api/batches/{batch_id}/skip-print",
    dependencies=[Depends(require_user)],
)
def batch_skip_print(batch_id: int, session: Session = Depends(get_session)):
    """Go straight to pairing without queueing labels — for bins whose
    labels are already printed and applied."""
    batch = _get_batch(session, batch_id)
    if batch.status in ("done", "abandoned"):
        raise HTTPException(409, f"This batch is {batch.status}.")
    batch.status = "pairing"
    session.commit()
    return batch.as_dict()


@app.delete(
    "/api/batches/{batch_id}/items/{item_id}",
    status_code=204,
    dependencies=[Depends(require_user)],
)
def batch_item_delete(
    batch_id: int, item_id: int, session: Session = Depends(get_session)
):
    """Drop a row from the batch (an unresolved barcode you don't want
    counted, or a product that belongs on another shelf). Any tags already
    tied to it are released with it."""
    _get_batch(session, batch_id)
    item = session.get(BatchItem, item_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(404, "No such item in this batch.")
    if item.sku:
        for row in session.scalars(
            select(RfidAssignment).where(
                RfidAssignment.batch_id == batch_id,
                RfidAssignment.sku == item.sku,
            )
        ):
            session.delete(row)
    session.delete(item)
    session.commit()


class UnlinkedIn(BaseModel):
    epcs: list[str] = Field(min_length=1, max_length=2000)


@app.post(
    "/api/batches/{batch_id}/unlinked",
    dependencies=[Depends(require_user)],
)
def batch_unlinked(
    batch_id: int,
    payload: UnlinkedIn,
    session: Session = Depends(get_session),
):
    """Given a sweep, report which tags aren't tied to anything yet — the
    unreadable-label rescue: sweep the shelf, find the orphan, tie it."""
    _get_batch(session, batch_id)
    epcs = []
    seen: set = set()
    for raw in payload.epcs:
        epc = (raw or "").strip().upper()
        if epc and epc not in seen:
            seen.add(epc)
            epcs.append(epc)
    taken = {
        r.rfid_id.upper(): r
        for r in session.scalars(
            select(RfidAssignment).where(RfidAssignment.rfid_id.in_(epcs))
        )
    }
    unlinked = [e for e in epcs if e not in taken]
    return {
        "swept": len(epcs),
        "unlinked": unlinked,
        "linked": [
            {"epc": e, "product_title": taken[e].product_title,
             "sku": taken[e].sku}
            for e in epcs if e in taken
        ],
    }


# ------------------------------------------------------------ review tasks ---
@app.get("/api/review-tasks", dependencies=[Depends(require_user)])
def list_review_tasks(
    status: str = "open",
    limit: int = 100,
    session: Session = Depends(get_session),
):
    stmt = select(ReviewTask).order_by(ReviewTask.id.desc())
    if status != "all":
        stmt = stmt.where(ReviewTask.status == status.strip())
    rows = session.scalars(stmt.limit(min(limit, 500))).all()
    return {"count": len(rows), "tasks": [t.as_dict() for t in rows]}


class ResolveIn(BaseModel):
    resolved_by: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=255)
    dismissed: bool = False


@app.post(
    "/api/review-tasks/{task_id}/resolve",
    dependencies=[Depends(require_user)],
)
def resolve_review_task(
    task_id: int, payload: ResolveIn, session: Session = Depends(get_session)
):
    task = session.get(ReviewTask, task_id)
    if task is None:
        raise HTTPException(404, "No such review task.")
    if task.status != "open":
        raise HTTPException(409, f"Task is already {task.status}.")
    task.status = "dismissed" if payload.dismissed else "resolved"
    task.resolved_by = payload.resolved_by
    task.resolved_at = datetime.now(timezone.utc)
    task.resolution_note = payload.note
    session.commit()
    return task.as_dict()


# ------------------------------------------------------------ EPC captures ---
# Sweeps sent by the C72 companion app over Wi-Fi (scan anywhere, Send once
# when done — no Bluetooth). The browser pulls the latest into batch verify.

class CaptureIn(BaseModel):
    epcs: list[str] = Field(min_length=1, max_length=20000)
    device: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=255)


@app.post(
    "/api/epc-captures",
    status_code=201,
    dependencies=[Depends(require_user)],
)
def create_capture(payload: CaptureIn, session: Session = Depends(get_session)):
    seen: set[str] = set()
    epcs: list[str] = []
    for raw in payload.epcs:
        epc = (raw or "").strip().upper()
        if epc and epc not in seen:
            seen.add(epc)
            epcs.append(epc)
    if not epcs:
        raise HTTPException(422, "No usable EPCs in the sweep.")
    row = EpcCapture(
        device=(payload.device or "").strip() or None,
        note=(payload.note or "").strip() or None,
        epc_count=len(epcs),
        epcs="\n".join(epcs),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row.as_dict()


@app.get("/api/epc-captures", dependencies=[Depends(require_user)])
def list_captures(limit: int = 20, session: Session = Depends(get_session)):
    rows = session.scalars(
        select(EpcCapture).order_by(EpcCapture.id.desc()).limit(min(limit, 100))
    ).all()
    return {"count": len(rows), "captures": [r.as_dict() for r in rows]}


@app.get("/api/epc-captures/latest", dependencies=[Depends(require_user)])
def latest_capture(session: Session = Depends(get_session)):
    row = session.scalar(
        select(EpcCapture).order_by(EpcCapture.id.desc()).limit(1)
    )
    if row is None:
        raise HTTPException(404, "No sweeps received yet.")
    return row.as_dict(with_epcs=True)


@app.get("/api/epc-captures/{capture_id}", dependencies=[Depends(require_user)])
def get_capture(capture_id: int, session: Session = Depends(get_session)):
    row = session.get(EpcCapture, capture_id)
    if row is None:
        raise HTTPException(404, "No such sweep.")
    return row.as_dict(with_epcs=True)


# ------------------------------------------------------------ label names ---
class LabelNameIn(BaseModel):
    label_name: str = Field(default="", max_length=76)
    placement: str = Field(default="header", pattern="^(header|sku|both)$")
    updated_by: str | None = Field(default=None, max_length=100)


@app.put("/api/label-names/{sku}", dependencies=[Depends(require_user)])
def set_label_name(
    sku: str, payload: LabelNameIn, session: Session = Depends(get_session)
):
    """Set (or clear, with a blank name) the preferred label header for a
    non-serialized product. Local record only — labels pick it up on the
    next print; nothing in Shopify changes."""
    sku = sku.strip()
    if not sku:
        raise HTTPException(422, "SKU required.")
    name = payload.label_name.strip()
    row = session.get(LabelName, sku)
    if not name:
        if row is not None:
            session.delete(row)
            session.commit()
        return {"sku": sku, "label_name": None}
    if row is None:
        row = LabelName(sku=sku)
        session.add(row)
    row.label_name = name
    row.placement = payload.placement
    row.updated_by = payload.updated_by
    session.commit()
    return {"sku": sku, "label_name": name, "placement": row.placement}


# -------------------------------------------------------- product history ---
@app.get("/api/product-history", dependencies=[Depends(require_user)])
def product_history(term: str, session: Session = Depends(get_session)):
    """One product's complete paper trail, newest first. Every event says
    whether it touched Shopify ("shopify": true) or only this system's
    records — count observations from batches are always local; nothing
    in the RFID system writes stock numbers to Shopify today."""
    term = term.strip()
    if not term:
        raise HTTPException(422, "Provide a SKU or barcode.")

    product = None
    try:
        product = product_by_barcode(term)
    except HTTPException as error:
        if error.status_code != 404:
            raise
    sku = (product.get("sku") if product else None) or term
    barcode = (product.get("barcode") if product else None) or term

    def iso(dt):
        return dt.isoformat() if dt else None

    events = []

    for a in session.scalars(
        select(RfidAssignment).where(or_(
            RfidAssignment.sku == sku, RfidAssignment.barcode == barcode
        ))
    ):
        events.append({
            "at": iso(a.assigned_at),
            "type": "tag-assigned",
            "worker": a.assigned_by,
            "detail": f"EPC {a.rfid_id}"
                      + (" · SUSPECT read" if a.suspect else "")
                      + (f" · bin {a.bin_location}" if a.bin_location else ""),
            "shopify": False,
        })

    change_types = {
        "barcode": "barcode-replaced", "sku": "sku-updated",
        "bin": "bin-updated",
    }
    for c in session.scalars(
        select(BarcodeChange).where(or_(
            BarcodeChange.sku == sku,
            BarcodeChange.old_barcode == barcode,
            BarcodeChange.new_barcode == barcode,
        ))
    ):
        events.append({
            "at": iso(c.changed_at),
            "type": change_types.get(c.changed_field, c.changed_field),
            "worker": c.changed_by,
            "detail": f"{c.old_barcode or '(none)'} → {c.new_barcode}",
            "shopify": True,  # these flows write to the store
        })

    job_types = {
        "done": "label-printed", "error": "label-failed",
        "canceled": "label-canceled", "pending": "label-queued",
        "printing": "label-printing",
    }
    for j in session.scalars(
        select(PrintJob).where(or_(
            PrintJob.sku == sku, PrintJob.barcode == barcode
        ))
    ):
        events.append({
            "at": iso(j.printed_at or j.created_at),
            "type": job_types.get(j.status, j.status),
            "worker": j.requested_by,
            "detail": f"EPC {j.epc}"
                      + (f" · batch #{j.batch_id}" if j.batch_id else ""),
            "shopify": False,
        })

    for al in session.scalars(
        select(BarcodeAlias).where(or_(
            BarcodeAlias.sku == sku, BarcodeAlias.alias_barcode == barcode
        ))
    ):
        events.append({
            "at": iso(al.created_at),
            "type": "barcode-linked",
            "worker": al.created_by,
            "detail": f"{al.alias_barcode} → {al.barcode or al.sku}",
            "shopify": False,
        })

    # Count observations: what the shelf actually held, per batch. These
    # never change Shopify stock — they are the record a future (explicit)
    # write-back would act on.
    for item, batch in session.execute(
        select(BatchItem, Batch)
        .join(Batch, Batch.id == BatchItem.batch_id)
        .where(BatchItem.sku == sku)
    ):
        detail = (
            f"bin {batch.bin_name}: counted {item.qty_scanned}"
            + (f" (expected {item.expected_qty})"
               if item.expected_qty is not None else "")
            + (f", {item.paired_count} tag(s) paired"
               if item.paired_count else "")
            + f" · batch #{batch.id} {batch.status}"
        )
        events.append({
            "at": iso(batch.completed_at or batch.created_at),
            "type": "batch-counted",
            "worker": batch.created_by,
            "detail": detail,
            "shopify": False,  # counts are recorded, never pushed (yet)
        })

    for t in session.scalars(
        select(ReviewTask).where(ReviewTask.sku == sku)
    ):
        events.append({
            "at": iso(t.created_at),
            "type": "review-opened",
            "worker": t.created_by,
            "detail": f"[{t.category}] {t.detail}",
            "shopify": False,
        })
        if t.resolved_at:
            events.append({
                "at": iso(t.resolved_at),
                "type": f"review-{t.status}",
                "worker": t.resolved_by,
                "detail": f"[{t.category}]"
                          + (f" {t.resolution_note}"
                             if t.resolution_note else ""),
                "shopify": False,
            })

    events.sort(key=lambda e: e["at"] or "", reverse=True)

    tag_count = session.scalar(
        select(func.count()).select_from(RfidAssignment).where(or_(
            RfidAssignment.sku == sku, RfidAssignment.barcode == barcode
        ))
    )
    image_url = (product or {}).get("image_url")
    if not image_url:
        image_url = session.scalar(
            select(BinMapEntry.image_url).where(BinMapEntry.sku == sku)
        )
    # Serialized brands: surface the preferred label name so the panel can
    # edit it (looking up by SKU — the serial fields on `product` only
    # populate when the scanned term was itself a serial).
    sp = session.scalar(
        select(SerialPrefix).where(SerialPrefix.sku == sku)
        .order_by(SerialPrefix.prefix)
    )
    custom = session.get(LabelName, sku)
    return {
        "product": product,
        "sku": sku,
        "barcode": barcode,
        "image_url": image_url,
        "tag_count": tag_count,
        "on_hand": _mirror_qty(session, sku),
        "serial_prefix": sp.prefix if sp else None,
        "serial_label": (
            (sp.label_name or _default_serial_label(sp.item_name))
            if sp else None
        ),
        "serial_label_saved": bool(sp and sp.label_name),
        # Non-serial products keep their preferred header here instead.
        "custom_label": custom.label_name if custom else None,
        "custom_placement": custom.placement if custom else "header",
        "count": len(events),
        "events": events,
    }


# ---------------------------------------------------------------- history ---
@app.get("/api/history", dependencies=[Depends(require_user)])
def history(
    limit: int = 200,
    session: Session = Depends(get_session),
):
    """Unified append-only event feed across every app-owned table. Each
    source keeps its own audit row; this endpoint just merges them into one
    timeline (newest first). Nothing here is ever rewritten."""
    limit = min(limit, 500)
    events = []

    def iso(dt):
        return dt.isoformat() if dt else None

    for a in session.scalars(
        select(RfidAssignment)
        .order_by(RfidAssignment.id.desc()).limit(limit)
    ):
        events.append({
            "at": iso(a.assigned_at),
            "type": "tag-assigned",
            "worker": a.assigned_by,
            "sku": a.sku,
            "title": a.product_title,
            "detail": f"EPC {a.rfid_id}"
                      + (" · SUSPECT read" if a.suspect else "")
                      + (f" · bin {a.bin_location}" if a.bin_location else ""),
        })

    change_types = {
        "barcode": "barcode-replaced", "sku": "sku-updated",
        "bin": "bin-updated",
    }
    for c in session.scalars(
        select(BarcodeChange).order_by(BarcodeChange.id.desc()).limit(limit)
    ):
        events.append({
            "at": iso(c.changed_at),
            "type": change_types.get(c.changed_field, c.changed_field),
            "worker": c.changed_by,
            "sku": c.sku,
            "title": c.product_title,
            "detail": f"{c.old_barcode or '(none)'} → {c.new_barcode}",
        })

    job_types = {
        "done": "label-printed", "error": "label-failed",
        "canceled": "label-canceled", "pending": "label-queued",
        "printing": "label-printing",
    }
    for j in session.scalars(
        select(PrintJob).order_by(PrintJob.id.desc()).limit(limit)
    ):
        events.append({
            "at": iso(j.printed_at or j.created_at),
            "type": job_types.get(j.status, j.status),
            "worker": j.requested_by,
            "sku": j.sku,
            "title": j.label_name or j.product_title,
            "detail": f"EPC {j.epc}"
                      + (f" · batch #{j.batch_id}" if j.batch_id else "")
                      + (f" · {j.error}" if j.error else ""),
        })

    for al in session.scalars(
        select(BarcodeAlias).order_by(BarcodeAlias.id.desc()).limit(limit)
    ):
        events.append({
            "at": iso(al.created_at),
            "type": "barcode-linked",
            "worker": al.created_by,
            "sku": al.sku,
            "title": al.product_title,
            "detail": f"{al.alias_barcode} → {al.barcode or al.sku}",
            # Alias rows are live (this event exists because the link still
            # does), so History can offer to undo it: DELETE the alias and
            # the scanned code stops resolving to this product.
            "undo": {
                "kind": "barcode-alias",
                "alias_barcode": al.alias_barcode,
            },
        })

    # Tie counts for the batch events below. Pulled once and matched in
    # memory: ties made before assignments carried a batch_id can only be
    # recognised by bin + time window, and per-batch queries would be
    # dozens of round trips.
    tie_by_batch: dict = {}
    legacy_ties: list = []
    for bid, bin_loc, at in session.execute(
        select(RfidAssignment.batch_id, RfidAssignment.bin_location,
               RfidAssignment.assigned_at)
    ):
        if bid is not None:
            tie_by_batch[bid] = tie_by_batch.get(bid, 0) + 1
        else:
            legacy_ties.append(((bin_loc or "").strip().lower(), _aware(at)))

    def _ties_for(b: Batch) -> int:
        n = tie_by_batch.get(b.id, 0)
        bin_name = (b.bin_name or "").strip().lower()
        start = _aware(b.created_at)
        if not bin_name or start is None:
            return n
        end = _aware(b.completed_at) or datetime.now(timezone.utc)
        for loc, at in legacy_ties:
            if loc == bin_name and at is not None and start <= at <= end:
                n += 1
        return n

    for b in session.scalars(
        select(Batch).order_by(Batch.id.desc()).limit(limit)
    ):
        # Every batch event can release that batch's tag ties in one click.
        tie_count = _ties_for(b)
        undo = (
            {"kind": "batch-ties", "batch_id": b.id, "ties": tie_count}
            if tie_count else None
        )
        events.append({
            "at": iso(b.created_at),
            "type": "batch-started",
            "worker": b.created_by,
            "sku": None,
            "title": f"Bin {b.bin_name}",
            "detail": f"Batch #{b.id}"
                      + (f" · {tie_count} tag(s) tied" if tie_count else ""),
            "undo": undo,
        })
        if b.verified_at:
            events.append({
                "at": iso(b.verified_at),
                "type": "batch-verified",
                "worker": b.created_by,
                "sku": None,
                "title": f"Bin {b.bin_name}",
                "detail": f"Batch #{b.id} swept and checked"
                          + (f" · {tie_count} tag(s) tied" if tie_count
                             else ""),
                "undo": undo,
            })
        if b.completed_at:
            events.append({
                "at": iso(b.completed_at),
                "type": ("batch-abandoned" if b.status == "abandoned"
                         else "batch-completed"),
                "worker": b.created_by,
                "sku": None,
                "title": f"Bin {b.bin_name}",
                "detail": f"Batch #{b.id}"
                          + (f" · {tie_count} tag(s) still tied"
                             if tie_count else ""),
                "undo": undo,
            })

    for t in session.scalars(
        select(ReviewTask).order_by(ReviewTask.id.desc()).limit(limit)
    ):
        events.append({
            "at": iso(t.created_at),
            "type": "review-opened",
            "worker": t.created_by,
            "sku": t.sku,
            "title": t.product_title,
            "detail": f"[{t.category}] {t.detail}",
        })
        if t.resolved_at:
            events.append({
                "at": iso(t.resolved_at),
                "type": f"review-{t.status}",
                "worker": t.resolved_by,
                "sku": t.sku,
                "title": t.product_title,
                "detail": f"[{t.category}]"
                          + (f" {t.resolution_note}" if t.resolution_note
                             else ""),
            })

    # ISO strings sort chronologically; string sort also avoids the
    # naive-vs-aware datetime comparison trap across DB backends.
    events.sort(key=lambda e: e["at"] or "", reverse=True)
    return {"count": len(events[:limit]), "events": events[:limit]}
