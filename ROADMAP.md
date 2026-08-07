# RFID Inventory System — Roadmap

Source of truth for project status. Updated by Claude each working session.
Last updated: 2026-08-07.

## 🔶 Current field-test round (C72 v3.27, installed from the terminal)

Everything below shipped 2026-08-03 → 08-06 and works in tests/browser;
Nick is running the bins and feeding fixes back same-day. Since v3.21:
- Batches start (scan a bin barcode) and abandon on the gun; already-
  tagged dialog gained recorded-shelf + sweep-to-count (v3.22).
- Web verify: flagged rows expand into a resolution panel (new vs
  already-tagged counts summed against expected); detected accepted at
  X or X+Y, flagged only in between/overflow; double-count guard at
  Check with one-tap fix (v3.23).
- **Lookups answer from the LIVE bin map, mirror demoted to fallback**
  (the F9394B-printed-as-DB24010501 fix — see CLAUDE.md hard rule).
- "Move product to this bin" now clears its flag (open-batch bin
  snapshots move with the update).
- Bin audit: sweep any shelf vs Shopify (verify-style diffs, on-hand
  button, untagged toggle, record-as-batch-tagged rescue, "already
  recorded" notice naming abandoned attempts).
- Scan a tag → full identity + warnings (orphan SKU, wrong bin, case,
  suspect) + UNLINK with History receipt (TODO #8 done, v3.26);
  identify is a trigger-armed toggle (v3.27). Tap the scanner input to
  type (v3.25).
- Inventory tab shows ON-HAND (was "available" — negative on oversells).
- **Bin-fix offers (2026-08-07):** a walked batch counts as a deep manual
  check of its shelf, so products it physically handled whose Shopify bin
  disagrees (or is missing) get a "bin ⇢ <bin>" button on their Verify
  row, and Inventory rows whose tag placement disagrees with Shopify's
  bin get "⇢ Shopify" — both are the existing audited /api/bin-updates
  write (History + bin map + tags follow). Untouched pre-seed rows never
  offer (the batch proves nothing about them); split-shelf listings that
  include the bin count as agreement. Inventory bin chip no longer wraps
  mid-code ("K4-" / "1").
- Unbuilt ideas on the table: Review resolve-actions per category
  (analysis done, nothing built), point-reads clamping their own power
  (metal-shelf misreads at power 30), docs/inventory-verification-app.md
  for the 1-left-check tie-in.
- Already-tagged flow: first scan of a product with prior tags asks how
  many boxes are stickered (one-screen stepper + held-box checkbox,
  v3.20); verify counts those boxes everywhere (web + C72 + server).
- Wrong-shelf review at Check: per-item keep-or-move with product
  cards; KEEP = audited bin update, MOVE = side trip; warns when the
  home shelf already holds recorded tagged boxes (v3.21).
- C72 verify popup rebuilt on the whole-bin check (SKUs shown, off-map
  products counted, tappable preview cards) (v3.18–3.19).
- Side trips excluded from "Recently done"/bin-done everywhere; History
  labels them as side trips.
- Verify tag ownership is CI-SKU alone (replaced barcodes no longer
  read as "foreign"); flagged verify rows expand into a resolution
  panel (new/already-tagged counts vs expected); detected accepted at
  X or X+Y, flagged in between.
- Audit tab: sweep-a-bin audit (C72 SWEEP → SEND → pull vs any bin;
  Check-step verdicts, strays, unknown tags; display only).
- LOCATE tab (v3.24) — Steve's TODO #5 + the locate backlog item,
  built: RSSI hunt, FAR/NEAR/TOUCH power, geiger audio, power-1
  confirm-a-find that filters found boxes. FIELD TESTED 2026-08-06
  (Nick): works, but finicky around the metal bins (multipath) — usable
  as-is; tuning knobs identified (smoothing weight, best-of window,
  dBm range) if it starts to annoy.

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

## 📦 Receiving — ✅ SHIPPED 2026-08-07 (server + web + C72 v3.29)

Both features below are BUILT, tested (14/14 suites incl. new test_link +
test_receiving), browser-verified on the seed server, and deployed.
Prod got the one-off `rfid_batches.kind` ALTER (dev/alter_add_batch_kind.py)
before the deploy. Field test pending — Nick has the v3.29 APK link.
Also shipped same day (C72 v3.28): settings redesign (Connection
sub-window + switches + strongest-tag-on-trigger toggle) and the
open-batch picker cards.

What shipped, per the design below: LINK tab (barcode + RFID relay,
outcome ding/buzz, web C72 LINK toggle on Scan Station, operator-keyed by
device name); receiving batches (RECEIVING sentinel bin, repeatable PRINT
of only-unlabelled boxes with home-bin labels, no-bin items held out by
name, pair records home bin, verify/side-trip/wrong-bin/count-mismatch
all correctly refuse or stay silent, finish files per-bin "bin-check"
Review tasks + History receiving-started/completed); manual
POST /api/review/bin-checks (bins list or rack= prefix). Web: Start
receiving button, collect→print→pair chips, print/finish bar. C72:
START RECEIVING in the picker, COLLECT⟳/PAIR⟳ loop, EXIT → FINISH
RECEIVING with per-bin summary.

### Original design (2026-08-07, agreed with Nick)

Two features cover every receiving workflow (desk, pallet, or a mix).
Planner (TC-Inventory-Planner) integration deliberately SKIPPED for v1:
invoices are often wrong, shipments arrive partial, boxes sometimes have
no distributor barcode — so receiving is open-ended manual capture, not
PO reconciliation. (The planner repo is now fully pulled at
`Desktop\Stuff\Inventory Planner`; it already has stock orders,
`/receive`, and an increase-only Shopify apply flow — that tie-in is
Steve's TODO #2, still open, later.)

**Feature A — LINK tab (C72): gun as a networked input device.**
- New C72 tab arms BOTH inputs: BT-scanner barcodes and trigger RFID
  reads (existing strongest-of-600ms pick). Each scan POSTs to the
  server immediately — no Bluetooth to the PC, ever.
- Web terminal gets a "C72 LINK" toggle (Scan Station first); while on,
  it polls ~1s and treats incoming barcodes exactly like wedge input and
  EPCs like tag scans — same code paths, every existing guard intact.
- Scans keyed to the operator-picker identity (two guns = two streams).
- Feedback on both ends: gun dings on delivery, then gets the outcome
  (paired ✓ / duplicate 409 / no product selected) so the user isn't
  glued to the monitor; web shows the same on the product card.
- Pairing may be driven from the gun OR the computer — LINK just makes
  the gun an extension of whichever screen is driving.

**Feature B — receiving batches (server + web + C72).**
- Batch kind = 'receiving' (new column → one-off ALTER for prod). No
  bin. Excluded from bin-done/"Recently done" like side trips; History
  labels it as receiving.
- Loop, not a line: collect → PRINT → pair → back to collect, as many
  passes/pallets as needed. PRINT is repeatable and queues labels only
  for collected-but-unprinted boxes, in scan order (sticker stack
  matches the walking order). Confirm screen shows "new since last
  print" to catch re-scanned boxes; printed-vs-paired ticker flags
  orphan labels at finish.
- Labels carry each product's HOME BIN (live bin map) so every box
  leaves the desk knowing where it goes. No-bin products: assign-a-bin
  prompt at print time (existing sanctioned bin write) or hold them out
  of the job.
- No-barcode boxes: typed SKU is first-class; distributor barcodes get
  linked once via the existing alias system.
- Finish: NO verify step. Instead files one Review task per bin that
  received stock ("Inventory check <bin>") + a manual mark-a-rack
  option. Nick confirmed per-bin volume is fine (~10/shipment; each is
  a quick RFID walk-scan). Resolving = run the existing bin audit on
  that shelf — on-hand updates happen ONLY through the audit's existing
  operator-confirmed increase-only button. Receiving itself never
  touches counts (standing decision holds).
- Printer walks between passes are acceptable (small warehouse; the
  printer sits on the desk, so desk receiving has zero walks).

Build order was A then B, as planned. Open receiving follow-ups:
- ✅ SHIPPED 2026-08-07: Review "bin-check" cards now carry a one-tap
  "run audit" jump — lands on the Audits tab with the bin loaded, and if
  the newest C72 sweep is under 5 minutes old (the operator clearly just
  walked the shelf) the audit runs itself; a stale sweep instead gets a
  "walk-scan <bin>, then RUN" prompt naming the sweep's age. Fixing the
  age math surfaced an app-wide bug: server timestamps are UTC but
  unsuffixed, so new Date() read them as LOCAL and everything under 4 h
  old displayed "just now" — all client-side timestamp parsing now goes
  through tsDate() (assumes UTC when no zone is present).
- The C72 item editor's change-bin flow is how held no-bin products get
  bins at the desk; a dedicated prompt at PRINT time could streamline it.
- On-hand counts still only move via the bin audit's gated button
  (standing decision holds).

## ⚡ Bulk scan on the web Scan Station — ✅ DEPLOYED 2026-08-07

Nick approved the preview; deployed same day. BULK chip lives beside
auto-reset INSIDE the Scan RFID cell (auto-reset moved out of Settings);
chip is disabled/gray unless auto-reset is on and defaults OFF per
product. Tracks tags assigned vs labels printed this visit: exact →
auto-reset, over → inline warning with UNDO THIS SWEEP (SKU-guarded,
only the offending sweep; hover text points at History for more) and
KEEP ALL (won't re-ask until the count grows). Sweeps write with one
shared timestamp so History folds them into "N × RFID tag (sweep)"
expandable rows (▸ show EPCs); undos fold the same way. Sweep assigns
never steal: already-assigned tags are skipped and named. Server:
POST /api/rfid-assignments/sweep + /sweep/undo. test_bulkscan (14).

## 🔗 TC-Planner bridge — ✅ phase 1 (READ-ONLY) DEPLOYED 2026-08-07

The RFID server now talks to TC-Planner (tc-planner-app, same resource
group). STRICTLY read-only: it answers "is this SKU on an open purchase
order, how many are still expected" — it never files receipts, never
changes PO statuses, never emails vendors, never touches Shopify stock.

- `app/planner.py`: Bearer-token client (PLANNER_URL + PLANNER_TOKEN app
  settings; token unset = bridge off, all surfaces degrade silently).
  Per-SKU answers cached 5 min; planner outages fail SOFT (ok=False,
  still 200) because hints must never break a scan.
- Endpoints: GET /api/planner/status, GET /api/planner/on-order/{sku}
  (open-PO lines for that exact CI SKU with ordered/received/remaining).
- UI: "📦 On order: N more expected — PO#935 Sky-Watcher (ETA …)" hint
  on the Scan Station product card AND under the receiving-batch collect
  result. Hidden when off/down/nothing-on-order. test_planner (8).
- Verified against the LIVE planner: 45 open POs, 320 on-order SKUs;
  prod smoke S11710 → 6 expected on PO#935.
- Currently authenticated with the planner's shared token (shows as
  "Unknown" in planner attribution). A dedicated RFID entry in
  TC_PLANNER_USER_TOKENS is the right move before any phase 2 —
  needs Nick/Steve (adding one restarts the planner app).
- Found in passing (planner-side, NOT fixed): GET
  /api/replenishment/summary 500s with "unsupported operand type(s)
  for +=: 'float' and 'decimal.Decimal'". /api/refresh/status is idle
  and PO detail's live Shopify bin fetch works, so the shpat token
  itself looks healthy.

**Phase 2 plan (NOT built — Nick/Steve to approve):** finishing a
receiving batch offers an operator-confirmed "file against PO" step:
match the batch's counted SKUs to open-PO lines, preview per PO, then
POST /receive on confirm (planner-local only — its own Shopify write,
apply-stock-update, stays untouched; our standing never-auto-write
decision holds on both sides). Same offer from Scan Station sessions is
possible once wanted. This is the on-ramp to Steve's TODO #2.

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

6. ~~**Scan a batch of tags, then pick the closest by signal strength.**~~
   ✅ Done 2026-08-03 (C72 v3.15): every trigger read (batch pair + Scan
   Station) now listens ~600 ms, collects every answering tag with its
   RSSI, and pairs the STRONGEST — with a status note when several
   answered, and a caution when the runner-up was within 2 dB. Falls back
   to most-often-heard if the SDK returns no usable RSSI. Field test at
   the warehouse still pending.

7. **Unpair a single product during collect,** instead of undoing the
   whole batch because one product was got wrong early on.

8. **Scan an RFID tag and be told what it is,** with actions — chiefly
   unpair, so a mis-tagged sticker can be re-tagged as the right product
   during or after batch collection.

9. ~~**"?" help icon on every usable C72 window**~~ ✅ Done 2026-08-03
   (C72 v3.15): a "?" next to the drawer button explains the CURRENT
   screen — each batch step (collect/check/pair/verify) gets its own
   text, plus Scan Station, Sweep, Find Bin, Locate, and the batch list.
   The item editor has its own "?" covering every control in it. Still a
   slice of item 4; the full guided-workflow redesign remains open.

10. **Support page: name + message → opens a GitHub issue** (added
    2026-07-29; reworked same day — was "email Nicholas Drapak directly",
    now a GitHub issue on this repo instead, no direct email at all).
    A user leaves their name and a message; the server opens an issue
    titled from the message with name + message in the body. Nicholas
    gets notified through GitHub's own watch/notification settings, which
    kills the two hardest parts of the email version: no sending
    mechanism to build, and no personal address to keep correct. What it
    needs instead: a repo-scoped GitHub token stored as an Azure app
    setting, because warehouse users won't have GitHub accounts — the
    SERVER files the issue on their behalf. Rate-limit or dedupe the
    endpoint lightly so a stuck scanner can't file fifty issues. Still
    open: whether the C72, the web terminal, or both get the page.

11. **Print labels FROM the C72 and pair them there — no PC/iPad in the
    loop at all** (added 2026-08-03; noted only, not designed). Today the
    C72 collects and pairs, but queueing labels and closing batches still
    route through the web terminal. Goal: the C72 queues the print jobs
    itself (the print agent already polls the server, so "printing from
    the C72" is really just "queueing from the C72") and walks the whole
    collect → labels → pair flow standalone. Needs a C72 UI for the
    label/print step and a think about where the Check step's human
    decisions land when no big screen is involved.

## 🗓️ Later / backlog

- **The "1-left check" app** (separate system — Inventory Verification,
  the one that asks a human to confirm 0/1-left counts). Reconnaissance
  written up in [docs/inventory-verification-app.md](docs/inventory-verification-app.md):
  where it lives, its full endpoint list, that it's webhook-driven, and
  that all ten operator-facing endpoints are ANONYMOUS. Possible RFID
  tie-in: its queue is 200+ items, and tag data can already speak to any
  batch-tagged SKU — read-only join first. Do NOT start without asking;
  its backend source isn't recoverable yet and its API needs auth first.
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
- **The TELCAN mirror is REMOVED from the app (2026-08-07, Nick's
  call).** Its dead sync (stalled 2025-12-08) poisoned records through
  every path it was left in — last straw: batch 126's ToupTek shelf got
  renamed SKUs (G3M662C for the live G3M662C-L) and handles cross-wired
  to the wrong products, breaking Shopify links and Review photos.
  509 records repaired via dev/repair_mirror_records.py (374 tags, 135
  batch items, 2 review tasks; 18 SKU transitions, History receipts by
  "mirror-repair"). Lookup order is now live bin map → live Shopify API,
  nothing else. The dbo.Shopify_* tables still sit in the database
  unused; dropping them is Steve's call.
- Expected/shelf counts display Shopify ON-HAND, pulled LIVE from the
  Shopify API (inventoryLevels quantities); the bin map's live-sourced
  snapshot (≤6h old) is the only offline fallback.

- Bins live in Shopify metafields (stock.bin → my_fields.bin_location);
  the TELCAN mirror's Bin_Name is empty store-wide
- ZD220t cannot RFID-encode → print agent runs --no-rfid; pairing is
  always two-scan
- Astronomik name-at-top labels: Scan Station only, everywhere else
  prints store header + SKU
- New Shopify-write features ship blocked until explicitly promoted
  (SHOPIFY_WRITE_MODE)
