# The "1-left check" app — findings for whoever picks it up

Reconnaissance notes on **Inventory Verification**, the separate app that
asks a human to confirm products Shopify shows as 0 or 1 left. Written
2026-08-06 from a read-only investigation, so a future session doesn't
re-derive it. **This is a different system from the RFID project** — it
shares the Azure resource group and the Shopify store, nothing else.

Everything under "Verified" was checked directly. Anything inferred is
labelled as such. Treat the whole file as a snapshot, not live truth.

## What and where (verified)

| Piece | Where |
|---|---|
| Frontend | `https://shopifyautomationsa.z13.web.core.windows.net` — a single self-contained `index.html` (486 lines, 59 KB, plain HTML/CSS/JS, no framework, no build step) in the `$web` container of storage account `shopifyautomationsa` |
| Backend | Azure Function App **`inventory-verification-func`**, resource group `shopify-automation-rg` |
| API base | `https://inventory-verification-func.azurewebsites.net/api/api` — the doubled `api` is Azure's default host prefix plus each function's own `api/…` route |

Custom-built for Telescopes Canada: TC green branding, their name in the
title, and a hard-coded operator list (Steve, Danielle) matching the RFID
Scan Station's operator-picker pattern.

## Endpoints (verified — `az functionapp function list`)

| Function | Method | Route | Auth |
|---|---|---|---|
| `get_pending` | GET | `api/pending` | ANONYMOUS |
| `get_history` | GET | `api/history` | ANONYMOUS |
| `get_issues` | GET | `api/issues` | ANONYMOUS |
| `confirm_item` | POST | `api/confirm` | ANONYMOUS |
| `bulk_confirm` | POST | `api/bulk-confirm` | ANONYMOUS |
| `update_stock` | POST | `api/update-stock` | ANONYMOUS |
| `update_bin` | POST | `api/update-bin` | ANONYMOUS |
| `update_barcode` | POST | `api/update-barcode` | ANONYMOUS |
| `import_skus` | POST | `api/import-skus` | ANONYMOUS |
| `report_issue` | POST | `api/report-issue` | ANONYMOUS |
| `close_issue` | POST | `api/close-issue` | ANONYMOUS |
| `inventory_webhook` | POST | `webhook/inventory` | FUNCTION |
| `inventory_sync_webhook` | POST | `webhook/inventory-sync` | FUNCTION |

**It is webhook-driven, not polling** (inferred from the two webhook
functions plus the `detected_date` field): Shopify notifies on inventory
change, and an item is queued for verification when it lands at 0 or 1.

## ⚠ The API has no authentication (verified)

Every operator-facing endpoint is `authLevel=ANONYMOUS` — confirmed in the
function configuration, not just by probing — and the frontend sends no key
or token. A plain unauthenticated `GET api/pending` returned the full queue
(200 items with titles, vendors and stock levels).

The **write** endpoints sit on the same anonymous base, so anyone who knows
the URL can very likely confirm counts, change bins and barcodes, and push
stock numbers to Shopify. Only the two Shopify webhooks are key-protected,
which is backwards from where the risk is.

Not tested: no write endpoint was ever called. The read result plus the
configuration make the conclusion safe without proving it destructively.

**Fix this before building anything automated on top.** The RFID app's
`STATION_KEY` header pattern (`app/auth.py`) drops straight in, and the
frontend is one file to update.

## `api/pending` item shape (verified)

```
sku, barcode, product_title, variant_title, vendor,
stock_bin, detected_date, inventory_item_id, variant_id,
current_stock: { available, committed, on_hand, pickups }
```

The UI has three tabs — Pending Verification, Issues, History — with
select-all + bulk confirm, inline bin/barcode edits, a stock-level
correction, issue reporting, SKU import from a file, and CSV export.

## Source code: not currently recoverable (verified)

The Function App is deployed run-from-package, so Kudu's file API 404s;
functions can be listed but not read. The frontend is fully readable
(a static site serves its own source) but write access to the `$web`
container was **not** established — it needs the storage account key or an
RBAC role assignment.

So: the app can be *called* freely, its frontend can be *read*, and its
backend behaviour cannot be *changed* until someone produces the source.

## Why the RFID project cares

The RFID system already knows how many tagged boxes exist per SKU and per
bin. The verification queue is 200 items and growing. For any SKU that has
been batch tagged, RFID data can speak to the question the app is asking a
human to walk the floor for.

The cheap, safe first version is **read-only**: a panel that pulls
`api/pending`, joins it against `rfid_assignments` by SKU, and shows which
pending items the tag data already answers and which genuinely need a
walk. No writes, no auth needed, nothing to secure first.

**Design caution:** a tag count is evidence a box exists, but this app
exists precisely *because* counts drift. Aim for "RFID says 1 tagged box
in I1-5 — confirm?" rather than silent auto-confirmation. Writing back at
all should wait until the API is authenticated.

## Suggested order

1. Get the backend source (ask whoever built it; otherwise extract the
   deployment package) — everything else is guesswork without it.
2. Put auth on the ten anonymous endpoints.
3. Only then consider the RFID join, read-only first.
