"""Database models.

Per-package model: each RFID tag (EPC) is one row = one physical package.
Multiple rows can point at the same Shopify variant, which is exactly the
case where you have several identical boxes of the same product.

The Shopify identity fields (variant/product id, titles, sku, barcode) are
denormalized copies captured at assignment time. They're a snapshot for fast
display and offline resilience, not the source of truth -- Shopify remains
authoritative and you can re-sync them later if a product is renamed.
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func  # noqa: F401
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RfidAssignment(Base):
    __tablename__ = "rfid_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Explicit lengths on every string column: SQL Server refuses to index
    # or UNIQUE-constrain unbounded VARCHAR(max) columns.

    # The tag's unique EPC. UNIQUE enforces one assignment per physical tag;
    # reusing a tag means unassigning it first (or the replace endpoint).
    rfid_id: Mapped[str] = mapped_column(
        String(128), unique=True, index=True, nullable=False
    )

    shopify_variant_id: Mapped[str] = mapped_column(
        String(64), index=True, nullable=False
    )
    # 300 not 64: TELCAN-sourced ids are "handle:<shopify-handle>" and
    # handles run up to 255 chars.
    shopify_product_id: Mapped[str | None] = mapped_column(String(300))
    product_title: Mapped[str] = mapped_column(String(255), nullable=False)
    variant_title: Mapped[str | None] = mapped_column(String(255))
    sku: Mapped[str | None] = mapped_column(String(100))
    barcode: Mapped[str | None] = mapped_column(String(64), index=True)
    bin_location: Mapped[str | None] = mapped_column(String(100))

    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    assigned_by: Mapped[str | None] = mapped_column(String(100))

    # True when the scanned EPC doesn't look like a normal tag (every real
    # tag is 24 hex chars) — probably a bad read; re-scan recommended.
    suspect: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )

    # The bin batch this tie came from, when it came from one. Lets a batch
    # be un-tied wholesale (abandon, or "undo pairing" to re-scan a shelf).
    batch_id: Mapped[int | None] = mapped_column(Integer, index=True)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "suspect": self.suspect,
            "batch_id": self.batch_id,
            "rfid_id": self.rfid_id,
            "shopify_variant_id": self.shopify_variant_id,
            "shopify_product_id": self.shopify_product_id,
            "product_title": self.product_title,
            "variant_title": self.variant_title,
            "sku": self.sku,
            "barcode": self.barcode,
            "bin_location": self.bin_location,
            "assigned_at": (
                self.assigned_at.isoformat() if self.assigned_at else None
            ),
            "assigned_by": self.assigned_by,
        }


class BarcodeAlias(Base):
    """Maps a foreign ("fake") barcode — e.g. a manufacturer barcode on the
    box — to a known product, after an operator confirmed the link. Lives in
    its own app-owned table rather than a column on the TELCAN mirror tables,
    which get rewritten by the Shopify sync.

    Scans of an alias resolve to the product but carry a warning flag so the
    UI can ask for confirmation (skippable per session for bulk work)."""

    __tablename__ = "rfid_barcode_aliases"

    id: Mapped[int] = mapped_column(primary_key=True)

    # The scanned foreign barcode.
    alias_barcode: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )

    # Product anchor + display snapshot (SKU is the stable key both TELCAN
    # and the Shopify API agree on).
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    barcode: Mapped[str | None] = mapped_column(String(64))
    product_title: Mapped[str | None] = mapped_column(String(255))

    created_by: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "alias_barcode": self.alias_barcode,
            "sku": self.sku,
            "barcode": self.barcode,
            "product_title": self.product_title,
            "created_by": self.created_by,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
        }


class SerialPrefix(Base):
    """Brand serial-number prefixes. Some manufacturers (Astronomik) put a
    product identifier in the first digits of each unit's serial number and
    barcode the serial — so the barcode differs per unit, but its prefix
    identifies the product. Loaded from the manufacturer's mapping sheet via
    load_astronomik.py; scans resolve prefix -> SKU."""

    __tablename__ = "rfid_serial_prefixes"

    prefix: Mapped[str] = mapped_column(String(8), primary_key=True)
    brand: Mapped[str] = mapped_column(String(50), nullable=False)
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    item_name: Mapped[str | None] = mapped_column(String(255))
    # Operator-preferred short name, printed on labels in place of the store
    # name. Starts empty (a default is derived from item_name at lookup
    # time); once an operator saves one it sticks — the xlsx loader never
    # writes this column, so sheet reloads can't clobber it.
    label_name: Mapped[str | None] = mapped_column(String(255))
    # Optional operator note shown loudly whenever this prefix is scanned
    # (e.g. "part of a 3-filter set — ONE tag per set"). Loader never
    # touches it.
    scan_note: Mapped[str | None] = mapped_column(String(255))

    def as_dict(self) -> dict:
        return {
            "prefix": self.prefix,
            "brand": self.brand,
            "sku": self.sku,
            "item_name": self.item_name,
            "label_name": self.label_name,
            "scan_note": self.scan_note,
        }


class BarcodeChange(Base):
    """Audit log of barcode overwrites: an operator replaced a product's
    real Shopify barcode with a scanned (usually manufacturer) barcode.
    One row per change — who, when, old and new — so accidents are easy
    to trace and reverse."""

    __tablename__ = "rfid_barcode_changes"

    id: Mapped[int] = mapped_column(primary_key=True)

    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    product_title: Mapped[str | None] = mapped_column(String(255))
    shopify_variant_id: Mapped[str | None] = mapped_column(String(64))
    # What was replaced: "barcode" or "sku" (old_/new_ hold either kind).
    changed_field: Mapped[str] = mapped_column(
        String(20), nullable=False, default="barcode",
        server_default="barcode",
    )
    old_barcode: Mapped[str | None] = mapped_column(String(64))
    new_barcode: Mapped[str] = mapped_column(String(64), index=True)

    changed_by: Mapped[str | None] = mapped_column(String(100))
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "sku": self.sku,
            "product_title": self.product_title,
            "shopify_variant_id": self.shopify_variant_id,
            "changed_field": self.changed_field,
            "old_barcode": self.old_barcode,
            "new_barcode": self.new_barcode,
            "changed_by": self.changed_by,
            "changed_at": (
                self.changed_at.isoformat() if self.changed_at else None
            ),
        }


class PrintJob(Base):
    """One queued Zebra label: print the barcode AND encode the EPC into the
    sticker's RFID chip in a single pass.

    One row = one physical label = one pre-generated EPC. The local print
    agent (print_agent.py on the printer laptop) claims pending jobs, drives
    the printer, and reports back; on success the server auto-creates the
    matching RfidAssignment — no manual tag scan needed for printed labels.

    Lifecycle: pending -> printing -> done | error   (pending -> canceled)
    """

    __tablename__ = "rfid_print_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)

    # The EPC this label will carry, generated at queue time.
    epc: Mapped[str] = mapped_column(
        String(128), unique=True, index=True, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(20), index=True, nullable=False, default="pending"
    )

    # Product snapshot for the label text (same shape as assignments).
    barcode: Mapped[str | None] = mapped_column(String(64))
    sku: Mapped[str | None] = mapped_column(String(100))
    product_title: Mapped[str] = mapped_column(String(255), nullable=False)
    variant_title: Mapped[str | None] = mapped_column(String(255))
    bin_location: Mapped[str | None] = mapped_column(String(100))
    # Printed under the bin ("BIN: G2-1. Other: B17") for products whose
    # boxes are split across shelves.
    other_bins: Mapped[str | None] = mapped_column(String(255))
    shopify_variant_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # 300 not 64: TELCAN-sourced ids are "handle:<shopify-handle>" and
    # handles run up to 255 chars.
    shopify_product_id: Mapped[str | None] = mapped_column(String(300))

    # Operator-preferred label name (serialized brands like Astronomik, or
    # per-SKU custom names); when set, the agent prints it per placement.
    label_name: Mapped[str | None] = mapped_column(String(255))
    # Where the name goes: "header" replaces the store name, "sku" replaces
    # the SKU line above the barcode. NULL = header (back-compat).
    label_placement: Mapped[str | None] = mapped_column(String(10))

    requested_by: Mapped[str | None] = mapped_column(String(100))
    error: Mapped[str | None] = mapped_column(String(500))

    # Set when the job came from a bin batch (Batch Tagging tab); the Print
    # Queue groups and reports per batch.
    batch_id: Mapped[int | None] = mapped_column(Integer, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    printed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "epc": self.epc,
            "status": self.status,
            "batch_id": self.batch_id,
            "barcode": self.barcode,
            "sku": self.sku,
            "product_title": self.product_title,
            "variant_title": self.variant_title,
            "bin_location": self.bin_location,
            "other_bins": self.other_bins,
            "shopify_variant_id": self.shopify_variant_id,
            "shopify_product_id": self.shopify_product_id,
            "label_name": self.label_name,
            "label_placement": self.label_placement,
            "requested_by": self.requested_by,
            "error": self.error,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
            "printed_at": (
                self.printed_at.isoformat() if self.printed_at else None
            ),
        }


class Batch(Base):
    """One bin-tagging session (Batch Tagging tab): walk to a bin, scan every
    box, print one label per box, apply them, pair each label's EPC, verify.

    Lifecycle: collecting -> printing -> pairing -> done  (any -> abandoned)
    Inventory/bin mismatches never block the batch — they become ReviewTasks
    at completion instead of demanding fixes at the shelf."""

    __tablename__ = "rfid_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    bin_name: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), index=True, nullable=False, default="collecting"
    )
    created_by: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # Stamped the first time the operator runs the Verify sweep.
    verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # Which step whoever's driving is on (collect/check/print/pair/verify).
    # Status alone can't carry this — collect and check are both
    # "collecting" — so terminals watching the same batch use this to
    # follow along.
    ui_step: Mapped[str | None] = mapped_column(String(20))

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "bin_name": self.bin_name,
            "status": self.status,
            "created_by": self.created_by,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
            "completed_at": (
                self.completed_at.isoformat() if self.completed_at else None
            ),
            "verified_at": (
                self.verified_at.isoformat() if self.verified_at else None
            ),
            "ui_step": self.ui_step,
        }


class BatchItem(Base):
    """One unique product inside a batch: how many boxes were scanned, the
    product snapshot for labels, and pairing progress. Unknown barcodes are
    kept as unresolved rows so the physical count isn't lost."""

    __tablename__ = "rfid_batch_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)

    # What the scanner actually read the first time (serial, alias, barcode).
    scanned_code: Mapped[str] = mapped_column(String(64), nullable=False)
    resolved: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="1"
    )

    shopify_variant_id: Mapped[str | None] = mapped_column(String(64))
    shopify_product_id: Mapped[str | None] = mapped_column(String(300))
    product_title: Mapped[str | None] = mapped_column(String(255))
    variant_title: Mapped[str | None] = mapped_column(String(255))
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    barcode: Mapped[str | None] = mapped_column(String(64))
    # The product's SAVED bin at scan time (labels use the batch's bin).
    bin_location: Mapped[str | None] = mapped_column(String(100))
    # Other shelves this same product also lives on, comma-joined.
    other_bins: Mapped[str | None] = mapped_column(String(255))
    serial_prefix: Mapped[str | None] = mapped_column(String(8))
    label_name: Mapped[str | None] = mapped_column(String(255))
    image_url: Mapped[str | None] = mapped_column(String(500))

    qty_scanned: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Shopify on-hand (TELCAN mirror) when first scanned; None when unknown.
    expected_qty: Mapped[int | None] = mapped_column(Integer)
    paired_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "batch_id": self.batch_id,
            "scanned_code": self.scanned_code,
            "resolved": self.resolved,
            "shopify_variant_id": self.shopify_variant_id,
            "shopify_product_id": self.shopify_product_id,
            "product_title": self.product_title,
            "variant_title": self.variant_title,
            "sku": self.sku,
            "barcode": self.barcode,
            "bin_location": self.bin_location,
            "other_bins": self.other_bins,
            "serial_prefix": self.serial_prefix,
            "label_name": self.label_name,
            "image_url": self.image_url,
            "qty_scanned": self.qty_scanned,
            "expected_qty": self.expected_qty,
            "paired_count": self.paired_count,
        }


class BinMapEntry(Base):
    """Which bin each variant lives in, per Shopify metafields. Bins exist
    ONLY as metafields (the TELCAN mirror's Bin_Name is empty store-wide),
    so a background job walks the whole catalog through the Shopify API and
    rewrites this table — batch creation then answers "what's expected in
    bin X" instantly, even right after an app restart."""

    __tablename__ = "rfid_bin_map"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    barcode: Mapped[str | None] = mapped_column(String(64))
    product_title: Mapped[str | None] = mapped_column(String(255))
    variant_title: Mapped[str | None] = mapped_column(String(255))
    shopify_variant_id: Mapped[str | None] = mapped_column(String(64))
    shopify_product_id: Mapped[str | None] = mapped_column(String(300))
    bin: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    # One row per bin: a product split across shelves ("G2-1 & B17") gets a
    # row for each, and each row names the others here.
    other_bins: Mapped[str | None] = mapped_column(String(255))
    qty: Mapped[int | None] = mapped_column(Integer)
    image_url: Mapped[str | None] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class LabelName(Base):
    """Operator-preferred label header for NON-serialized products (serial
    brands keep theirs on SerialPrefix). When set, panel prints put this
    name at the top of the label instead of the store header."""

    __tablename__ = "rfid_label_names"

    sku: Mapped[str] = mapped_column(String(100), primary_key=True)
    label_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # "header" (replaces the store name) or "sku" (replaces the SKU line).
    placement: Mapped[str] = mapped_column(
        String(10), nullable=False, default="header", server_default="header"
    )
    updated_by: Mapped[str | None] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class HiddenBin(Base):
    """Bins the operator ticked off the work list — empty shelves, bins
    someone else handles, anything not worth tagging. Hidden, never
    deleted: the board can show them again on demand."""

    __tablename__ = "rfid_hidden_bins"

    bin: Mapped[str] = mapped_column(String(100), primary_key=True)
    hidden_by: Mapped[str | None] = mapped_column(String(100))
    hidden_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class EpcCapture(Base):
    """One RFID sweep sent from the C72 companion app: the operator scans a
    shelf freely (everything held on the device), then hits Send once —
    Wi-Fi to Azure, no Bluetooth involved. The PC browser pulls the latest
    capture into the batch-verify step (or future audits)."""

    __tablename__ = "rfid_epc_captures"

    id: Mapped[int] = mapped_column(primary_key=True)
    device: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(String(255))
    # Set when the sweep was taken during a bin batch, so the terminal
    # watching that batch knows the sweep is meant for it.
    batch_id: Mapped[int | None] = mapped_column(Integer, index=True)
    epc_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Newline-joined unique EPCs. Text, not String: sweeps of a full rack
    # can be thousands of tags.
    epcs: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def as_dict(self, with_epcs: bool = False) -> dict:
        d = {
            "id": self.id,
            "device": self.device,
            "note": self.note,
            "batch_id": self.batch_id,
            "epc_count": self.epc_count,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
        }
        if with_epcs:
            d["epcs"] = self.epcs.split("\n") if self.epcs else []
        return d


class ReviewTask(Base):
    """The system's task inbox (Review tab): anything the software noticed
    but shouldn't fix on its own — inventory count mismatches, unresolved
    barcodes, incomplete pairing. Created by batches (and later audits);
    resolved or dismissed by an operator, never auto-closed."""

    __tablename__ = "rfid_review_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    product_title: Mapped[str | None] = mapped_column(String(255))
    detail: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), index=True, nullable=False, default="open"
    )
    batch_id: Mapped[int | None] = mapped_column(Integer)

    created_by: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    resolved_by: Mapped[str | None] = mapped_column(String(100))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_note: Mapped[str | None] = mapped_column(String(255))

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "category": self.category,
            "sku": self.sku,
            "product_title": self.product_title,
            "detail": self.detail,
            "status": self.status,
            "batch_id": self.batch_id,
            "created_by": self.created_by,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
            "resolved_by": self.resolved_by,
            "resolved_at": (
                self.resolved_at.isoformat() if self.resolved_at else None
            ),
            "resolution_note": self.resolution_note,
        }
