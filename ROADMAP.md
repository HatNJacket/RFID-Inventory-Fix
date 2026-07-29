# RFID Inventory System — Roadmap

Source of truth for project status. Updated by Claude each working session.
Last updated: 2026-07-29.

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
- Finish check (web + C72): the confirm shows per-product entered-by-RFID
  counts; finishing with untagged boxes requires an explicit are-you-sure
  naming how many products/boxes are missing ("Finish anyway")
- Complete → auto-files Review tasks (count mismatch, pairing incomplete,
  unresolved barcode); abandon; cross-device resume + Refresh

### Other tabs
- Print queue: job table, cancel pending, reprint (new EPC), printer-agent
  online/offline pill (heartbeat)
- History: merged append-only timeline (assignments, edits, labels,
  aliases, batches, review tasks) + search + undo for barcode links
- Per-product history: click any SKU in History (or look one up) →
  product panel + full timeline of that product's events, each marked
  Shopify ✓ (wrote to the store) or local (recorded here only)
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
- ~~Print agent update~~ RESOLVED 2026-07-27: the agent runs on the dev
  laptop FROM this repo directory (scheduled task "RFID Print Agent" →
  print_agent_loop.cmd), so agent fixes apply by restarting the process
  (loop relaunches in 10s). Header rule + long-name font fixes are live.
- **Inventory-check screenshot** — ACTION (Steve): attach it so the batch
  UX revamp matches the look of the old system.

## 🔜 Next up (the revamp — after the C72 barcode test)

- ✅ SHIPPED 2026-07-27 (round 3, C72 v2.5): batch ties are now
  batch-scoped — abandoning releases them, History can undo a whole
  batch's ties, and pairing can be undone wholesale for a re-scan;
  skip-printing goes straight to pairing; unresolved barcodes get a
  rescue flow (odd-barcode candidates → fix the Shopify barcode);
  wrong-shelf products can be dropped/moved/ignored; label format
  (Name / SKU / Both) editable per product in the Check step; pair
  ticker counts printed labels; verify auto-checks on pull, states
  whether boxes/paired/detected agree, and can look up any bin; C72
  gained a FIND BIN tab and a sweep-for-unlinked-tags rescue.
- ✅ SHIPPED 2026-07-27: ambiguous-barcode Check step (web + C72 v2.4).
  Batch flow is now linear Collect → Check → Pair on both surfaces; the
  Check step flags shared barcodes (candidate arrows, main listing
  default), count mismatches, unconfirmed serial names, unknown
  barcodes. Preferred names gained a placement toggle (store header vs
  SKU line) + ✕-to-clear. Field test pending.
- ✅ SHIPPED 2026-07-27: web batch UI mirrors the C72 (cards with
  image/SKU/Barcode/tracker, green/red glow, ding/other-ding/buzz
  sounds, clickable stage chips) and C72 v2.2 drawer (slide-in over
  content with scrim, header row reclaims the old tab bar's space,
  tones on the alarm stream so device media volume can't mute them).
  Field test pending.

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

## 📥 Steve's TODO list (captured 2026-07-28, not yet designed)

Noted verbatim-in-substance from Steve. **Not designed, not scoped, no
code written.** Do not start any of these without asking him first — the
first two in particular have ordering constraints that make "helpfully
starting early" actively harmful.

1. **Sync found inventory → Shopify on-hand.**
   ⛔ **Do not begin until the ENTIRE store is batch tagged.** Right now
   many products sit in the wrong place, and Steve is deliberately doing a
   manual hard reset of product locations. Writing on-hand numbers before
   every product is found, tagged and correctly binned would push wrong
   counts into Shopify. The counts we hold are observations until then.
   (See the standing decision on never auto-writing inventory.)

2. **Sync with incoming inventory (receiving).**
   Ideally one item at a time, with a permissioned bulk-add for a whole
   shipment, everything added flagged internally as needing tagging. Wins:
   incoming products are already in the system instead of the operator
   hunting untagged stock, and receiving stops being manual. Receiving is
   manual today only because a shipment can't be trusted to be 100%
   accurate — but if every incoming product is flagged for an inventory
   check (or the operator scans it in at the desk for a true count), the
   bulk path becomes safe.

3. **Finish the Review and Audits tabs.** Both are WIP stubs. Steve
   doesn't remember what each was for — work out the intended split before
   building (Review = task inbox from batch completion; Audits = shelf
   reconciliation, per the backlog entry below) and confirm with him.

4. **Make the C72 and web terminal genuinely usable by other people.**
   Steve can drive it because he co-designed it across ~100 commits; no
   one else can. Wants a full aesthetic redesign, guidance walking the
   user through every decision point, and more intuitive buttons. This is
   the difference between a tool one person can use and one the warehouse
   can use.

5. **Locate a product on the C72.** (Overlaps the locate-mode backlog
   entry below.)

6. **Scan a batch of tags, then pick the closest by signal strength.**
   Today a read takes the first tag seen, so the operator gets denied or
   mis-targeted when another tagged item is nearby. Reading several and
   choosing the strongest would make pairing precise and stop
   "too close to an already-scanned tag" failures. Needs a look at what
   the Chainway SDK exposes for RSSI per read.

7. **Unpair a single product during collect,** instead of undoing the
   whole batch because one product was got wrong early on.

8. **Scan an RFID tag and be told what it is,** with actions — chiefly
   unpair, so a mis-tagged sticker can be re-tagged as the right product
   during or after batch collection.

9. **"?" help icon on every usable C72 window** (added 2026-07-29),
   explaining how the current window is used. This is a concrete slice of
   item 4's guidance work — if item 4 gets built first, fold this into it
   rather than doing it twice.

10. **Support page: name + message → email to Steve** (added 2026-07-29).
    A user leaves their name and a message, and it lands in Steve's email
    ("if possible" — his phrasing). Note before building: the server has
    no email path today, so this needs a sending mechanism decision first
    (SMTP account, or something the existing Azure/Shopify accounts
    already provide). Worth deciding whether the C72, the web terminal,
    or both get the page.

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

- **NEVER auto-write inventory counts** — to Shopify or any inventory
  system, from any device. Batch counts are observations; a future
  write-back is a separate, explicit, operator-confirmed step and stays
  OFF (SHOPIFY_WRITE_MODE) until testing is done. Correcting a display
  problem means fixing where data is READ from, never overwriting stock.
- Expected/shelf counts display Shopify ON-HAND, pulled LIVE from the
  Shopify API (inventoryLevels quantities) — never from the TELCAN
  mirror, whose inventory sync went stale (last update 2025-12-08) and
  once served 8-month-old numbers. Mirror = fallback only when the API
  is down.
- ⚠ The TELCAN mirror sync appears DEAD since Dec 2025 (Steve to check
  the sync job someday): barcode/title lookups still work (API fallback
  covers post-Dec products), but mirror quantities are untrustworthy.

- Bins live in Shopify metafields (stock.bin → my_fields.bin_location);
  the TELCAN mirror's Bin_Name is empty store-wide
- ZD220t cannot RFID-encode → print agent runs --no-rfid; pairing is
  always two-scan
- Astronomik name-at-top labels: Scan Station only, everywhere else
  prints store header + SKU
- New Shopify-write features ship blocked until explicitly promoted
  (SHOPIFY_WRITE_MODE)
