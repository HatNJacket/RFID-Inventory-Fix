# RFID Inventory System — Roadmap

Source of truth for project status. Updated by Claude each working session.
Last updated: 2026-07-26.

## Architecture (target)

All logic lives server-side (Azure FastAPI + Azure SQL). Every device is a
terminal: PC (printing, batch start, review), iPad (optional live
view/edit), C72 (primary shelf tool: barcode collect + RFID pair + verify).
Operator returns to the PC only to collect printed stickers and start the
next bin.

## ✅ Done

### Scan Station (single-product flow)
- Barcode → product lookup: TELCAN mirror first, Shopify API fallback
- Two-scan RFID pairing (barcode, then tag) with duplicate/suspect guards
- Label printing: Zebra ZD220t via print agent on the warehouse laptop
  (barcode-only mode — no RFID encode; pairing stays two-scan)
- Label layout: "Telescopes Canada" header + SKU + Code 128 + BIN,
  centered/calibrated for 2.125×1.25" stickers
- Product edits with confirmation: barcode overwrite, SKU update, bin move
  (all audited, all gated by SHOPIFY_WRITE_MODE)
- Barcode alias system: link unknown codes to products; undo from History
- Astronomik serials: prefix→product resolution, operator-confirmed label
  names (name-at-top labels are Scan Station ONLY), auto-print on scan,
  register-new-prefix UI
- Operator picker; auth = Shopify session tokens (embedded) + station key

### Batch Tagging (bin-first flow)
- Enter bin → pre-seeded expected products with 0/N tickers
  (bin map: Shopify metafield walk, ~3,200 binned variants across ~290
  bins, refreshed every 6h, multi-worker safe)
- Scan counts up tickers; over-scan allowed; unknown barcodes appended;
  scanned rows float to top; collect summary line
- Bin mismatch prompt: keep saved bin / move product (confirmed write)
- Label step: SKU-labeled store labels, one per box, batch bin printed
- Pair stage: product barcode selects, EPC scans pair, 409 on duplicates
  (names the owning product), undo last tag, barcode-shaped non-matches
  rejected (never saved as EPCs)
- Verify stage: RFID sweep (C72 app "Pull latest sweep" or wedge) →
  per-product boxes/paired/detected + foreign/unknown report
- Complete → auto-files Review tasks (count mismatch, pairing incomplete,
  unresolved barcode); abandon; cross-device resume + Refresh

### Other tabs
- Print queue: job table, cancel pending, reprint (new EPC), printer-agent
  online/offline pill (heartbeat)
- History: merged append-only timeline (assignments, edits, labels,
  aliases, batches, review tasks) + search + undo for barcode links
- Review: open-task inbox with resolve/dismiss
- Audits: placeholder (recommended checks + recent C72 sweeps)
- Inventory: product summary with live Shopify quantities

### C72 companion app (TC RFID Sweep, v1.2)
- Native Chainway app; wireless install from
  https://telcan-rfid.azurewebsites.net/static/tc-rfid-sweep.apk
- RFID sweep: trigger-toggled inventory, on-device dedupe + counts,
  SEND over Wi-Fi → server → "Pull latest C72 sweep" in batch verify
  (no Bluetooth anywhere)
- Power: 1–30 slider + presets (2 station / 5 bin / 10 rack / 30 locate)
- BARCODE mode (v1.2, built, NOT yet field-tested): 2D imager via SDK,
  ding/buzz sounds, deduped list — capability test for the C72-first
  workflow
- UTF-8 build fix (garbled …/✓ characters)

### Infrastructure
- Azure App Service deploy pipeline (zip deploy), Azure SQL (TELCAN),
  bin map table, SHOPIFY_WRITE_MODE safety gate (default: scan-station
  writes only), print agent heartbeat

## 🔶 In progress / blocked

- **C72 v2.0 FIELD TEST** (deployed 2026-07-26): tabbed app —
  BATCH | STATION | SWEEP | LOCATE(WIP), tabs hideable in ⚙. Batch
  screen: bin+boxes top-left, tappable COLLECT/PAIR chip top-right,
  PWR chip → power dialog, product preview card (image/name/SKU +
  scanned/expected tracker in the corner), scan list owns the screen.
  Station tab = single-product tag linking with the same card. Live web
  mirror (3s poll) while a batch is open.
  ACTION (Steve): install v2.0, pair the BT scanner, run one real bin
  end to end.
- Built-in imager: confirmed absent (no aimer light, instant
  DECODE_FAILURE) — barcodes come from the BT scanner permanently.
- **Print agent update on warehouse laptop** — ACTION (Steve): copy the
  repo's updated print_agent.py to the laptop and restart the agent
  (removes the old auto-Astronomik header rule).
- **Inventory-check screenshot** — ACTION (Steve): attach it so the batch
  UX revamp matches the look of the old system.

## 🔜 Next up (the revamp — after the C72 barcode test)

- C72-first batch workflow (the 8-step flow):
  server endpoints for barcode-driven collect + pair; C72 app batch
  screen: pick bin → collect with dings + expected tickers → pair
  (barcode, then its stickers) → confirm; iPad/PC become live views
- Batch UX revamp (web):
  - clickable stage chips (go back to any earlier step)
  - product image previews in collect rows (bin map gains image column);
    roomier, less compact cards
  - sounds: ding = expected match, distinct ding = valid product not
    expected in this bin, buzz = no match
  - glow: green border when scanned == expected, red when over
  - completion screen with per-product stock deltas ("+1 (5 → 6)") to
    confirm before filing inventory changes

## 🗓️ Later / backlog

- Locate mode: max-power geiger-counter search for a specific EPC on the
  C72 (SDK supports radar/location APIs)
- Weak-RFID product flag (e.g. Optolong filters detune stickers): verify
  treats them as barcode-confirm instead of expecting tag reads
- Audits tab, real version: shelf audit + reconciliation (sweep rack →
  compare vs assignments + Shopify → missing/mismatch report),
  assumed-sold lifecycle, ambiguity groups
- Stock-number write-back to Shopify (needs SHOPIFY_WRITE_MODE
  "production" + confirm flow)
- Barcode captures upload from C72 (SEND in barcode mode)
- Tap-to-copy EPCs in tag lists
- On-metal / spacer sticker sourcing decision for problem SKUs

## 📌 Standing decisions

- Bins live in Shopify metafields (stock.bin → my_fields.bin_location);
  the TELCAN mirror's Bin_Name is empty store-wide
- ZD220t cannot RFID-encode → print agent runs --no-rfid; pairing is
  always two-scan
- Astronomik name-at-top labels: Scan Station only, everywhere else
  prints store header + SKU
- New Shopify-write features ship blocked until explicitly promoted
  (SHOPIFY_WRITE_MODE)
