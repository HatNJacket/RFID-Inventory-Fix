"""FastAPI application: pages + JSON API.

Request flow (mirrors what runs on Azure):
  Browser scan -> JS fetch -> FastAPI route -> shopify.py / database -> JSON

No terminal input anywhere. The scanner types into browser fields exactly
as it would type into Notepad, and JavaScript forwards each scan here.
"""
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.requests import Request

from app import catalog, config, shopify
from app.database import (
    DatabaseNotConfigured,
    database_configured,
    get_session,
    init_db,
)
from app.models import PrintJob, RfidAssignment

logger = logging.getLogger("rfid")

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on startup only when a database is configured. Locally,
    # before you provision PostgreSQL, the app still boots and does lookups.
    if database_configured():
        init_db()
    yield


app = FastAPI(title="RFID Inventory", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.exception_handler(DatabaseNotConfigured)
def _db_not_configured(request: Request, exc: DatabaseNotConfigured):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=503,
        content={"detail": "Database not configured. Set DATABASE_URL to "
                           "enable saving and listing assignments."},
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


@app.get("/api/products/by-barcode/{barcode}")
def product_by_barcode(barcode: str):
    """Barcode -> product. Source order is config.BARCODE_LOOKUP:
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
                # TELCAN's Bin_Name is often empty; the authoritative bins
                # live in Shopify metafields (variant stock.bin and product
                # my_fields.bin_location / "EasyScan Product Bin Location").
                # Enrich from the API whenever TELCAN has no bin.
                if product.get("bin_location") in (None, "", "No bin assigned") and api_ok:
                    try:
                        api_product = shopify.lookup_barcode(barcode)
                        if api_product and api_product.get("bin_location") not in (
                            None, "", "No bin assigned"
                        ):
                            product["bin_location"] = api_product["bin_location"]
                    except RuntimeError as error:
                        logger.warning("bin enrichment failed: %s", error)
                return product
        except Exception as error:  # DB down/misconfigured -> try the API
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

    if not db_ok and not api_ok:
        raise HTTPException(
            500, "Neither the database nor Shopify credentials are configured."
        )
    raise HTTPException(404, "No product found for that barcode.")


@app.get("/api/products/tags")
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
@app.post("/api/rfid-assignments", status_code=201)
def create_assignment(
    payload: AssignmentIn, session: Session = Depends(get_session)
):
    assignment = RfidAssignment(**payload.model_dump())
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


@app.get("/api/rfid-assignments")
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


@app.get("/api/rfid-assignments/{rfid_id}")
def get_assignment(rfid_id: str, session: Session = Depends(get_session)):
    row = session.scalar(
        select(RfidAssignment).where(RfidAssignment.rfid_id == rfid_id.strip())
    )
    if row is None:
        raise HTTPException(404, "No assignment for that RFID tag.")
    return row.as_dict()


@app.delete("/api/rfid-assignments/{rfid_id}", status_code=204)
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
    requested_by: str | None = Field(default=None, max_length=100)

    @field_validator("shopify_variant_id", "product_title")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


@app.post("/api/print-jobs", status_code=201)
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


@app.get("/api/print-jobs")
def list_print_jobs(
    status: str | None = None,
    ids: str | None = None,
    limit: int = 50,
    session: Session = Depends(get_session),
):
    stmt = select(PrintJob).order_by(PrintJob.id.desc())
    if status:
        stmt = stmt.where(PrintJob.status == status.strip())
    if ids:
        try:
            id_list = [int(i) for i in ids.split(",") if i.strip()]
        except ValueError:
            raise HTTPException(422, "ids must be comma-separated integers.")
        stmt = stmt.where(PrintJob.id.in_(id_list))
    rows = session.scalars(stmt.limit(min(limit, 200))).all()
    return {"count": len(rows), "jobs": [j.as_dict() for j in rows]}


@app.post("/api/print-jobs/claim", dependencies=[Depends(require_agent_key)])
def claim_print_jobs(
    limit: int = 5, session: Session = Depends(get_session)
):
    """Agent: take the oldest pending jobs and mark them printing."""
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


@app.post("/api/print-jobs/{job_id}/cancel")
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
