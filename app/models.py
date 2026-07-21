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

from sqlalchemy import DateTime, String, func
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

    def as_dict(self) -> dict:
        return {
            "id": self.id,
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
    shopify_variant_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # 300 not 64: TELCAN-sourced ids are "handle:<shopify-handle>" and
    # handles run up to 255 chars.
    shopify_product_id: Mapped[str | None] = mapped_column(String(300))

    requested_by: Mapped[str | None] = mapped_column(String(100))
    error: Mapped[str | None] = mapped_column(String(500))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    printed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "epc": self.epc,
            "status": self.status,
            "barcode": self.barcode,
            "sku": self.sku,
            "product_title": self.product_title,
            "variant_title": self.variant_title,
            "bin_location": self.bin_location,
            "shopify_variant_id": self.shopify_variant_id,
            "shopify_product_id": self.shopify_product_id,
            "requested_by": self.requested_by,
            "error": self.error,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
            "printed_at": (
                self.printed_at.isoformat() if self.printed_at else None
            ),
        }
