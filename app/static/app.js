// Scan station logic.
//
// Two-scan loop:
//   barcode field (active) --scan--> lookup --> product shows -->
//   rfid field (active) --scan--> save --> back to barcode field.
//
// Scanners in keyboard/HID mode type the value and press Enter, so each
// field just listens for Enter. No hardware driver involved.

const el = {
  barcode: document.getElementById("barcode"),
  rfid: document.getElementById("rfid"),
  stepBarcode: document.getElementById("step-barcode"),
  stepRfid: document.getElementById("step-rfid"),
  productCard: document.getElementById("product-card"),
  pTitle: document.getElementById("p-title"),
  pVariant: document.getElementById("p-variant"),
  pSku: document.getElementById("p-sku"),
  pBarcode: document.getElementById("p-barcode"),
  pBin: document.getElementById("p-bin"),
  pSource: document.getElementById("p-source"),
  pTagCount: document.getElementById("p-tagcount"),
  tagsPanel: document.getElementById("tags-panel"),
  tagsList: document.getElementById("tags-list"),
  printPanel: document.getElementById("print-panel"),
  printQty: document.getElementById("print-qty"),
  printBtn: document.getElementById("print-btn"),
  printStatus: document.getElementById("print-status"),
  result: document.getElementById("result"),
  resultRfid: document.getElementById("result-rfid"),
  reset: document.getElementById("reset"),
  recentList: document.getElementById("recent-list"),
  search: document.getElementById("search"),
  flow: document.getElementById("tab-scan"),
  linkbox: document.getElementById("linkbox"),
  linkboxTitle: document.getElementById("linkbox-title"),
  linkboxText: document.getElementById("linkbox-text"),
  linkboxForm: document.getElementById("linkbox-form"),
  aliasTarget: document.getElementById("alias-target"),
  aliasCheck: document.getElementById("alias-check"),
  aliasPreview: document.getElementById("alias-preview"),
  aliasImg: document.getElementById("alias-img"),
  aliasPtitle: document.getElementById("alias-ptitle"),
  aliasPid: document.getElementById("alias-pid"),
  aliasPsku: document.getElementById("alias-psku"),
  aliasPbarcode: document.getElementById("alias-pbarcode"),
  aliasPbin: document.getElementById("alias-pbin"),
  aliasAccept: document.getElementById("alias-accept"),
  aliasOverwrite: document.getElementById("alias-overwrite"),
  aliasUnlink: document.getElementById("alias-unlink"),
  aliasCancel: document.getElementById("alias-cancel"),
  overwriteConfirm: document.getElementById("overwrite-confirm"),
  overwriteText: document.getElementById("overwrite-text"),
  overwriteAck: document.getElementById("overwrite-ack"),
  overwriteGo: document.getElementById("overwrite-go"),
  serialPanel: document.getElementById("serial-panel"),
  serialNote: document.getElementById("serial-note"),
  serialSheetName: document.getElementById("serial-sheet-name"),
  serialLabelInput: document.getElementById("serial-label-input"),
  serialLabelSave: document.getElementById("serial-label-save"),
  prefixNote: document.getElementById("prefix-note"),
  prefixReco: document.getElementById("prefix-reco"),
  prefixRecoText: document.getElementById("prefix-reco-text"),
  prefixRecoApply: document.getElementById("prefix-reco-apply"),
  autoPrint: document.getElementById("auto-print"),
  autoReset: document.getElementById("auto-reset"),
  requireBin: document.getElementById("require-bin"),
  prefixSection: document.getElementById("prefix-section"),
  prefixInput: document.getElementById("prefix-input"),
  prefixSave: document.getElementById("prefix-save"),
  skuSection: document.getElementById("sku-section"),
  newSkuInput: document.getElementById("newsku-input"),
  skuAck: document.getElementById("sku-ack"),
  skuSave: document.getElementById("sku-save"),
  binInput: document.getElementById("bin-input"),
  productEdit: document.getElementById("product-edit"),
  setbox: document.getElementById("setbox"),
  setScanInput: document.getElementById("set-scan-input"),
  setboxChoose: document.getElementById("setbox-choose"),
  setCandidates: document.getElementById("set-candidates"),
  setSkuInput: document.getElementById("set-sku-input"),
  setConfirm: document.getElementById("set-confirm"),
  setSingle: document.getElementById("set-single"),
  setCancel: document.getElementById("set-cancel"),
};

// --- Click-to-edit bin: chip -> empty text box -> Enter saves to Shopify ---
el.pBin.addEventListener("click", () => {
  if (!pendingProduct) return;
  el.pBin.hidden = true;
  el.binInput.value = "";
  el.binInput.hidden = false;
  el.binInput.focus();
});

function closeBinEditor() {
  el.binInput.hidden = true;
  el.pBin.hidden = false;
}

el.binInput.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    event.stopPropagation(); // don't let the global Esc reset the station
    closeBinEditor();
    return;
  }
  if (event.key !== "Enter") return;
  const bin = el.binInput.value.trim();
  if (!bin || !pendingProduct) return;
  el.binInput.disabled = true;
  try {
    const res = await apiFetch("/api/bin-updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: pendingProduct.sku || pendingProduct.barcode,
        bin,
        changed_by: operatorEl.value || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Bin update failed.", "err");
      return;
    }
    pendingProduct.bin_location = bin;
    el.pBin.textContent = bin;
    setResult(`Bin set to ${bin} (saved to Shopify).`, "ok");
    closeBinEditor();
    el.rfid.focus();
    // A held auto-print (missing bin) can proceed now.
    maybeAutoPrint();
  } catch (err) {
    setResult("Network error during the bin update.", "err");
  } finally {
    el.binInput.disabled = false;
  }
});

el.binInput.addEventListener("blur", () => {
  if (!el.binInput.disabled) closeBinEditor();
});

// Station settings (the ⚙ menu): all persisted per device.
function bindSetting(input, key) {
  input.checked = localStorage.getItem(key) === "1";
  input.addEventListener("change", () => {
    localStorage.setItem(key, input.checked ? "1" : "0");
  });
}
bindSetting(el.autoPrint, "autoPrint");
bindSetting(el.autoReset, "autoReset");
bindSetting(el.requireBin, "requireBinForAutoPrint");
// (Print-related items are hidden after printingEnabled is computed below.)

// Printing UI shows on printer stations, or everywhere when the server flag
// ALLOW_REMOTE_PRINT is on. Station status is sticky per device: visiting
// once with ?printer=1 marks it permanently (?printer=0 unmarks), so the
// bare URL keeps working afterwards.
{
  const p = new URLSearchParams(location.search).get("printer");
  if (p === "0") localStorage.removeItem("printerStation");
  else if (p !== null) localStorage.setItem("printerStation", "1");
}
const printingEnabled =
  document.body.dataset.remotePrint === "on" ||
  localStorage.getItem("printerStation") === "1";
document.getElementById("auto-print-item").hidden = !printingEnabled;
document.getElementById("require-bin-item").hidden = !printingEnabled;

// --- Access + identity ------------------------------------------------------
// Station key: captured once from a ?key=... link, remembered, then sent as
// a header on every API call. Inside Shopify admin, App Bridge injects its
// own Authorization header instead, so both paths work through apiFetch.
const urlParams = new URLSearchParams(location.search);
if (urlParams.get("key")) {
  localStorage.setItem("stationKey", urlParams.get("key"));
}
const stationKey = localStorage.getItem("stationKey");

function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (stationKey) headers["X-Station-Key"] = stationKey;
  return fetch(url, { ...opts, headers });
}

// Operator: who is physically using the station. Persisted per device and
// stamped onto every assignment and print job.
const operatorEl = document.getElementById("operator");
operatorEl.value = localStorage.getItem("operator") || "";
operatorEl.addEventListener("change", () => {
  localStorage.setItem("operator", operatorEl.value);
});

function requireOperator() {
  if (operatorEl.value) return operatorEl.value;
  setResult("Pick who's scanning (top right) first.", "err");
  operatorEl.focus();
  return null;
}

// --- Event chips -------------------------------------------------------------
// Every event/category tag renders as readable text in a coloured chip.
// Colours live in CSS variables (--ev-<type>) set from defaults merged
// with the operator's own picks (Settings → Event colours, stored in this
// browser) — editing one repaints every chip on the page instantly.
const EVENT_META = {
  "tag-assigned": ["Assigned Tag", "#29845a"],
  "tag-unlinked": ["Unlinked Tag", "#d72c0d"],
  "barcode-linked": ["Linked Barcode", "#6f42c1"],
  "barcode-replaced": ["Replaced Barcode", "#b98900"],
  "sku-updated": ["Updated SKU", "#b98900"],
  "bin-updated": ["Updated Bin", "#0e7a8a"],
  "rfid-flag-changed": ["RFID Flag", "#d72c0d"],
  "on-hand-updated": ["Raised On-hand", "#0c5132"],
  "on-hand-undone": ["Undid On-hand", "#6d7175"],
  "label-queued": ["Queued Label", "#4a86d8"],
  "label-printing": ["Printing Label", "#005bd3"],
  "label-printed": ["Printed Label", "#005bd3"],
  "label-failed": ["Label Failed", "#d72c0d"],
  "label-canceled": ["Canceled Label", "#6d7175"],
  "marked-bundle": ["Marked Bundle", "#6f42c1"],
  "marked-multi-box": ["Marked Multi-box", "#6f42c1"],
  "dropped-from-rfid": ["Dropped From RFID", "#d72c0d"],
  "batch-started": ["Started Batch", "#3f51b5"],
  "batch-verified": ["Verified Batch", "#3f51b5"],
  "batch-completed": ["Completed Batch", "#29845a"],
  "batch-abandoned": ["Abandoned Batch", "#6d7175"],
  "batch-counted": ["Batch Counted", "#3f51b5"],
  "side-trip-started": ["Started Side Trip", "#0e7a8a"],
  "side-trip-verified": ["Verified Side Trip", "#0e7a8a"],
  "side-trip-completed": ["Completed Side Trip", "#0e7a8a"],
  "side-trip-abandoned": ["Abandoned Side Trip", "#6d7175"],
  "bin-marked-tagged": ["Bin Marked Tagged", "#8a6116"],
  "receiving-started": ["Started Receiving", "#7a5c0e"],
  "receiving-completed": ["Completed Receiving", "#29845a"],
  "receiving-abandoned": ["Abandoned Receiving", "#6d7175"],
  "bin-check": ["Bin Check", "#7a5c0e"],
  "already-tagged-set": ["Already-tagged Count", "#6f42c1"],
  "review-opened": ["Opened Review", "#8a6116"],
  "review-resolved": ["Resolved Review", "#29845a"],
  "review-dismissed": ["Dismissed Review", "#6d7175"],
  "inventory-check": ["Inventory Check", "#8a6116"],
  "pairing-incomplete": ["Pairing Incomplete", "#d72c0d"],
  "unresolved-barcode": ["Unresolved Barcode", "#d72c0d"],
  "could-not-scan": ["Could Not Scan", "#8a6116"],
  sweep: ["Sweep", "#0e7a8a"],
};

function evLabel(type) {
  const m = EVENT_META[type];
  if (m) return m[0];
  // Unknown types still read as words, never as raw tags.
  return String(type || "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function evVarName(type) {
  return "--ev-" + String(type).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function eventColorOverrides() {
  try {
    return JSON.parse(localStorage.getItem("eventColors") || "{}");
  } catch {
    return {};
  }
}

function applyEventColors() {
  const overrides = eventColorOverrides();
  const root = document.documentElement.style;
  Object.keys(EVENT_META).forEach((type) => {
    root.setProperty(
      evVarName(type),
      overrides[type] || EVENT_META[type][1]
    );
  });
}
applyEventColors();

function evChip(type, extraTitle) {
  const known = !!EVENT_META[type];
  const color = known
    ? `var(${evVarName(type)})`
    : "var(--chip-ink)";
  const bg = known
    ? `color-mix(in srgb, var(${evVarName(type)}) 15%, transparent)`
    : "var(--chip-bg)";
  return (
    `<span class="evtype" style="color:${color};background:${bg}"` +
    (extraTitle ? ` title="${escapeHtml(extraTitle)}"` : "") +
    `>${escapeHtml(evLabel(type))}</span>`
  );
}

// Settings → Event colours: a picker + hex box + live preview per event.
function renderEvColorList() {
  const wrap = document.getElementById("evcolor-list");
  const overrides = eventColorOverrides();
  wrap.innerHTML = "";
  Object.keys(EVENT_META)
    .sort((a, b) => evLabel(a).localeCompare(evLabel(b)))
    .forEach((type) => {
      const current = overrides[type] || EVENT_META[type][1];
      const row = document.createElement("div");
      row.className = "evcolor-row";
      row.innerHTML = `
        <span class="evcolor-preview">${evChip(type)}</span>
        <input type="color" value="${current}" aria-label="colour for ${escapeHtml(evLabel(type))}" />
        <input type="text" class="linkbox__input evcolor-hex" value="${current}" maxlength="7" spellcheck="false" />`;
      const picker = row.querySelector('input[type="color"]');
      const hex = row.querySelector(".evcolor-hex");
      const save = (value) => {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
        const o = eventColorOverrides();
        if (value.toLowerCase() === EVENT_META[type][1].toLowerCase()) {
          delete o[type];
        } else {
          o[type] = value;
        }
        localStorage.setItem("eventColors", JSON.stringify(o));
        applyEventColors(); // every chip on the page follows instantly
      };
      picker.addEventListener("input", () => {
        hex.value = picker.value;
        save(picker.value);
      });
      hex.addEventListener("input", () => {
        const v = hex.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
          picker.value = v;
          save(v);
        }
      });
      wrap.append(row);
    });
}

document.getElementById("evcolor-open").addEventListener("click", () => {
  document.getElementById("settings-menu").open = false;
  renderEvColorList();
  document.getElementById("evcolor-overlay").hidden = false;
});
document.getElementById("evcolor-close").addEventListener("click", () => {
  document.getElementById("evcolor-overlay").hidden = true;
});
document.getElementById("evcolor-reset").addEventListener("click", () => {
  localStorage.removeItem("eventColors");
  applyEventColors();
  renderEvColorList();
});
document
  .getElementById("evcolor-overlay")
  .addEventListener("click", (e) => {
    if (e.target.id === "evcolor-overlay")
      document.getElementById("evcolor-overlay").hidden = true;
  });

// Server timestamps are UTC but arrive with no timezone suffix, which
// new Date() reads as LOCAL — every fresh event then sits "in the future"
// for a whole UTC offset (Toronto: 4 h of "just now"). Parse them as the
// UTC they are; strings that already carry a zone pass through untouched.
function tsDate(iso) {
  return new Date(
    /[Zz]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z"
  );
}

// "3 days ago" style timestamps for list surfaces (exact time in hover).
function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - tsDate(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// --- Tabs -------------------------------------------------------------------
// Same tabs on PC and iPad; each tab loads (or refreshes) its data on entry.
const tabSections = {
  scan: [document.getElementById("tab-scan"), document.getElementById("scan-footer")],
  batch: [document.getElementById("tab-batch")],
  inventory: [document.getElementById("tab-inventory")],
  queue: [document.getElementById("tab-queue")],
  review: [document.getElementById("tab-review")],
  audits: [document.getElementById("tab-audits")],
  history: [document.getElementById("tab-history")],
};
const tabLoaders = {
  batch: () => enterBatchTab(),
  inventory: () => loadInventory(),
  queue: () => loadQueue(),
  review: () => loadReview(),
  audits: () => loadAudits(),
  history: () => loadHistory(),
};
document.querySelectorAll(".tabs__tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs__tab").forEach((b) =>
      b.classList.toggle("tabs__tab--active", b === btn)
    );
    const name = btn.dataset.tab;
    Object.entries(tabSections).forEach(([key, els]) =>
      els.forEach((s) => (s.hidden = key !== name))
    );
    stopBatchPrintPoll();
    if (tabLoaders[name]) tabLoaders[name]();
    if (name === "scan") el.barcode.focus();
  });
});

// Current product awaiting an RFID tag. Null when we're on step 1.
let pendingProduct = null;

function setResult(message, kind, where = "barcode") {
  // Two status slots — barcode/printer news up top, tag-assignment news by
  // the RFID step — but never both at once.
  const target = where === "rfid" ? el.resultRfid : el.result;
  const other = where === "rfid" ? el.result : el.resultRfid;
  target.textContent = message;
  target.className = "result" + (kind ? ` result--${kind}` : "");
  other.textContent = "";
  other.className = "result";
}

function activate(step) {
  const onBarcode = step === "barcode";
  el.stepBarcode.classList.toggle("step--active", onBarcode);
  el.stepRfid.classList.toggle("step--active", !onBarcode);
  el.rfid.disabled = onBarcode;
  el.barcode.disabled = !onBarcode;
  (onBarcode ? el.barcode : el.rfid).focus();
}

function resetStation() {
  pendingProduct = null;
  el.barcode.value = "";
  el.rfid.value = "";
  el.productCard.hidden = true;
  el.tagsPanel.hidden = true;
  el.tagsPanel.open = false;
  el.printPanel.hidden = true;
  el.printStatus.textContent = "";
  el.serialPanel.hidden = true;
  serialLoadedLabel = null;
  closeLinkbox();
  closeSetbox();
  setResult("", null);
  bulkVisitReset();
  activate("barcode");
}

// --- Step 1: barcode -> Shopify lookup -------------------------------------
el.barcode.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const barcode = el.barcode.value.trim();
  if (!barcode) return;
  await stationBarcodeScan(barcode);
});

// Callable form of the barcode-input Enter handler, so C72 LINK relays can
// run the exact same path the wedge scanner does (guards, windows and all).
async function stationBarcodeScan(barcode) {
  setResult("Looking up product…", "busy");
  try {
    const res = await apiFetch(
      `/api/products/by-barcode/${encodeURIComponent(barcode)}`
    );
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      const info =
        body.detail && typeof body.detail === "object" ? body.detail : null;
      // A known case code answers the question outright — show what's in
      // the box instead of any "unknown barcode" window.
      const known = await apiFetch(
        `/api/cases/${encodeURIComponent(barcode)}`
      ).catch(() => null);
      if (known && known.ok) {
        showCaseScan(await known.json());
        setResult("That's a box of multiple products.", "ok");
        return;
      }
      // Unknown serial-shaped scans might be one filter of a multi-box
      // set — offer the set flow first (one click bails to the normal
      // unknown-barcode window). Known-prefix problems keep their window.
      if (!info && /^\d{5,12}$/.test(barcode)) {
        openSetbox(barcode);
      } else {
        openLinkbox(barcode, info);
      }
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Lookup failed.", "err");
      return;
    }
    const product = await res.json();
    if (product.alias_warning) {
      openConfirmBox(product);
      return;
    }
    acceptProduct(
      product,
      product.serial_brand
        ? `${product.serial_brand} serial number recognized — the first ` +
          `digits identify the product. Scan the RFID tag.`
        : "Product found. Scan the RFID tag."
    );
  } catch (err) {
    setResult("Network error during lookup.", "err");
  }
}

function acceptProduct(product, message) {
  pendingProduct = product;
  autoPrintedThisScan = false;
  closeLinkbox();
  showProduct(product);
  showSerialPanel(product);
  setResult(message, "ok");
  activate("rfid");
  // Bulk defaults to OFF for every product; auto-print below still counts
  // into the fresh printed-this-visit ledger.
  bulkVisitReset();
  maybeAutoPrint();
}

// One label per unit scanned: when auto-print is on and the scanned serial's
// name has been operator-confirmed, the label prints with no button press.
let autoPrintedThisScan = false;

function maybeAutoPrint() {
  if (!pendingProduct || !pendingProduct.serial_prefix) return;
  if (!el.autoPrint.checked) return;
  // From here on the operator expects a print — never refuse silently.
  if (!printingEnabled) {
    setResult(
      "Auto-print skipped: this isn't the printer-station page " +
        "(the address needs ?printer=1).",
      "err"
    );
    return;
  }
  if (!pendingProduct.serial_label_saved) {
    setResult(
      "Auto-print skipped: the label name isn't confirmed yet — check the " +
        "name below and press Enter to confirm it.",
      "err"
    );
    // Put the operator right where the fix happens.
    el.serialLabelInput.focus();
    el.serialLabelInput.select();
    return;
  }
  const bin = pendingProduct.bin_location;
  if (el.requireBin.checked && (!bin || bin === "No bin assigned")) {
    setResult(
      "Auto-print held: no bin assigned — click the bin chip to set one " +
        "and the label will print.",
      "err"
    );
    return;
  }
  if (autoPrintedThisScan) return;
  queueLabels(1);
}

// --- Serialized-brand label names (Astronomik) ------------------------------
// The panel opens whenever a serial-recognized product loads: shows the
// manufacturer's sheet name and an editable preferred name that prints at
// the top of the label. Saved per serial prefix; survives sheet reloads.
let serialLoadedLabel = null;

function showSerialPanel(p) {
  if (!p || !p.serial_prefix) {
    el.serialPanel.hidden = true;
    serialLoadedLabel = null;
    return;
  }
  if (p.serial_note) {
    el.serialNote.textContent = `⚠ ${p.serial_note}`;
    el.serialNote.hidden = false;
  } else {
    el.serialNote.hidden = true;
  }
  el.serialSheetName.textContent =
    `${p.serial_brand} sheet name: ${p.serial_item_name || "—"}`;
  el.serialLabelInput.value = p.serial_label || "";
  serialLoadedLabel = el.serialLabelInput.value.trim();
  el.serialLabelSave.textContent = "Save name";
  el.serialPanel.hidden = false;
}

async function saveSerialLabel(showFeedback) {
  const name = el.serialLabelInput.value.trim();
  if (!pendingProduct || !pendingProduct.serial_prefix || !name) return;
  // Skip only when this exact name is already confirmed server-side.
  // An unchanged-but-never-saved default still needs saving — printing or
  // hitting Save IS the confirmation that makes auto-print trust it.
  if (name === serialLoadedLabel && pendingProduct.serial_label_saved) {
    if (showFeedback) {
      el.serialLabelSave.textContent = "Saved ✓";
      setTimeout(() => (el.serialLabelSave.textContent = "Save name"), 1500);
    }
    return;
  }
  try {
    const res = await apiFetch(
      `/api/serial-prefixes/${encodeURIComponent(pendingProduct.serial_prefix)}/label`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label_name: name }),
      }
    );
    if (res.ok) {
      serialLoadedLabel = name;
      if (pendingProduct) pendingProduct.serial_label_saved = true;
      if (showFeedback) {
        el.serialLabelSave.textContent = "Saved ✓";
        setTimeout(() => (el.serialLabelSave.textContent = "Save name"), 1500);
        // Freshly confirmed name + auto-print mode = print this unit now.
        maybeAutoPrint();
      }
    } else if (showFeedback) {
      setResult("Could not save the label name.", "err");
    }
  } catch (err) {
    if (showFeedback) setResult("Network error saving the label name.", "err");
  }
}

el.serialLabelSave.addEventListener("click", () => {
  saveSerialLabel(true);
  el.rfid.focus();
});
el.serialLabelInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveSerialLabel(true);
    // Same idea as after printing: next action is scanning the tag.
    el.rfid.focus();
  }
});

// --- Case codes -------------------------------------------------------------
// A barcode that isn't a listing at all but the manufacturer's case code:
// "8 x 93581". Scanning one used to come back empty, which is how a box ends
// up in someone's hands with nowhere to put it. The record lives against the
// BARCODE, so the note follows the scan onto every surface instead of each
// tab inventing its own message.
let caseCode = null;      // the code being viewed/defined
let caseProduct = null;   // the product chosen as contents

function closeCasebox() {
  document.getElementById("casebox").hidden = true;
  caseCode = null;
  caseProduct = null;
}

function showCaseScan(data) {
  closeLinkbox();
  closeSetbox();
  caseCode = data.barcode;
  const box = document.getElementById("casebox");
  box.hidden = false;
  document.getElementById("casebox-view").hidden = false;
  document.getElementById("casebox-form").hidden = true;
  document.getElementById("casebox-msg").textContent = "";
  document.getElementById("casebox-title").textContent =
    "Box of multiple products";
  document.getElementById("casebox-intro").textContent =
    `${data.barcode} isn't a product of its own — it's a box holding ` +
    `${data.units} of one.`;
  // "8 x" in front of the normal preview, per the product it contains.
  document.getElementById("casebox-mult").textContent = `${data.units} ×`;
  const p = data.product || {};
  const img = document.getElementById("casebox-img");
  if (p.image_url) {
    img.src = p.image_url;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  document.getElementById("casebox-ptitle").textContent =
    data.product_title || data.sku;
  document.getElementById("casebox-pmeta").textContent =
    `SKU: ${data.sku}` +
    (p.bin_location ? ` · Bin: ${p.bin_location}` : "") +
    (p.barcode ? ` · Item barcode: ${p.barcode}` : "");
  const note = document.getElementById("casebox-note");
  note.hidden = !data.scan_note;
  note.textContent = data.scan_note ? `⚠ ${data.scan_note}` : "";
  batchSound("other");
}

function openCaseForm(code, existing) {
  closeLinkbox();
  closeSetbox();
  caseCode = code;
  caseProduct = null;
  const box = document.getElementById("casebox");
  box.hidden = false;
  document.getElementById("casebox-view").hidden = true;
  document.getElementById("casebox-form").hidden = false;
  document.getElementById("casebox-msg").textContent = "";
  document.getElementById("casebox-found").textContent = "";
  document.getElementById("casebox-title").textContent =
    existing ? "Edit this box" : "Box of multiple products";
  document.getElementById("casebox-intro").textContent =
    `${code} — record what's inside so every scan of it says so.`;
  document.getElementById("casebox-sku").value = existing ? existing.sku : "";
  document.getElementById("casebox-units").value = existing
    ? existing.units
    : 8;
  document.getElementById("casebox-notein").value =
    existing && existing.scan_note ? existing.scan_note : "";
  document.getElementById("casebox-sku").focus();
}

async function caseFindProduct() {
  const term = document.getElementById("casebox-sku").value.trim();
  const found = document.getElementById("casebox-found");
  if (!term) return;
  found.textContent = "Looking up…";
  try {
    const p = await apiJson(
      `/api/products/by-barcode/${encodeURIComponent(term)}`
    );
    caseProduct = p;
    found.textContent =
      `✓ ${p.product_title} · SKU ${p.sku}` +
      (p.bin_location ? ` · Bin ${p.bin_location}` : "");
  } catch (err) {
    caseProduct = null;
    found.textContent = `No product found for "${term}".`;
  }
}

document.getElementById("casebox-find").addEventListener("click", caseFindProduct);
document.getElementById("casebox-sku").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    caseFindProduct();
  }
});

document.getElementById("casebox-save").addEventListener("click", async () => {
  const msg = document.getElementById("casebox-msg");
  const sku = (caseProduct && caseProduct.sku)
    || document.getElementById("casebox-sku").value.trim();
  if (!sku) {
    msg.textContent = "Say which product is inside first.";
    return;
  }
  try {
    const res = await postJson("/api/cases", {
      barcode: caseCode,
      sku,
      units: Number(document.getElementById("casebox-units").value) || 0,
      scan_note:
        document.getElementById("casebox-notein").value.trim() || null,
      created_by: operatorEl.value.trim() || null,
    });
    msg.textContent = res.message;
    const fresh = await apiJson(`/api/cases/${encodeURIComponent(caseCode)}`);
    showCaseScan(fresh);
    document.getElementById("casebox-msg").textContent = res.message;
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("casebox-edit").addEventListener("click", async () => {
  try {
    const c = await apiJson(`/api/cases/${encodeURIComponent(caseCode)}`);
    openCaseForm(caseCode, c);
  } catch (err) {
    document.getElementById("casebox-msg").textContent = err.message;
  }
});

document.getElementById("casebox-forget").addEventListener("click", async () => {
  if (
    !confirm(
      `Stop treating ${caseCode} as a box of multiple products?\n\n` +
        `Scanning it will go back to coming up empty.`
    )
  )
    return;
  try {
    await apiJson(`/api/cases/${encodeURIComponent(caseCode)}`, {
      method: "DELETE",
    });
    closeCasebox();
    resetFlow();
    setResult("That barcode is no longer a box.", "ok");
  } catch (err) {
    document.getElementById("casebox-msg").textContent = err.message;
  }
});

// Both unknown-barcode windows can hand off to the case form — that is how
// a new case code gets recorded in the first place.
document.getElementById("set-case").addEventListener("click", () => {
  openCaseForm(setSerials[0], null);
});
document.getElementById("alias-case").addEventListener("click", () => {
  openCaseForm(aliasCandidate || el.barcode.value.trim(), null);
});

document.getElementById("casebox-cancel").addEventListener("click", () => {
  closeCasebox();
  resetFlow();
});
document.getElementById("casebox-done").addEventListener("click", () => {
  closeCasebox();
  resetFlow();
});

// --- Foreign-barcode linking ------------------------------------------------
// State for the linkbox: the unknown code just scanned, and the product the
// operator is previewing (link mode) or confirming (alias-scan mode).
let aliasCandidate = null;
let aliasPreviewProduct = null;
let linkboxInfo = null; // structured 404 detail (e.g. known-prefix, bad SKU)

function hideLinkboxExtras() {
  el.prefixSection.hidden = true;
  el.skuSection.hidden = true;
  el.skuAck.checked = false;
  el.skuSave.disabled = true;
  el.prefixNote.value = "";
  el.prefixReco.hidden = true;
}

// Recommended SKU: whenever a 4-digit prefix is entered, consult the loaded
// manufacturer sheet and surface its SKU when it differs from the product's.
let prefixRecoTimer;
el.prefixInput.addEventListener("input", () => {
  clearTimeout(prefixRecoTimer);
  el.prefixReco.hidden = true;
  const p = el.prefixInput.value.trim();
  if (!/^\d{4}$/.test(p)) return;
  prefixRecoTimer = setTimeout(async () => {
    try {
      const res = await apiFetch(
        `/api/serial-prefixes/${encodeURIComponent(p)}`
      );
      if (!res.ok) return;
      const row = await res.json();
      const currentSku = aliasPreviewProduct && aliasPreviewProduct.sku;
      if (row.sku && row.sku !== currentSku) {
        el.prefixRecoText.textContent =
          `Astronomik sheet: prefix ${p} → SKU ${row.sku}` +
          (row.item_name ? ` · ${row.item_name}` : "");
        el.prefixReco.hidden = false;
      }
    } catch (err) {
      /* recommendation is best-effort */
    }
  }, 250);
});

el.prefixRecoApply.addEventListener("click", () => {
  const text = el.prefixRecoText.textContent;
  const match = text.match(/SKU (\S+)/);
  if (!match) return;
  el.newSkuInput.value = match[1];
  el.skuSection.hidden = false;
  el.newSkuInput.focus();
});

// Re-run the original scan after a fix (new prefix, updated SKU) so the
// normal flow — serial recognition, name panel, auto-print — takes over.
function retryLookup(code) {
  closeLinkbox();
  el.barcode.disabled = false;
  el.barcode.value = code;
  el.barcode.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
}

function renderAliasPreview(p) {
  aliasPreviewProduct = p;
  el.aliasPtitle.textContent =
    (p.product_title || "—") + (p.variant_title ? ` (${p.variant_title})` : "");
  el.aliasPid.textContent = p.shopify_variant_id || "—";
  el.aliasPsku.textContent = p.sku || "—";
  el.aliasPbarcode.textContent = p.barcode || "—";
  el.aliasPbin.textContent = p.bin_location || "—";
  if (p.image_url) {
    el.aliasImg.src = p.image_url;
    el.aliasImg.hidden = false;
  } else {
    el.aliasImg.hidden = true;
    el.aliasImg.removeAttribute("src");
  }
  el.aliasPreview.hidden = false;
}

function openLinkbox(scannedCode, info = null) {
  el.flow.classList.add("flow--side");
  aliasCandidate = scannedCode;
  aliasPreviewProduct = null;
  linkboxInfo = info;
  hideLinkboxExtras();
  el.linkboxTitle.textContent = info
    ? "Serial recognized — store SKU outdated"
    : "Unknown barcode";
  el.linkboxText.textContent = info
    ? `${info.message} Look up the product below (by its current barcode ` +
      `or SKU), then update its SKU.`
    : `"${scannedCode}" isn't in the system. If this is a manufacturer ` +
      `barcode on a known product, enter our barcode or SKU to link them.`;
  el.linkboxForm.hidden = false;
  el.aliasTarget.value = "";
  el.aliasPreview.hidden = true;
  el.aliasAccept.hidden = true;
  el.aliasAccept.textContent = "Link barcode & continue";
  el.aliasOverwrite.hidden = true;
  el.aliasUnlink.hidden = true;
  hideOverwrite();
  el.linkbox.hidden = false;
  setResult("No product found for that barcode or SKU.", "err");
  el.aliasTarget.focus();
}

function openConfirmBox(product) {
  el.flow.classList.add("flow--side");
  aliasCandidate = product.alias_barcode;
  el.linkboxTitle.textContent = "Linked barcode — confirm the item";
  el.linkboxText.textContent =
    `"${product.alias_barcode}" doesn't match internal barcodes; it was ` +
    `previously linked to this product. Confirm this is the right item.`;
  el.linkboxForm.hidden = true;
  renderAliasPreview(product);
  el.aliasAccept.hidden = false;
  el.aliasAccept.textContent = "Confirm item";
  el.aliasOverwrite.hidden = true;
  el.aliasUnlink.hidden = false;
  hideOverwrite();
  hideLinkboxExtras();
  el.linkbox.hidden = false;
  setResult("", null);
}

function closeLinkbox() {
  el.linkbox.hidden = true;
  el.flow.classList.remove("flow--side");
  hideOverwrite();
  hideLinkboxExtras();
  aliasCandidate = null;
  aliasPreviewProduct = null;
  linkboxEditMode = false;
}

// --- Multi-box filter sets --------------------------------------------------
// Three component serials (R/G/B slots) -> one set product. Confirming
// registers all three prefixes with a ONE-TAG-PER-SET scan note, then
// re-runs the original scan so the normal serial flow takes over.
let setSerials = [];
let setSelectedSku = null;

function setSlotEls() {
  return [0, 1, 2].map((i) => document.getElementById(`set-slot-${i}`));
}

function renderSetSlots() {
  setSlotEls().forEach((slot, i) => {
    const val = setSerials[i];
    slot.querySelector("span").textContent = val || "—";
    slot.classList.toggle("setslot--filled", !!val);
    slot.classList.toggle("setslot--active", i === setSerials.length);
  });
  const full = setSerials.length >= 3;
  el.setScanInput.disabled = full;
  el.setboxChoose.hidden = !full;
  if (full) loadSetCandidates();
}

function openSetbox(seedSerial) {
  closeLinkbox();
  el.flow.classList.add("flow--side");
  setSerials = [seedSerial];
  setSelectedSku = null;
  el.setSkuInput.value = "";
  el.setCandidates.innerHTML = "";
  el.setbox.hidden = false;
  renderSetSlots();
  setResult(
    "Serial not recognized — set flow opened. Scan the remaining filters, " +
      "or mark it a single product.",
    null
  );
  el.setScanInput.value = "";
  el.setScanInput.focus();
}

function closeSetbox() {
  el.setbox.hidden = true;
  el.flow.classList.remove("flow--side");
  setSerials = [];
  setSelectedSku = null;
}

el.setScanInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const code = el.setScanInput.value.trim();
  el.setScanInput.value = "";
  if (!code) return;
  if (!/^\d{5,12}$/.test(code)) {
    setResult("That doesn't look like a filter serial number.", "err");
    return;
  }
  if (setSerials.some((s) => s.slice(0, 4) === code.slice(0, 4))) {
    setResult(
      "That filter's prefix is already in a slot — scan a different one.",
      "err"
    );
    return;
  }
  setSerials.push(code);
  setResult("", null);
  renderSetSlots();
  if (setSerials.length < 3) el.setScanInput.focus();
});

async function loadSetCandidates() {
  if (el.setCandidates.childElementCount) return; // already loaded
  try {
    const res = await apiFetch("/api/filter-sets");
    if (!res.ok) return;
    const { sets } = await res.json();
    el.setCandidates.innerHTML = "";
    sets.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `${escapeHtml(s.title)} — ${escapeHtml(s.variant || "")}
        <span class="mono">(SKU ${escapeHtml(s.sku || "?")})</span>`;
      li.addEventListener("click", () => {
        setSelectedSku = s.sku;
        el.setSkuInput.value = s.sku || "";
        el.setCandidates
          .querySelectorAll("li")
          .forEach((x) => x.classList.toggle("selected", x === li));
      });
      el.setCandidates.append(li);
    });
  } catch (err) {
    /* candidate list is best-effort; the SKU box still works */
  }
}

el.setConfirm.addEventListener("click", async () => {
  const target = el.setSkuInput.value.trim();
  if (setSerials.length < 3 || !target) {
    setResult("Scan all three filters and pick or type the set SKU.", "err");
    return;
  }
  const operator = requireOperator();
  if (!operator) return;
  el.setConfirm.disabled = true;
  try {
    const res = await apiFetch("/api/filter-sets/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serials: setSerials,
        target,
        created_by: operator,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(
        typeof body.detail === "string" ? body.detail : "Set registration failed.",
        "err"
      );
      return;
    }
    const seed = setSerials[0];
    closeSetbox();
    setResult("Filter set registered — rescanning…", "ok");
    retryLookup(seed);
  } catch (err) {
    setResult("Network error during set registration.", "err");
  } finally {
    el.setConfirm.disabled = false;
  }
});

el.setSingle.addEventListener("click", () => {
  const seed = setSerials[0];
  closeSetbox();
  openLinkbox(seed);
});

el.setCancel.addEventListener("click", () => {
  closeSetbox();
  el.barcode.value = "";
  setResult("", null);
  activate("barcode");
});

// Edit mode: the same window, opened from a loaded product's Edit button —
// no unknown scan involved. Offers the serial-prefix and SKU tools wired
// to the current product.
let linkboxEditMode = false;

function openEditbox() {
  if (!pendingProduct) return;
  linkboxEditMode = true;
  aliasCandidate = null;
  linkboxInfo = null;
  el.flow.classList.add("flow--side");
  el.linkboxTitle.textContent = "Edit product";
  el.linkboxText.textContent =
    "Register the Astronomik serial prefix (the first 4 digits of the " +
    "unit's serial number) and/or update the SKU in Shopify.";
  el.linkboxForm.hidden = true;
  // The hidden target field feeds the save handlers.
  el.aliasTarget.value = pendingProduct.barcode || pendingProduct.sku || "";
  renderAliasPreview(pendingProduct);
  el.aliasAccept.hidden = true;
  el.aliasOverwrite.hidden = true;
  el.aliasUnlink.hidden = true;
  hideOverwrite();
  el.prefixInput.value = pendingProduct.serial_prefix || "";
  el.prefixNote.value = pendingProduct.serial_note || "";
  el.prefixSection.hidden = false;
  el.newSkuInput.value = pendingProduct.sku || "";
  el.skuSection.hidden = false;
  el.skuAck.checked = false;
  el.skuSave.disabled = true;
  el.linkbox.hidden = false;
  el.prefixInput.focus();
}

el.productEdit.addEventListener("click", openEditbox);

function hideOverwrite() {
  el.overwriteConfirm.hidden = true;
  el.overwriteAck.checked = false;
  el.overwriteGo.disabled = true;
}

async function checkAliasTarget() {
  const term = el.aliasTarget.value.trim();
  if (!term) return;
  el.aliasCheck.disabled = true;
  try {
    const res = await apiFetch(
      `/api/products/by-barcode/${encodeURIComponent(term)}`
    );
    if (res.status === 404) {
      el.aliasPreview.hidden = true;
      el.aliasAccept.hidden = true;
      setResult("No product found for that barcode or SKU either.", "err");
      el.aliasTarget.select();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Lookup failed.", "err");
      return;
    }
    renderAliasPreview(await res.json());
    el.aliasAccept.hidden = false;
    el.aliasOverwrite.hidden = false;
    hideOverwrite();
    // Extra tools once a product is in view: register an Astronomik serial
    // prefix (when the scan looks like a serial), and update an outdated SKU.
    if (/^\d{5,12}$/.test(aliasCandidate || "")) {
      el.prefixInput.value = aliasCandidate.slice(0, 4);
      el.prefixSection.hidden = false;
    }
    el.newSkuInput.value = (linkboxInfo && linkboxInfo.suggested_sku) || "";
    el.skuSection.hidden = false;
    setResult("Check the product, then link.", null);
  } catch (err) {
    setResult("Network error during lookup.", "err");
  } finally {
    el.aliasCheck.disabled = false;
  }
}

el.aliasCheck.addEventListener("click", checkAliasTarget);
el.aliasTarget.addEventListener("keydown", (event) => {
  if (event.key === "Enter") checkAliasTarget();
});
// Any edit to the target invalidates the previewed product — otherwise a
// stale preview from the previous lookup could get linked to the wrong
// scan. Check product again to re-enable the actions.
el.aliasTarget.addEventListener("input", () => {
  aliasPreviewProduct = null;
  el.aliasPreview.hidden = true;
  el.aliasAccept.hidden = true;
  el.aliasOverwrite.hidden = true;
  hideOverwrite();
  hideLinkboxExtras();
});

el.aliasAccept.addEventListener("click", async () => {
  if (!aliasPreviewProduct) return;
  // Confirm mode: the alias already exists, just proceed.
  if (el.linkboxForm.hidden) {
    acceptProduct(aliasPreviewProduct, "Item confirmed. Scan the RFID tag.");
    return;
  }
  // Link mode: create the alias, then proceed with the previewed product.
  const operator = requireOperator();
  if (!operator) return;
  el.aliasAccept.disabled = true;
  try {
    const res = await apiFetch("/api/barcode-aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias_barcode: aliasCandidate,
        target: el.aliasTarget.value.trim(),
        created_by: operator,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Linking failed.", "err");
      return;
    }
    const product = { ...aliasPreviewProduct, alias_barcode: aliasCandidate };
    acceptProduct(product, "Barcode linked. Scan the RFID tag.");
  } catch (err) {
    setResult("Network error while linking.", "err");
  } finally {
    el.aliasAccept.disabled = false;
  }
});

el.aliasUnlink.addEventListener("click", async () => {
  if (!aliasCandidate) return;
  if (!confirm(`Unlink barcode ${aliasCandidate} from this product?`)) return;
  const res = await apiFetch(
    `/api/barcode-aliases/${encodeURIComponent(aliasCandidate)}`,
    { method: "DELETE" }
  );
  if (res.ok || res.status === 404) {
    closeLinkbox();
    el.barcode.value = "";
    setResult("Barcode unlinked.", "ok");
    activate("barcode");
  } else {
    setResult("Could not unlink that barcode.", "err");
  }
});

el.aliasCancel.addEventListener("click", () => {
  closeLinkbox();
  el.barcode.select();
  setResult("", null);
});

// Register a new Astronomik serial prefix for the previewed product.
el.prefixSave.addEventListener("click", async () => {
  if (!aliasPreviewProduct) return;
  const operator = requireOperator();
  if (!operator) return;
  const prefix = el.prefixInput.value.trim();
  if (!/^\d{4}$/.test(prefix)) {
    setResult("The prefix must be exactly 4 digits.", "err");
    return;
  }
  el.prefixSave.disabled = true;
  try {
    const res = await apiFetch("/api/serial-prefixes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix,
        target: el.aliasTarget.value.trim(),
        scan_note: el.prefixNote.value.trim() || null,
        created_by: operator,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Saving the prefix failed.", "err");
      return;
    }
    if (aliasCandidate) {
      setResult(`Prefix ${prefix} saved — rescanning…`, "ok");
      retryLookup(aliasCandidate);
    } else {
      // Edit mode: stay on the loaded product.
      setResult(`Serial prefix ${prefix} now points at this product.`, "ok");
      closeLinkbox();
      el.rfid.focus();
    }
  } catch (err) {
    setResult("Network error while saving the prefix.", "err");
  } finally {
    el.prefixSave.disabled = false;
  }
});

// Replace the previewed product's SKU in Shopify.
el.skuAck.addEventListener("change", () => {
  el.skuSave.disabled = !el.skuAck.checked;
});

el.skuSave.addEventListener("click", async () => {
  if (!aliasPreviewProduct || !el.skuAck.checked) return;
  const operator = requireOperator();
  if (!operator) return;
  const newSku = el.newSkuInput.value.trim();
  if (!newSku) {
    setResult("Enter the new SKU first.", "err");
    return;
  }
  el.skuSave.disabled = true;
  try {
    const res = await apiFetch("/api/sku-overwrites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        new_sku: newSku,
        target: el.aliasTarget.value.trim(),
        changed_by: operator,
        confirmed: true,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "SKU update failed.", "err");
      el.skuSave.disabled = false;
      return;
    }
    if (aliasCandidate) {
      setResult(`SKU updated to ${newSku} — rescanning…`, "ok");
      retryLookup(aliasCandidate);
    } else {
      // Edit mode: update the card in place.
      if (pendingProduct) {
        pendingProduct.sku = newSku;
        el.pSku.textContent = newSku;
      }
      setResult(`SKU updated to ${newSku} in Shopify.`, "ok");
      closeLinkbox();
      el.rfid.focus();
    }
  } catch (err) {
    setResult("Network error during the SKU update.", "err");
    el.skuSave.disabled = false;
  }
});

// --- Barcode replacement (adopt the scanned code as the real barcode) ------
el.aliasOverwrite.addEventListener("click", () => {
  if (!aliasPreviewProduct) return;
  el.overwriteText.textContent =
    `Replace the barcode on "${aliasPreviewProduct.product_title}"` +
    (aliasPreviewProduct.variant_title
      ? ` (${aliasPreviewProduct.variant_title})`
      : "") +
    `: "${aliasPreviewProduct.barcode || "(none)"}" → "${aliasCandidate}". ` +
    `This changes the product in Shopify itself.`;
  el.overwriteConfirm.hidden = false;
  el.overwriteAck.checked = false;
  el.overwriteGo.disabled = true;
});

el.overwriteAck.addEventListener("change", () => {
  el.overwriteGo.disabled = !el.overwriteAck.checked;
});

el.overwriteGo.addEventListener("click", async () => {
  if (!aliasPreviewProduct || !el.overwriteAck.checked) return;
  const operator = requireOperator();
  if (!operator) return;
  el.overwriteGo.disabled = true;
  try {
    const res = await apiFetch("/api/barcode-overwrites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        new_barcode: aliasCandidate,
        target: el.aliasTarget.value.trim(),
        changed_by: operator,
        confirmed: true,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Barcode replacement failed.", "err");
      el.overwriteGo.disabled = false;
      return;
    }
    const { product } = await res.json();
    acceptProduct(product, "Barcode replaced in Shopify. Scan the RFID tag.");
  } catch (err) {
    setResult("Network error during barcode replacement.", "err");
    el.overwriteGo.disabled = false;
  }
});

function showProduct(p) {
  el.pTitle.textContent = p.product_title || "—";
  el.pVariant.textContent = p.variant_title || "—";
  el.pSku.textContent = p.sku || "—";
  el.pBarcode.textContent = p.barcode || "—";
  closeBinEditor();
  el.pBin.textContent = p.bin_location || "—";
  el.pSource.textContent =
    (p.source === "binmap"
      ? "Live catalog"
      : p.source === "shopify"
        ? "Shopify"
        : "—") +
    (p.serial_brand ? ` · ${p.serial_brand} serial` : "");
  el.productCard.hidden = false;
  el.printPanel.hidden = !printingEnabled;
  loadTags(p);
  loadPlannerHint(p);
}

// --- TC-Planner on-order hint ----------------------------------------------
// "This product is on an open purchase order — N more expected." Pure
// decoration from the read-only planner bridge: it loads after the card,
// never blocks a scan, and stays hidden when the bridge is off, the
// planner is down, or nothing is on order. Shared by the Scan Station
// product card and the receiving-batch collect result.
const plannerHintSeqs = {};
async function showPlannerHint(sku, elId) {
  const hint = document.getElementById(elId);
  hint.hidden = true;
  if (!sku) return;
  const seq = (plannerHintSeqs[elId] = (plannerHintSeqs[elId] || 0) + 1);
  try {
    // The operator pick rides along so the planner attributes the call
    // to the person scanning (their own planner token, when one exists).
    const op = operatorEl.value
      ? `?operator=${encodeURIComponent(operatorEl.value)}`
      : "";
    const data = await apiJson(
      `/api/planner/on-order/${encodeURIComponent(sku)}${op}`
    );
    // A newer scan owns this surface now — drop the stale answer.
    if (seq !== plannerHintSeqs[elId]) return;
    if (!data.configured || !data.ok || !data.total_remaining) return;
    const pos = data.orders
      .map(
        (o) =>
          `PO#${o.reference_number} ${o.vendor} (${o.remaining} left` +
          (o.expected_date ? `, ETA ${o.expected_date}` : "") +
          `)`
      )
      .join(" · ");
    hint.textContent =
      `📦 On order: ${data.total_remaining} more expected — ${pos}`;
    hint.hidden = false;
  } catch (err) {
    /* hint only — a failure just means no hint */
  }
}

function loadPlannerHint(p) {
  showPlannerHint(p && p.sku, "planner-hint");
}

// --- Tags on file for the scanned product ----------------------------------
async function loadTags(p) {
  el.pTagCount.textContent = "…";
  el.tagsList.innerHTML = "";
  el.tagsPanel.hidden = true;
  const params = new URLSearchParams();
  if (p.sku) params.set("sku", p.sku);
  if (p.barcode) params.set("barcode", p.barcode);
  if (![...params].length) {
    el.pTagCount.textContent = "—";
    return;
  }
  try {
    const res = await apiFetch(`/api/products/tags?${params}`);
    if (!res.ok) {
      el.pTagCount.textContent = "—";
      return;
    }
    const data = await res.json();
    el.pTagCount.textContent = String(data.count);
    if (data.count) {
      data.assignments.forEach((a) => {
        const li = document.createElement("li");
        li.innerHTML = `
          <span class="recent__epc">${escapeHtml(a.rfid_id)}</span>${
            a.suspect
              ? '<span class="suspect" title="Probably a bad read — ' +
                're-scan this tag.">⚠</span>'
              : ""
          }
          <span class="recent__meta">${escapeHtml(
            (a.assigned_at || "").slice(0, 10)
          )} · ${escapeHtml(a.assigned_by || "")}</span>`;
        el.tagsList.append(li);
      });
      el.tagsPanel.hidden = false;
    }
  } catch (err) {
    el.pTagCount.textContent = "—";
  }
}

// --- Print & encode labels -------------------------------------------------
async function queueLabels(quantity) {
  if (!pendingProduct) return;
  const operator = requireOperator();
  if (!operator) return;
  autoPrintedThisScan = true; // any print covers the unit in hand
  el.printBtn.disabled = true;
  el.printStatus.textContent = "Queueing…";
  try {
    // Serialized-brand products print the operator's preferred name; save
    // any unsaved edit so the next scan remembers it too.
    let labelName = null;
    if (pendingProduct.serial_prefix) {
      labelName = el.serialLabelInput.value.trim() || null;
      saveSerialLabel(false);
    }
    const res = await apiFetch("/api/print-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity,
        ...pendingProduct,
        label_name: labelName,
        requested_by: operator,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      el.printStatus.textContent = body.detail || "Queueing failed.";
      return;
    }
    const data = await res.json();
    bulkPrinted += (data.jobs || []).length;
    renderBulk();
    watchPrintJobs(data.jobs.map((j) => j.id));
  } catch (err) {
    el.printStatus.textContent = "Network error while queueing.";
  } finally {
    el.printBtn.disabled = false;
    // Hands back on the scanner: the label is printing, the next action is
    // scanning the tag — no mouse required.
    el.rfid.focus();
  }
}

el.printBtn.addEventListener("click", () =>
  queueLabels(Math.max(1, Math.min(100, Number(el.printQty.value) || 1)))
);

// Poll the queued jobs until they all finish (or we give up watching —
// the agent keeps printing regardless).
async function watchPrintJobs(ids) {
  const started = Date.now();
  const idsParam = ids.join(",");
  while (Date.now() - started < 120000) {
    try {
      const res = await apiFetch(`/api/print-jobs?ids=${idsParam}`);
      if (res.ok) {
        const { jobs } = await res.json();
        const done = jobs.filter((j) => j.status === "done").length;
        const failed = jobs.filter((j) => j.status === "error");
        const waiting = jobs.length - done - failed.length;
        el.printStatus.textContent = failed.length
          ? `${done}/${jobs.length} printed, ${failed.length} FAILED: ${
              failed[0].error || "printer error"
            }`
          : waiting
          ? `Printing… ${done}/${jobs.length}`
          : `Printed ${done}/${jobs.length} ✓`;
        // Mirror the final outcome to the top status line, where the
        // operator is actually looking.
        if (!waiting) {
          setResult(
            failed.length
              ? `Label FAILED: ${failed[0].error || "printer error"}`
              : `Label printed ✓ — scan the RFID tag.`,
            failed.length ? "err" : "ok"
          );
          if (pendingProduct) loadTags(pendingProduct);
          loadRecent();
          return;
        }
      }
    } catch (err) {
      /* transient — keep polling */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  el.printStatus.textContent += " (still queued — agent will print when up)";
}

// --- Step 2: rfid -> save assignment ---------------------------------------
el.rfid.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const rfid = el.rfid.value.trim();
  if (!rfid || !pendingProduct) return;
  await stationTagScan(rfid);
});

// Callable form of the RFID-input Enter handler — the C72 LINK relay path.
async function stationTagScan(rfid) {
  if (!pendingProduct) {
    setResult("No product loaded — scan a barcode first.", "err", "rfid");
    return;
  }
  const operator = requireOperator();
  if (!operator) return;

  setResult("Saving assignment…", "busy", "rfid");
  try {
    const payload = { rfid_id: rfid, ...pendingProduct, assigned_by: operator };
    // Serialized brands: store the operator's preferred name as the title
    // (it already names the size, so the variant column would just repeat it).
    if (pendingProduct.serial_prefix) {
      const name = el.serialLabelInput.value.trim();
      if (name) {
        payload.product_title = name;
        payload.variant_title = null;
      }
      saveSerialLabel(false);
    }
    const res = await apiFetch("/api/rfid-assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      setResult(`Tag ${rfid} is already assigned.`, "err", "rfid");
      el.rfid.select();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "RFID tag save failed.", "err", "rfid");
      return;
    }
    const saved = await res.json();
    if (saved.suspect) {
      setResult(
        `Saved, but tag ${saved.rfid_id} is ${saved.rfid_id.length} ` +
          `characters (tags are normally 24) — likely a bad read. ` +
          `Re-scan this tag into inventory to be safe.`,
        "err",
        "rfid"
      );
    } else {
      setResult(
        `Assigned ${saved.rfid_id} → ${saved.product_title}`,
        "ok",
        "rfid"
      );
    }
    prependRecent(saved);
    bulkTagged += 1;
    lastSweep = [saved.rfid_id];
    if (saved.suspect || !el.autoReset.checked) {
      // Keep the product loaded (stay-on-product mode, or so a flagged
      // tag can be re-scanned immediately).
      el.rfid.value = "";
      el.rfid.focus();
      loadTags(pendingProduct);
    } else if (bulkOn) {
      // Bulk scan: stay loaded — the printed-vs-tagged ledger decides
      // when this product is finished.
      el.rfid.value = "";
      el.rfid.focus();
      loadTags(pendingProduct);
      bulkCheckpoint();
    } else {
      // One tag per product: brief confirmation, then back to the barcode.
      setTimeout(resetStation, 700);
    }
  } catch (err) {
    setResult("Network error while saving the RFID tag.", "err", "rfid");
  }
}

// --- C72 LINK --------------------------------------------------------------
// The gun's LINK tab forwards every read here instead of acting on the gun:
// BT barcodes run the barcode path, trigger RFID reads run the tag path —
// identical to wedge input, every guard intact. Each scan's outcome is
// posted back so the gun can ding or buzz without the operator looking up.
let linkOn = false;
let linkCursor = -1;
let linkTimer = null;
let linkBusy = false;
const linkToggle = document.getElementById("link-toggle");
const linkStatus = document.getElementById("link-status");

function stationOutcome(where) {
  const target = where === "rfid" ? el.resultRfid : el.result;
  const cls = target.className || "";
  if (cls.includes("result--err")) {
    return { ok: false, text: target.textContent };
  }
  if (cls.includes("result--ok")) {
    return { ok: true, text: target.textContent };
  }
  // Still "busy" (or blank): the scan opened a window instead of settling —
  // unknown barcode, alias confirm, multi-box set. Human needed.
  return {
    ok: false,
    text: "Needs attention on the terminal screen (a window opened).",
  };
}

function stopLink(msg) {
  linkOn = false;
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = null;
  linkToggle.textContent = "C72 LINK: OFF";
  linkToggle.classList.remove("linkbar__btn--on");
  if (msg) linkStatus.textContent = msg;
}

async function actOnLinkScan(s) {
  let out;
  if (s.kind === "barcode") {
    el.barcode.value = s.value;
    await stationBarcodeScan(s.value);
    out = stationOutcome("barcode");
  } else if (!pendingProduct) {
    out = { ok: false, text: "No product loaded — scan a barcode first." };
    setResult(out.text, "err", "rfid");
  } else {
    el.rfid.value = s.value;
    await stationTagScan(s.value);
    out = stationOutcome("rfid");
  }
  linkStatus.textContent = `${s.value} → ${out.text}`.slice(0, 140);
  try {
    await apiFetch(`/api/link/scans/${s.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: out.ok,
        outcome: (out.text || "").slice(0, 300),
      }),
    });
  } catch (err) {
    // The action already happened; a lost outcome just means no gun ding.
  }
}

async function pollLink() {
  if (!linkOn || linkBusy) return;
  // Only act while the Scan station is actually on screen — relayed scans
  // silently mutating a hidden tab would be spooky.
  if (tabSections.scan[0].hidden) return;
  linkBusy = true;
  try {
    const res = await apiFetch(`/api/link/scans?after=${linkCursor}`);
    if (!res.ok) return;
    const body = await res.json();
    for (const s of body.scans) {
      await actOnLinkScan(s);
    }
    linkCursor = body.cursor;
  } catch (err) {
    // Poll again next tick.
  } finally {
    linkBusy = false;
  }
}

if (linkToggle) {
  linkToggle.addEventListener("click", async () => {
    if (linkOn) {
      stopLink("Gun scans stay on the gun.");
      return;
    }
    linkStatus.textContent = "Connecting…";
    try {
      // Seat the cursor at "now" so scans fired before the toggle never
      // replay into the station.
      const res = await apiFetch("/api/link/scans?after=-1");
      const body = await res.json();
      linkCursor = body.cursor;
      linkOn = true;
      linkToggle.textContent = "C72 LINK: ON";
      linkToggle.classList.add("linkbar__btn--on");
      linkStatus.textContent =
        "Listening — scans from the gun's LINK tab act here now.";
      linkTimer = setInterval(pollLink, 1000);
    } catch (err) {
      linkStatus.textContent = "Could not reach the server — try again.";
    }
  });
}

// --- Bulk scan --------------------------------------------------------------
// Apply many labels, then let the tags stream in — single reads (wedge or
// LINK) and pulled C72 sweeps both count against a printed-this-visit
// ledger that decides when the product is done. A strict subset of
// auto-reset: auto-reset OFF disables the chip, and the chip falls back to
// OFF every time a new product loads.
let bulkOn = false;
let bulkPrinted = 0; // labels queued while this product has been loaded
let bulkTagged = 0; // new tags assigned to it this visit
let lastSweep = []; // EPCs from the most recent assigning action
let bulkWarnedAt = -1; // over-count the operator already chose to keep
const bulkToggle = document.getElementById("bulk-toggle");
const bulkSweepBtn = document.getElementById("bulk-sweep");
const bulkProgress = document.getElementById("bulk-progress");
const bulkWarnEl = document.getElementById("bulk-warn");

function bulkVisitReset() {
  bulkOn = false;
  bulkPrinted = 0;
  bulkTagged = 0;
  lastSweep = [];
  bulkWarnedAt = -1;
  if (bulkWarnEl) bulkWarnEl.hidden = true;
  renderBulk();
}

function renderBulk() {
  if (!bulkToggle) return;
  const allowed = el.autoReset.checked;
  if (!allowed) bulkOn = false;
  bulkToggle.disabled = !allowed;
  bulkToggle.classList.toggle("chip-toggle--on", bulkOn);
  bulkToggle.textContent = bulkOn ? "⚡ BULK: ON" : "⚡ BULK: OFF";
  const active = bulkOn && !!pendingProduct;
  bulkSweepBtn.hidden = !active;
  bulkProgress.hidden = !active;
  if (active) {
    bulkProgress.textContent =
      bulkPrinted > 0
        ? `${bulkTagged} of ${bulkPrinted} label(s) printed this visit ` +
          `are tagged` +
          (bulkTagged < bulkPrinted
            ? ` — ${bulkPrinted - bulkTagged} to go.`
            : ".")
        : `${bulkTagged} tag(s) assigned · no labels printed this visit, ` +
          `so no auto-reset target — Reset (Esc) when done.`;
  }
}

bulkToggle.addEventListener("click", () => {
  if (bulkToggle.disabled) return;
  bulkOn = !bulkOn;
  bulkWarnEl.hidden = true;
  renderBulk();
});
el.autoReset.addEventListener("change", renderBulk);

// The ledger's verdict after every assigning action: exact = done (reset
// as a single scan would), over = ask (a blank label may have been swept).
function bulkCheckpoint() {
  renderBulk();
  if (!bulkPrinted) return;
  if (bulkTagged === bulkPrinted) {
    setResult(
      `All ${bulkPrinted} label(s) printed this visit are tagged ✓ — ` +
        `resetting.`,
      "ok",
      "rfid"
    );
    bulkWarnEl.hidden = true;
    setTimeout(resetStation, 900);
  } else if (bulkTagged > bulkPrinted && bulkTagged > bulkWarnedAt) {
    document.getElementById("bulk-warn-text").textContent =
      `${bulkTagged} tag(s) assigned against ${bulkPrinted} label(s) ` +
      `printed this visit — a spare or blank label in range may have ` +
      `been swept and wrongly assigned. Undo removes only the ` +
      `${lastSweep.length} tag(s) this last action assigned.`;
    document.getElementById("bulk-warn-undo").textContent =
      `UNDO THIS SWEEP (${lastSweep.length})`;
    bulkWarnEl.hidden = false;
  }
}

bulkSweepBtn.addEventListener("click", async () => {
  if (!pendingProduct) return;
  const operator = requireOperator();
  if (!operator) return;
  bulkSweepBtn.disabled = true;
  try {
    const capRes = await apiFetch("/api/epc-captures/latest");
    if (capRes.status === 404) {
      setResult(
        "No C72 sweeps received yet — SWEEP then SEND on the gun first.",
        "err",
        "rfid"
      );
      return;
    }
    const cap = await capRes.json();
    const res = await postJson("/api/rfid-assignments/sweep", {
      epcs: cap.epcs || [],
      ...pendingProduct,
      assigned_by: operator,
    });
    (res.assigned || []).forEach(prependRecent);
    bulkTagged += res.count;
    if (res.count > 0) lastSweep = res.assigned.map((a) => a.rfid_id);
    const dup = (res.duplicates || []).length;
    setResult(
      `Sweep (${cap.epc_count} tag(s) heard): ${res.count} new assigned` +
        (dup ? ` · ${dup} already assigned — skipped` : "") +
        ".",
      res.count > 0 ? "ok" : "err",
      "rfid"
    );
    loadTags(pendingProduct);
    bulkCheckpoint();
  } catch (err) {
    setResult(err.message, "err", "rfid");
  } finally {
    bulkSweepBtn.disabled = false;
  }
});

document
  .getElementById("bulk-warn-undo")
  .addEventListener("click", async () => {
    if (!lastSweep.length) {
      bulkWarnEl.hidden = true;
      return;
    }
    const btn = document.getElementById("bulk-warn-undo");
    btn.disabled = true;
    try {
      const res = await postJson("/api/rfid-assignments/sweep/undo", {
        epcs: lastSweep,
        sku: (pendingProduct && pendingProduct.sku) || null,
        by: operatorEl.value || null,
      });
      bulkTagged = Math.max(0, bulkTagged - res.count);
      for (const epc of res.epcs || []) {
        const li = el.recentList.querySelector(`li[data-rfid="${epc}"]`);
        if (li) li.remove();
      }
      lastSweep = [];
      bulkWarnEl.hidden = true;
      setResult(
        `Sweep undone — ${res.count} tag(s) unlinked (History has the ` +
          `receipt).`,
        "ok",
        "rfid"
      );
      if (pendingProduct) loadTags(pendingProduct);
      renderBulk();
    } catch (err) {
      setResult(err.message, "err", "rfid");
    } finally {
      btn.disabled = false;
    }
  });

document.getElementById("bulk-warn-keep").addEventListener("click", () => {
  bulkWarnedAt = bulkTagged; // don't re-ask until the count grows again
  bulkWarnEl.hidden = true;
  setResult("Kept — the over-count stands.", "ok", "rfid");
});

// --- Recent list -----------------------------------------------------------
function recentRow(a) {
  const li = document.createElement("li");
  li.dataset.rfid = a.rfid_id;
  const when = a.assigned_at
    ? tsDate(a.assigned_at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
  li.innerHTML = `
    <span class="recent__epc">${escapeHtml(a.rfid_id)}</span>${
      a.suspect
        ? '<span class="suspect" title="Tag doesn\'t look like a normal ' +
          '24-character EPC — probably a bad read. Re-scan this tag into ' +
          'inventory.">⚠</span>'
        : ""
    }
    <span class="recent__prod">${escapeHtml(a.product_title || "")}${
      a.variant_title ? " (" + escapeHtml(a.variant_title) + ")" : ""
    }</span>
    <span class="recent__meta">${escapeHtml(a.bin_location || "")}</span>
    <span class="recent__meta recent__when">${escapeHtml(when)}</span>
    <button class="recent__unassign" type="button">unassign</button>
  `;
  li.querySelector(".recent__unassign").addEventListener("click", () =>
    unassign(a.rfid_id, li)
  );
  return li;
}

function prependRecent(a) {
  const empty = el.recentList.querySelector(".recent__empty");
  if (empty) empty.remove();
  el.recentList.prepend(recentRow(a));
}

async function loadRecent(query = "") {
  try {
    // The Inventory tab is the full view; this list is just a live tail
    // of the last few scans (searches get more room).
    const url = query
      ? `/api/rfid-assignments?q=${encodeURIComponent(query)}&limit=50`
      : "/api/rfid-assignments?limit=10";
    const res = await apiFetch(url);
    if (!res.ok) return;
    const data = await res.json();
    el.recentList.innerHTML = "";
    if (!data.assignments.length) {
      el.recentList.innerHTML =
        '<li class="recent__empty">No assignments yet.</li>';
      return;
    }
    data.assignments.forEach((a) => el.recentList.append(recentRow(a)));
  } catch (err) {
    // Database not configured yet during Phase 1 — leave the list empty.
  }
}

async function unassign(rfid, li) {
  if (!confirm(`Unassign tag ${rfid}?`)) return;
  const res = await apiFetch(
    `/api/rfid-assignments/${encodeURIComponent(rfid)}`,
    { method: "DELETE" }
  );
  if (res.ok) li.remove();
}

// --- Inventory tab ----------------------------------------------------------
let inventoryRows = [];

// A text box that drops a list of the values actually present, narrowing
// as you type. Selection is exact-match filtering; free text narrows the
// list without filtering the table until something is picked.
function makeCombo(id, onPick) {
  const root = document.getElementById(id);
  const input = root.querySelector(".combo__input");
  const list = root.querySelector(".combo__list");
  const clear = root.querySelector(".combo__clear");
  let options = [];
  let value = "";

  function close() {
    list.hidden = true;
  }

  function open() {
    const typed = input.value.trim().toLowerCase();
    const shown = options.filter(
      (o) => !typed || o.label.toLowerCase().includes(typed)
    );
    list.innerHTML = "";
    if (!shown.length) {
      list.innerHTML = '<li class="combo__none">No matches</li>';
    } else {
      shown.slice(0, 200).forEach((o) => {
        const li = document.createElement("li");
        if (o.label === value) li.classList.add("combo--on");
        li.innerHTML =
          escapeHtml(o.label) +
          (o.count != null
            ? `<span class="combo__count">${o.count}</span>`
            : "");
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault(); // don't blur before we read the click
          value = o.label;
          input.value = o.label;
          close();
          onPick(value);
        });
        list.append(li);
      });
    }
    list.hidden = false;
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", () => {
    open();
    // Typing a value that exactly matches an option applies it; otherwise
    // clearing the box clears the filter.
    const typed = input.value.trim();
    const exact = options.find(
      (o) => o.label.toLowerCase() === typed.toLowerCase()
    );
    const next = exact ? exact.label : "";
    if (next !== value) {
      value = next;
      onPick(value);
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      input.blur();
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    value = "";
    close();
    onPick("");
    input.focus();
  });

  return {
    setOptions(next) {
      options = next;
      // A chosen value that no longer exists shouldn't hide everything.
      if (value && !options.some((o) => o.label === value)) {
        value = "";
        input.value = "";
        onPick("");
      }
    },
    get value() {
      return value;
    },
  };
}

let invBinCombo = null;
let invVendorCombo = null;
let invBinFilter = "";
let invVendorFilter = "";

async function loadInventory() {
  const body = document.getElementById("inv-body");
  try {
    const res = await apiFetch("/api/inventory/summary");
    if (!res.ok) {
      body.innerHTML =
        '<tr><td colspan="7" class="inventory__empty">Could not load inventory.</td></tr>';
      return;
    }
    const data = await res.json();
    inventoryRows = data.products;
    // Offer only values that exist, with how many products each covers.
    const countBy = (key) => {
      const m = new Map();
      inventoryRows.forEach((p) => {
        if (p[key]) m.set(p[key], (m.get(p[key]) || 0) + 1);
      });
      return m;
    };
    const binCounts = countBy("bin_location");
    const vendorCounts = countBy("vendor");
    if (invBinCombo)
      invBinCombo.setOptions(
        (data.bins || []).map((b) => ({ label: b, count: binCounts.get(b) }))
      );
    if (invVendorCombo)
      invVendorCombo.setOptions(
        (data.vendors || []).map((v) => ({
          label: v,
          count: vendorCounts.get(v),
        }))
      );
    renderInventory();
  } catch (err) {
    body.innerHTML =
      '<tr><td colspan="7" class="inventory__empty">Network error.</td></tr>';
  }
}

// Link to a product's page in Shopify admin. Only products with a real
// Shopify GID can be linked — TELCAN-resolved rows carry "handle:…" ids
// no admin URL can be built from; those names stay plain text.
function adminProductUrl(pid) {
  const shop = document.body.dataset.shop;
  if (!shop || !pid) return null;
  const m = String(pid).match(/(?:gid:\/\/shopify\/Product\/)?(\d+)$/);
  return m ? `https://admin.shopify.com/store/${shop}/products/${m[1]}` : null;
}

function productLink(title, pid) {
  const url = adminProductUrl(pid);
  const name = escapeHtml(title || "");
  return url
    ? `<a class="prodlink" href="${url}" target="_blank" rel="noopener" title="Open in Shopify admin">${name}</a>`
    : name;
}

function renderInventory() {
  const body = document.getElementById("inv-body");
  const countEl = document.getElementById("inv-count");
  const q = document.getElementById("inv-search").value.trim().toLowerCase();
  let rows = inventoryRows.filter((p) => {
    if (
      invBinFilter &&
      (p.bin_location || "").toLowerCase() !== invBinFilter.toLowerCase()
    )
      return false;
    if (
      invVendorFilter &&
      (p.vendor || "").toLowerCase() !== invVendorFilter.toLowerCase()
    )
      return false;
    if (!q) return true;
    return [p.product_title, p.variant_title, p.sku, p.barcode, p.vendor]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const sort = document.getElementById("inv-sort").value;
  const byText = (a, b, key) =>
    String(a[key] || "￿").localeCompare(String(b[key] || "￿"),
      undefined, { numeric: true, sensitivity: "base" });
  rows = [...rows];
  if (sort === "vendor")
    // Products with no vendor sort last rather than pretending to be "".
    rows.sort((a, b) => byText(a, b, "vendor") ||
      byText(a, b, "product_title"));
  else if (sort === "product") rows.sort((a, b) => byText(a, b, "product_title"));
  else if (sort === "bin") rows.sort((a, b) => byText(a, b, "bin_location"));
  else if (sort === "tags") rows.sort((a, b) => b.tag_count - a.tag_count);
  else
    rows.sort((a, b) =>
      String(b.last_assigned_at || "").localeCompare(
        String(a.last_assigned_at || "")
      )
    );

  const filtered = invBinFilter || invVendorFilter || q;
  countEl.textContent = filtered
    ? `(${rows.length} of ${inventoryRows.length})`
    : `(${inventoryRows.length})`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="inventory__empty">${
      filtered
        ? "Nothing matches those filters."
        : "No products yet — assign or print a first tag."
    }</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((p) => {
      const title =
        productLink(p.product_title, p.shopify_product_id) +
        (p.variant_title
          ? ` <span class="inventory__variant">(${escapeHtml(p.variant_title)})</span>`
          : "") +
        (p.rfid_incompatible
          ? ' <span class="noscan-chip" title="tag won\'t scan when on ' +
            'box — sweeps don\'t expect it to answer">⊘ no RFID</span>'
          : "");
      const when = p.last_assigned_at
        ? tsDate(p.last_assigned_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "—";
      return `<tr>
        <td>${title}</td>
        <td>${escapeHtml(p.vendor || "—")}</td>
        <td class="mono">${
          p.sku
            ? `<span class="skulink" data-sku="${escapeHtml(p.sku)}" title="Open this product — label editor, RFID flag, full history">${escapeHtml(p.sku)}</span>`
            : "—"
        }</td>
        <td>${p.bin_location && p.bin_location !== "No bin assigned"
          ? `<span class="inventory__bin">${escapeHtml(p.bin_location)}</span>`
          : "—"}${
          p.bin_differs && p.sku
            ? ` <button class="binfix inv-setbin" type="button" data-sku="${escapeHtml(
                p.sku
              )}" data-bin="${escapeHtml(
                p.bin_location
              )}" data-was="${escapeHtml(
                p.shopify_bin || "nothing"
              )}" title="Shopify's bin says ${escapeHtml(
                p.shopify_bin || "nothing"
              )}, but this product's tags were placed at ${escapeHtml(
                p.bin_location
              )}. Click to write ${escapeHtml(
                p.bin_location
              )} to Shopify (audited, undoable via History).">⇢ Shopify</button>`
            : ""
        }</td>
        <td class="num">${
          p.unit_breakdown
            ? `${p.unit_count}<div class="inv__cases" title="${escapeHtml(
                caseHint(p)
              )}">${escapeHtml(p.unit_breakdown)}</div>`
            : p.tag_count
        }</td>
        <td class="num">${p.shopify_qty ?? "—"}</td>
        <td>${escapeHtml(when)}</td>
      </tr>`;
    })
    .join("");
}

// Inventory rows open the same product panel History uses — label editor,
// preview, RFID flag and paper trail in one place.
document.getElementById("inv-body").addEventListener("click", async (e) => {
  // Tag placement is a physical fact; when Shopify's bin disagrees, this
  // writes the tags' bin to Shopify via the normal audited update.
  const fix = e.target.closest(".inv-setbin");
  if (fix) {
    const { sku, bin, was } = fix.dataset;
    if (
      !confirm(
        `Set the Shopify bin for ${sku} to ${bin}?\n\n` +
          `Shopify currently says: ${was}. This is the normal audited ` +
          `bin write — Shopify, the bin map and this product's tags all ` +
          `follow, with a History entry.`
      )
    )
      return;
    fix.disabled = true;
    try {
      await postJson("/api/bin-updates", {
        target: sku,
        bin,
        changed_by: operatorEl.value || null,
      });
      fix.textContent = "✓ written";
      await loadInventory();
    } catch (err) {
      alert(`Bin update failed: ${err.message}`);
      fix.disabled = false;
    }
    return;
  }
  const s = e.target.closest(".skulink");
  if (s && s.dataset.sku) openProductHistory(s.dataset.sku);
});

let invSearchTimer;
document.getElementById("inv-search").addEventListener("input", () => {
  clearTimeout(invSearchTimer);
  invSearchTimer = setTimeout(renderInventory, 150);
});

invBinCombo = makeCombo("combo-bin", (v) => {
  invBinFilter = v;
  renderInventory();
});
invVendorCombo = makeCombo("combo-vendor", (v) => {
  invVendorFilter = v;
  renderInventory();
});
document.getElementById("inv-sort").addEventListener("change", renderInventory);

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRecent(el.search.value.trim()), 200);
});

// --- Global controls -------------------------------------------------------
el.reset.addEventListener("click", resetStation);
document.addEventListener("keydown", (e) => {
  // Esc resets the scan station only while it's the visible tab — otherwise
  // it would steal focus from the batch/queue inputs.
  if (e.key === "Escape" && !document.getElementById("tab-scan").hidden) {
    resetStation();
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtWhen(iso) {
  return iso
    ? tsDate(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

async function apiJson(url, opts) {
  const res = await apiFetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof body.detail === "string" ? body.detail : "Request failed.";
    throw new Error(msg);
  }
  return body;
}

function postJson(url, payload) {
  return apiJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// === Batch tagging ==========================================================
// One bin at a time: collect -> labels -> print -> pair -> verify -> done.
// The server owns the batch; this block just drives the stages.
let batch = null; // {id, bin_name, status, ...}
let batchItems = []; // BatchItem dicts (server shape)
let batchStage = "collect";
let pairActiveItemId = null;
let pairHistory = []; // [{epc, item_id}] for undo
let verifyEpcs = new Set();
let batchPrintTimer = null;

const bEl = {
  start: document.getElementById("batch-start"),
  bin: document.getElementById("batch-bin"),
  create: document.getElementById("batch-create"),
  resumeWrap: document.getElementById("batch-resume-wrap"),
  resumeList: document.getElementById("batch-resume-list"),
  active: document.getElementById("batch-active"),
  binChip: document.getElementById("batch-bin-chip"),
  stages: document.getElementById("batch-stages"),
  abandon: document.getElementById("batch-abandon"),
  result: document.getElementById("batch-result"),
  scan: document.getElementById("batch-scan"),
  items: document.getElementById("batch-items"),
  toLabels: document.getElementById("batch-to-labels"),
  queue: document.getElementById("batch-queue"),
  printAgent: document.getElementById("bprint-agent"),
  printStatus: document.getElementById("bprint-status"),
  toPair: document.getElementById("batch-to-pair"),
  pairInput: document.getElementById("batch-pair-input"),
  pairCard: document.getElementById("bpair-card"),
  pairActive: document.getElementById("bpair-active"),
  pairProgress: document.getElementById("bpair-progress"),
  pairUndo: document.getElementById("bpair-undo"),
  pairItems: document.getElementById("bpair-items"),
  toVerify: document.getElementById("batch-to-verify"),
  verifyInput: document.getElementById("batch-verify-input"),
  verifyCount: document.getElementById("bverify-count"),
  verifyCheck: document.getElementById("bverify-check"),
  complete: document.getElementById("batch-complete"),
  verifyReport: document.getElementById("bverify-report"),
};

function setBatchResult(message, kind) {
  bEl.result.textContent = message;
  bEl.result.className = "result" + (kind ? ` result--${kind}` : "");
}

function itemDisplayName(item) {
  return (
    (item.label_name || item.product_title || item.scanned_code || "—") +
    (item.variant_title && !item.label_name
      ? ` (${item.variant_title})`
      : "")
  );
}

function enterBatchTab() {
  const board = document.querySelector(".binboard");
  if (batch) {
    board.hidden = true;
    showBatchStage(batchStage);
    return;
  }
  bEl.start.hidden = false;
  bEl.active.hidden = true;
  board.hidden = false;
  loadResumeList();
  loadBinBoard();
  bEl.bin.focus();
}

async function loadResumeList() {
  try {
    const { batches } = await apiJson("/api/batches?status=open&limit=10");
    bEl.resumeList.innerHTML = "";
    bEl.resumeWrap.hidden = !batches.length;
    batches.forEach((b) => {
      const li = document.createElement("li");
      const label =
        b.kind === "receiving"
          ? "📦 Receiving"
          : `Bin ${escapeHtml(b.bin_name)}`;
      li.innerHTML =
        `<b>${label}</b> — ${b.products} product(s), ` +
        `${b.boxes} box(es), ${b.paired} paired · ${escapeHtml(b.status)} ` +
        `<span class="mono">${escapeHtml(fmtWhen(b.created_at))}` +
        `${b.created_by ? " · " + escapeHtml(b.created_by) : ""}</span>`;
      li.addEventListener("click", () => resumeBatch(b.id));
      bEl.resumeList.append(li);
    });
  } catch (err) {
    bEl.resumeWrap.hidden = true;
  }
}

// --- Bin work board ---------------------------------------------------------
// Every bin in the store (from the Shopify bin map) that hasn't been
// batched yet, plus the last few that were finished.
let binBoard = null;

async function loadBinBoard() {
  const list = document.getElementById("binboard-list");
  const recent = document.getElementById("binboard-recent");
  try {
    binBoard = await apiJson("/api/bins/overview?recent=8");
    renderBinBoard();
    recent.innerHTML = "";
    if (!binBoard.recent.length) {
      recent.innerHTML =
        '<li class="recent__empty">No finished bins yet.</li>';
      return;
    }
    binBoard.recent.forEach((r) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="binlist__name">${escapeHtml(r.bin)}</span>` +
        (r.side_trip
          ? '<span class="binlist__sidetrip" title="Only the boxes ' +
            "carried over were tagged — the rest of this shelf was " +
            'never checked">side trip</span>'
          : "") +
        `<div class="binlist__count">${r.products} product(s) · ` +
        `${r.boxes} box(es) · ${r.tags} tag(s)</div>` +
        `<div class="binlist__count">${escapeHtml(fmtWhen(r.completed_at))}` +
        `${r.by ? " · " + escapeHtml(r.by) : ""}</div>`;
      recent.append(li);
    });
  } catch (err) {
    list.innerHTML = `<li class="recent__empty">${escapeHtml(err.message)}</li>`;
  }
}

let showHiddenBins = false;
// Odd-named bins (not the usual "B19-2" shape) are a known backlog — 76 of
// them last count — and they crowd out the bins actually worth working.
// Remembered, because someone clearing normal bins wants them gone every
// session, not just this one.
let hideOddBins = localStorage.getItem("hideOddBins") === "1";
let binSort = "products";

// Eye / crossed-out eye, drawn inline so there's no icon dependency.
const ICON_EYE =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
  '<circle cx="12" cy="12" r="3.2"/></svg>';
const ICON_EYE_OFF =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
  '<circle cx="12" cy="12" r="3.2"/>' +
  '<line x1="2.5" y1="2.5" x2="21.5" y2="21.5"/></svg>';

function sortBins(rows) {
  const byName = (a, b) =>
    a.bin.localeCompare(b.bin, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  const copy = [...rows];
  if (binSort === "name") copy.sort(byName);
  else if (binSort === "name-desc") copy.sort((a, b) => byName(b, a));
  else if (binSort === "fewest")
    copy.sort((a, b) => a.products - b.products || byName(a, b));
  else copy.sort((a, b) => b.products - a.products || byName(a, b));
  // Bins already being worked stay at the top whatever the sort.
  copy.sort((a, b) => (a.open_batch_id ? 0 : 1) - (b.open_batch_id ? 0 : 1));
  return copy;
}

function renderBinBoard() {
  const list = document.getElementById("binboard-list");
  const countEl = document.getElementById("binboard-count");
  const hideBtn = document.getElementById("binboard-showhidden");
  if (!binBoard) return;
  const q = document
    .getElementById("binboard-filter")
    .value.trim()
    .toLowerCase();
  const rows = sortBins(
    binBoard.todo.filter(
      (b) =>
        (showHiddenBins || !b.hidden) &&
        (!hideOddBins || !b.malformed) &&
        (!q || b.bin.toLowerCase().includes(q))
    )
  );
  // How many the odd-name filter is actually holding back right now — the
  // store-wide malformed_count includes done and hidden bins, so quoting it
  // here would claim to be hiding bins that were never in this list.
  const oddInList = binBoard.todo.filter(
    (b) => b.malformed && (showHiddenBins || !b.hidden)
  ).length;
  countEl.textContent =
    `(${binBoard.todo_count} of ${binBoard.total_bins} left · ` +
    `${binBoard.done_bins} done` +
    `${binBoard.hidden_count ? ` · ${binBoard.hidden_count} hidden` : ""}` +
    `${
      binBoard.malformed_count
        ? ` · ${binBoard.malformed_count} odd name(s)`
        : ""
    }${
      binBoard.flagged_count ? ` · ${binBoard.flagged_count} flagged` : ""
    })`;
  hideBtn.innerHTML = showHiddenBins
    ? `${ICON_EYE_OFF}<span>Hide ignored</span>`
    : `${ICON_EYE}<span>Show hidden${
        binBoard.hidden_count ? ` (${binBoard.hidden_count})` : ""
      }</span>`;
  const oddBtn = document.getElementById("binboard-oddfilter");
  oddBtn.innerHTML = hideOddBins
    ? `${ICON_EYE}<span>Show odd names${oddInList ? ` (${oddInList})` : ""}</span>`
    : `${ICON_EYE_OFF}<span>Hide odd names${
        oddInList ? ` (${oddInList})` : ""
      }</span>`;
  // Nothing to offer when every bin is well named.
  oddBtn.hidden = !oddInList && !hideOddBins;
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<li class="recent__empty">${
      q
        ? "No bins match that."
        : hideOddBins && oddInList
          ? `Nothing left but ${oddInList} odd-named bin(s), which are hidden.`
          : binBoard.hidden_count && !showHiddenBins
            ? `Nothing left to do — ${binBoard.hidden_count} bin(s) are hidden.`
            : "Every bin has been done ✓"
    }</li>`;
    return;
  }
  rows.forEach((b) => {
    const li = document.createElement("li");
    if (b.open_batch_id) li.classList.add("binlist--open");
    if (b.hidden) li.classList.add("binlist--hidden");
    if (b.malformed) li.classList.add("binlist--odd");
    if (b.flagged) li.classList.add("binlist--flagged");
    li.innerHTML =
      `<button class="binlist__eye" type="button" title="${
        b.hidden ? "Show bin" : "Hide bin"
      }" aria-label="${b.hidden ? "Show bin" : "Hide bin"}">${
        b.hidden ? ICON_EYE : ICON_EYE_OFF
      }</button>` +
      `<button class="binlist__flagbtn" type="button" title="${
        b.flagged
          ? "Remove the ask-first flag"
          : "Flag: ask someone before scanning this bin"
      }" aria-label="${b.flagged ? "Unflag bin" : "Flag bin"}">⚑</button>` +
      `<span class="binlist__name">${escapeHtml(b.bin)}</span>` +
      `${
        b.malformed
          ? `<span class="binlist__odd" title="Bin name doesn't match the A1-2 format (one letter, then 1-99, dash, 1-99). Usually means one product's stock is split across shelves — worth fixing in Shopify before tagging this bin.">⚠ odd name</span>`
          : ""
      }` +
      `${
        b.flagged
          ? `<span class="binlist__flag" title="${escapeHtml(
              b.flag_note || "Ask someone who knows this stock before scanning."
            )}">⚑ ask first</span>`
          : ""
      }` +
      `<span class="binlist__count">${b.products} product(s)${
        b.open_batch_id ? " · in progress" : ""
      }${b.hidden ? " · hidden" : ""}</span>` +
      `<button class="binlist__go" type="button">${
        b.open_batch_id ? "Resume" : "Start batch"
      }</button>`;
    // Clicking the name only fills the box — starting is a deliberate act.
    li.querySelector(".binlist__name").addEventListener("click", () => {
      bEl.bin.value = b.bin;
      bEl.bin.focus();
    });
    li.querySelector(".binlist__go").addEventListener("click", () => {
      if (b.open_batch_id) {
        resumeBatch(b.open_batch_id);
      } else {
        bEl.bin.value = b.bin;
        startBatch();
      }
    });
    li.querySelector(".binlist__eye").addEventListener("click", async (ev) => {
      const hidden = !b.hidden;
      ev.currentTarget.disabled = true;
      try {
        await apiJson(`/api/bins/${encodeURIComponent(b.bin)}/hidden`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hidden,
            hidden_by: operatorEl.value || null,
          }),
        });
        b.hidden = hidden;
        binBoard.todo_count += hidden ? -1 : 1;
        binBoard.hidden_count += hidden ? 1 : -1;
        renderBinBoard();
      } catch (err) {
        ev.currentTarget.disabled = false;
        setBatchResult(err.message, "err");
      }
    });
    li.querySelector(".binlist__flagbtn").addEventListener(
      "click",
      async (ev) => {
        const flagged = !b.flagged;
        let note = null;
        if (flagged) {
          note = prompt(
            `Flag ${b.bin} as "ask first".\n\n` +
              `Why does it need a second opinion? (optional)`,
            b.flag_note || ""
          );
          if (note === null) return; // cancelled
          note = note.trim() || null;
        }
        ev.currentTarget.disabled = true;
        try {
          await apiJson(`/api/bins/${encodeURIComponent(b.bin)}/flagged`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              flagged,
              note,
              flagged_by: operatorEl.value || null,
            }),
          });
          b.flagged = flagged;
          b.flag_note = note;
          binBoard.flagged_count += flagged ? 1 : -1;
          renderBinBoard();
        } catch (err) {
          ev.currentTarget.disabled = false;
          setBatchResult(err.message, "err");
        }
      }
    );
    list.append(li);
  });
}

document.getElementById("binboard-showhidden").addEventListener("click", () => {
  showHiddenBins = !showHiddenBins;
  renderBinBoard();
});

document.getElementById("binboard-oddfilter").addEventListener("click", () => {
  hideOddBins = !hideOddBins;
  localStorage.setItem("hideOddBins", hideOddBins ? "1" : "0");
  renderBinBoard();
});

document.getElementById("binboard-sort").addEventListener("change", (e) => {
  binSort = e.target.value;
  renderBinBoard();
});

// Force a full re-read of bins from Shopify. Needed because Shopify can't
// be asked "which products are in bin X" — only the whole catalog walk
// finds products that MOVED INTO a bin.
document.getElementById("binboard-refresh").addEventListener("click", async () => {
  const btn = document.getElementById("binboard-refresh");
  const countEl = document.getElementById("binboard-count");
  btn.disabled = true;
  const original = countEl.textContent;
  const stopDots = startDots(countEl, "(re-reading bins from Shopify");
  try {
    await postJson("/api/bin-map/refresh", {});
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await apiJson("/api/bin-map/status");
      if (!s.refreshing) break;
    }
    stopDots();
    await loadBinBoard();
  } catch (err) {
    stopDots();
    countEl.textContent = original;
    setBatchResult(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

let binFilterTimer;
document.getElementById("binboard-filter").addEventListener("input", () => {
  clearTimeout(binFilterTimer);
  binFilterTimer = setTimeout(renderBinBoard, 120);
});

// --- shelf baseline: reconcile a part-tagged bin ---------------------------
// Some shelves were tagged in an earlier session (Astronomik on D2-2), and
// there was no way to know how far that got. Sweep the shelf on the C72's
// SWEEP tab, SEND it, then apply it here: every tag read marks its product
// already-done, and the batch becomes exactly the untagged remainder.
document.getElementById("batch-baseline").addEventListener("click", async () => {
  if (!batch) return;
  let cap;
  try {
    cap = await apiJson("/api/epc-captures/latest");
  } catch (err) {
    setBatchResult(
      "No sweep on file yet — on the C72, open SWEEP, hold the trigger " +
        "over the shelf, then hit SEND. Then click this again.",
      "err"
    );
    return;
  }
  const when = cap.created_at
    ? tsDate(cap.created_at).toLocaleTimeString()
    : "?";
  if (
    !confirm(
      `Use the last C72 sweep as the baseline for ${batch.bin_name}?\n\n` +
        `${cap.epc_count} tag(s), from ${cap.device || "C72"} at ${when}.\n\n` +
        `Every tag read marks its product as already tagged — those boxes ` +
        `won't get labels. Make sure that sweep was THIS shelf.`
    )
  )
    return;
  try {
    const res = await postJson(`/api/batches/${batch.id}/baseline`, {
      epcs: cap.epcs || [],
    });
    await pullBatch(false);
    renderBatchItems();
    let msg = res.message;
    if (res.strays && res.strays.length) {
      msg +=
        " Strays: " +
        res.strays
          .slice(0, 5)
          .map((s) => `${s.sku || "?"} (recorded in ${s.recorded_bin || "?"})`)
          .join(", ") +
        (res.strays.length > 5 ? "…" : "");
    }
    setBatchResult(msg, res.strays && res.strays.length ? "err" : "ok");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

bEl.create.addEventListener("click", startBatch);

// Start a receiving (shipment) batch: no bin, everything comes from scans.
document
  .getElementById("batch-create-receiving")
  .addEventListener("click", async () => {
    const operator = operatorEl.value;
    if (!operator) {
      setBatchResult("Pick who's scanning (top right) first.", "err");
      operatorEl.focus();
      return;
    }
    try {
      batch = await postJson("/api/batches", {
        kind: "receiving",
        created_by: operator,
      });
      batchItems = batch.items || [];
      openBatchView("collect");
      setBatchResult(
        "Receiving started — scan every box you can reach, then Print " +
          "new labels. Labels come out in scan order, each with the " +
          "product's home bin.",
        "ok"
      );
    } catch (err) {
      setBatchResult(err.message, "err");
    }
  });

// PRINT for a receiving pass: only boxes not yet labelled queue.
document.getElementById("recv-print").addEventListener("click", async () => {
  if (!isReceivingBatch()) return;
  try {
    const res = await postJson(`/api/batches/${batch.id}/queue-labels`, {
      requested_by: operatorEl.value || null,
    });
    let msg =
      res.count > 0
        ? `${res.count} label(s) queued — collect the stack and walk your ` +
          `line of boxes, then pair.`
        : "Nothing new to print.";
    if (res.skipped_no_bin && res.skipped_no_bin.length) {
      msg +=
        ` HELD (no bin assigned): ${res.skipped_no_bin.join(", ")} — ` +
        `assign bins and print again.`;
    }
    setBatchResult(msg, res.count > 0 ? "ok" : "err");
    if (res.count > 0) showBatchStage("print");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

// Finish receiving: close the shipment, file one bin-check per touched bin.
document.getElementById("recv-finish").addEventListener("click", async () => {
  if (!isReceivingBatch()) return;
  const unpaired = batchItems.reduce(
    (n, i) =>
      n +
      (i.resolved
        ? Math.max(
            0,
            (i.labels_total ?? i.qty_scanned + (i.case_count || 0)) -
              (i.paired_count || 0)
          )
        : 0),
    0
  );
  const warn = unpaired
    ? `\n\n⚠ ${unpaired} label(s) still have no tag paired — they'll be ` +
      `flagged for Review.`
    : "";
  if (
    !confirm(
      "Finish receiving?\n\nFiles an inventory-check Review task for " +
        "every bin that received stock — each one is a quick bin-audit " +
        "walk-scan." + warn
    )
  ) {
    return;
  }
  try {
    const res = await postJson(`/api/batches/${batch.id}/complete`, {
      finalize: true,
      created_by: operatorEl.value || null,
    });
    const bins = res.bins_touched || {};
    const parts = Object.entries(bins).map(([b, n]) => `${b} (${n})`);
    batch = null;
    batchItems = [];
    stopBatchPrintPoll();
    stopBatchLive();
    enterBatchTab();
    setBatchResult(
      parts.length
        ? `Receiving done ✓ — inventory checks filed for: ${parts.join(
            ", "
          )} (see Review).`
        : "Receiving done ✓ — nothing was shelved, no checks filed.",
      "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});
bEl.bin.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startBatch();
});

async function startBatch() {
  const bin = bEl.bin.value.trim();
  if (!bin) {
    bEl.bin.focus();
    return;
  }
  const operator = operatorEl.value;
  if (!operator) {
    setBatchResult("Pick who's scanning (top right) first.", "err");
    operatorEl.focus();
    return;
  }
  bEl.create.disabled = true;
  try {
    batch = await postJson("/api/batches", { bin, created_by: operator });
    batchItems = batch.items || [];
    bEl.bin.value = "";
    openBatchView("collect");
    setBatchResult(
      batchItems.length
        ? `${batchItems.length} product(s) expected in bin ${batch.bin_name} — start scanning boxes.`
        : `Nothing on file for bin ${batch.bin_name} — scan boxes and they'll be added.`,
      "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  } finally {
    bEl.create.disabled = false;
  }
}

// Re-pull the batch from the server. The C72 (or another terminal) writes
// every scan/pair server-side, so pulling is all "live" means.
// Server status → the stage that status belongs to. Used to follow along
// when another terminal (the C72) moves the batch forward.
const STAGE_FOR_STATUS = {
  collecting: "collect",
  printing: "print",
  pairing: "pair",
  // The scanner finished at the shelf and handed the bin over for
  // sign-off — land on Verify.
  "awaiting-verify": "verify",
};

// The batch's shared "which step are we on" signal. Status can't carry it
// (collect and check are both "collecting"), so terminals publish the step
// they're on and everyone else follows. "check" is this page's "labels".
const STEP_TO_STAGE = {
  collect: "collect",
  check: "labels",
  print: "print",
  pair: "pair",
  verify: "verify",
};
const STAGE_TO_STEP = {
  collect: "collect",
  labels: "check",
  print: "print",
  pair: "pair",
  verify: "verify",
};
// Set while applying a step that came FROM the server, so following a
// change doesn't immediately publish it back.
let applyingRemoteStep = false;
let lastPublishedStep = null;

function publishBatchStep(stage) {
  if (!batch || applyingRemoteStep) return;
  const step = STAGE_TO_STEP[stage];
  if (!step || step === lastPublishedStep) return;
  lastPublishedStep = step;
  postJson(`/api/batches/${batch.id}/step`, { step }).catch(() => {
    lastPublishedStep = null; // let a later attempt retry
  });
}

async function pullBatch(announce) {
  if (!batch) return;
  try {
    const prevStatus = batch.status;
    const data = await apiJson(`/api/batches/${batch.id}`);
    batch = data.batch;
    batchItems = data.items;
    // Resuming a side trip directly (or arriving from another terminal)
    // must still show the banner and the way back.
    renderSideTrip();
    // The C72 (or another browser) moved on — follow it, so this screen
    // doesn't sit on "1 Collect" while the scanner is checking or pairing.
    // The published step is the precise signal; status is the fallback for
    // moves made before this existed.
    const stepTarget = STEP_TO_STAGE[batch.ui_step || ""];
    const statusTarget =
      batch.status !== prevStatus ? STAGE_FOR_STATUS[batch.status] : null;
    // A status change is the stronger signal — the published step can be
    // stale (nobody republishes it when the server moves the batch on).
    const target = statusTarget || stepTarget;
    if (target && target !== batchStage) {
      applyingRemoteStep = true;
      lastPublishedStep = batch.ui_step || null;
      showBatchStage(target);
      applyingRemoteStep = false;
      setBatchResult(
        `Followed the scanner to the ${
          target === "labels" ? "check" : target
        } step.`,
        "ok"
      );
      return;
    }
    if (batchStage === "collect") renderBatchItems();
    else if (batchStage === "pair") {
      renderPairItems();
      renderPairCard();
    }
    // (check stage re-fetches its review on entry, not on the live poll —
    // the candidates lookups are too heavy to run every 3s)
    if (announce) setBatchResult("Refreshed from the server.", "ok");
  } catch (err) {
    if (announce) setBatchResult(err.message, "err");
  }
}

async function refreshBatch() {
  return pullBatch(true);
}

// Live feed: while a batch is open, poll every 3s so this screen mirrors
// whatever the C72 (or any other terminal) is doing to the same batch.
let batchLiveTimer = null;

// A sweep sent from the C72 lands here by itself: the scanner posts it,
// this screen notices, jumps to Verify and runs the check — no "pull"
// button dance. Only sweeps newer than the moment this batch was opened
// count, so an old capture can't hijack the screen.
let lastSweepId = null;

async function checkForIncomingSweep() {
  if (!batch) return;
  try {
    const { captures } = await apiJson("/api/epc-captures?limit=1");
    const newest = captures[0];
    if (lastSweepId === null) {
      // Baseline, set even when no sweep exists yet — otherwise the very
      // first sweep of a fresh system gets mistaken for history.
      lastSweepId = newest ? newest.id : 0;
      return;
    }
    if (!newest || newest.id <= lastSweepId) return;
    lastSweepId = newest.id;
    // Sweeps tagged for another batch aren't ours.
    if (newest.batch_id && newest.batch_id !== batch.id) return;
    const cap = await apiJson(`/api/epc-captures/${newest.id}`);
    if (batchStage !== "verify") showBatchStage("verify"); // this resets the set
    cap.epcs.forEach((e) => verifyEpcs.add(String(e).toUpperCase()));
    bEl.verifyCount.textContent = `${verifyEpcs.size} unique tags collected.`;
    setBatchResult(
      `Sweep #${cap.id} arrived from ${cap.device || "the C72"} ` +
        `(${cap.epc_count} tags) — checking the bin…`,
      "ok"
    );
    await runVerifyCheck();
    batchSound("ok");
  } catch (err) {
    /* transient; the next tick tries again */
  }
}

function startBatchLive() {
  stopBatchLive();
  lastSweepId = null;
  batchLiveTimer = setInterval(() => {
    // No document.hidden guard: embedded webviews (and some tablet shells)
    // misreport visibility, and a live feed that silently pauses is worse
    // than one cheap GET every 3s.
    if (!batch) return;
    if (document.getElementById("tab-batch").hidden) return;
    // Never clobber something the operator is typing (label names etc.);
    // the always-focused scan fields are exempt — they're transient.
    const ae = document.activeElement;
    if (
      ae &&
      ae.tagName === "INPUT" &&
      ae.closest("#tab-batch") &&
      // The always-focused scan fields are transient — polling must not
      // pause just because one has focus (it always does on those steps).
      ![
        "batch-scan",
        "batch-pair-input",
        "batch-verify-input",
        "batch-bin",
      ].includes(ae.id)
    )
      return;
    pullBatch(false);
    checkForIncomingSweep();
  }, 3000);
}

function stopBatchLive() {
  if (batchLiveTimer) {
    clearInterval(batchLiveTimer);
    batchLiveTimer = null;
  }
}

async function resumeBatch(id) {
  try {
    const data = await apiJson(`/api/batches/${id}`);
    batch = data.batch;
    batchItems = data.items;
    const stageByStatus = {
      collecting: "collect",
      printing: "print",
      pairing: "pair",
    };
    openBatchView(stageByStatus[batch.status] || "collect");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
}

// Receiving: a bin-less shipment batch that loops collect → print → pair.
// Labels/verify don't exist for it; PRINT repeats per pass and finishing
// files a bin-check Review task per touched bin.
function isReceivingBatch() {
  return !!(batch && batch.kind === "receiving");
}

function openBatchView(stage) {
  bEl.start.hidden = true;
  bEl.active.hidden = false;
  document.querySelector(".binboard").hidden = true;
  bEl.binChip.textContent = isReceivingBatch()
    ? "Receiving"
    : `Bin ${batch.bin_name}`;
  // Labels and verify aren't part of the receiving loop — hide their chips
  // so the flow reads collect → print → pair.
  bEl.stages.querySelectorAll(".stage").forEach((chip) => {
    const gone =
      isReceivingBatch() &&
      (chip.dataset.stage === "labels" || chip.dataset.stage === "verify");
    chip.style.display = gone ? "none" : "";
  });
  setBatchResult("", null);
  showBatchStage(stage);
  startBatchLive();
}

const BATCH_STAGES = ["collect", "labels", "print", "pair", "verify"];

function showBatchStage(stage) {
  if (isReceivingBatch() && (stage === "labels" || stage === "verify")) {
    stage = "collect";
  }
  batchStage = stage;
  stopBatchPrintPoll();
  const idx = BATCH_STAGES.indexOf(stage);
  bEl.stages.querySelectorAll(".stage").forEach((chip) => {
    const i = BATCH_STAGES.indexOf(chip.dataset.stage);
    chip.classList.toggle("stage--active", i === idx);
    chip.classList.toggle("stage--done", i < idx);
  });
  BATCH_STAGES.forEach((s) => {
    document.getElementById(`bstage-${s}`).hidden = s !== stage;
  });
  const recvBar = document.getElementById("recv-bar");
  if (recvBar) recvBar.hidden = !isReceivingBatch();
  bEl.toLabels.hidden = isReceivingBatch();
  bEl.toVerify.hidden = isReceivingBatch();
  if (stage === "collect") {
    renderBatchItems();
    bEl.scan.focus();
  } else if (stage === "labels") {
    loadBatchReview();
  } else if (stage === "print") {
    pollBatchPrint();
    batchPrintTimer = setInterval(pollBatchPrint, 3000);
  } else if (stage === "pair") {
    renderPairItems();
    renderPairCard();
    bEl.pairInput.focus();
  } else if (stage === "verify") {
    verifyEpcs = new Set();
    bEl.verifyCount.textContent = "0 unique tags collected.";
    bEl.verifyReport.innerHTML = "";
    bEl.verifyInput.focus();
  }
  publishBatchStep(stage);
}

function stopBatchPrintPoll() {
  if (batchPrintTimer) {
    clearInterval(batchPrintTimer);
    batchPrintTimer = null;
  }
}

document.getElementById("batch-refresh").addEventListener("click", refreshBatch);

// Leave the batch open and go back to the bin list — the batch keeps its
// counts and can be resumed from any device.
document.getElementById("batch-switch").addEventListener("click", () => {
  batch = null;
  batchItems = [];
  checkEntries = [];
  ignoredBinItems = new Set();
  stopBatchPrintPoll();
  stopBatchLive();
  enterBatchTab();
  setBatchResult("Batch left open — pick it up any time.", "ok");
});

bEl.abandon.addEventListener("click", async () => {
  if (!batch) return;
  const ties = batchItems.reduce((n, i) => n + (i.paired_count || 0), 0);
  const msg = ties
    ? `Abandon the batch for bin ${batch.bin_name}?\n\n${ties} tag(s) were ` +
      `paired in this batch — those ties will be REMOVED so the products ` +
      `aren't left tied to unverified labels. Counts stay in History.`
    : `Abandon the batch for bin ${batch.bin_name}? Collected counts are ` +
      `kept in History but the batch closes.`;
  if (!confirm(msg)) return;
  try {
    const res = await postJson(`/api/batches/${batch.id}/abandon`, {
      remove_ties: true,
    });
    if (res.ties_removed)
      setBatchResult(`Batch abandoned — ${res.ties_removed} tie(s) released.`, "ok");
  } catch (err) {
    /* already closed is fine */
  }
  batch = null;
  batchItems = [];
  checkEntries = [];
  ignoredBinItems = new Set();
  stopBatchPrintPoll();
  stopBatchLive();
  enterBatchTab();
});

// Scan sounds, mirroring the C72: ding = expected product ticked up,
// double-ding = real product that wasn't expected in this bin, buzz =
// unknown barcode or failure. WebAudio spins up lazily — the scan
// keystroke itself is the user gesture browsers require.
let audioCtx = null;

function batchSound(kind) {
  try {
    audioCtx =
      audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const tone = (freq, at, dur, type = "sine", vol = 0.25) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const t = audioCtx.currentTime + at;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    };
    if (kind === "ok") {
      tone(880, 0, 0.14);
    } else if (kind === "other") {
      tone(660, 0, 0.09);
      tone(990, 0.11, 0.12);
    } else {
      tone(170, 0, 0.28, "square", 0.18);
    }
  } catch (err) {
    /* sound is best-effort */
  }
}

// One card renderer for collect and pair lists — the C72 view is the
// design reference (image | bold name + labeled lines, tracker top-right).
// --- multi-box products vs bundles ------------------------------------------
// Two listings can fill the same several box slots for opposite reasons: one
// product shipped in three cartons, or a bundle whose "boxes" are really
// separate products with their own listings and their own tags. The server
// guesses from the catalog's own convention ("BUNDLE: ...", SKU "91519+93973")
// and the operator corrects it here, holding the actual box.
const BIN_SPLIT_RE = /\s*(?:[&,;/+]|\band\b)\s*/i;

function boxSlots(item) {
  const count = (v) =>
    String(v || "")
      .split(BIN_SPLIT_RE)
      .map((p) => p.trim())
      .filter(Boolean).length;
  // Scanned rows carry the whole metafield in bin_location; seeded rows carry
  // only this shelf, with the rest in other_bins. Whichever says "more".
  return Math.max(count(item.bin_location), 1 + count(item.other_bins));
}

// Spell the "2 + 8x1" shorthand out in words, for the hover hint.
function caseHint(p) {
  const parts = String(p.unit_breakdown || "").split(" + ");
  const loose = parts.shift();
  const cases = parts
    .map((seg) => {
      const [units, n] = seg.split("x");
      return `${n} box${n === "1" ? "" : "es"} of ${units}`;
    })
    .join(", ");
  return (
    `${p.unit_count} units on the shelf: ${loose} on their own, plus ` +
    `${cases}. Shopify counts ${p.unit_count}.`
  );
}

// "2 + 8x1" — loose units, then units-per-case times cases. Null unless a
// sealed case is involved, because otherwise the total says it all.
function unitBreakdown(item) {
  if (!item || !item.case_count || !item.case_units) return null;
  return `${item.qty_scanned} + ${item.case_units}x${item.case_count}`;
}

function itemCard(item, mode) {
  const li = document.createElement("li");
  li.className = "bcell";
  if (item.skipped) li.classList.add("bcell--skipped");
  if (!item.resolved) li.classList.add("bcell--warn");
  if (mode === "pair") {
    if (item.id === pairActiveItemId) li.classList.add("bcell--active");
    if (item.qty_scanned > 0 && item.paired_count >= item.qty_scanned)
      li.classList.add("bcell--exact");
  } else if (item.expected_qty != null) {
    // Compare UNITS to Shopify's on-hand — a sealed case is one box but
    // several units, so boxes would read short.
    const units = item.units_total != null ? item.units_total : item.qty_scanned;
    if (units === item.expected_qty && units > 0)
      li.classList.add("bcell--exact");
    else if (units > item.expected_qty) li.classList.add("bcell--over");
  }
  const units = item.units_total != null ? item.units_total : item.qty_scanned;
  const labels = item.labels_total != null ? item.labels_total : item.qty_scanned;
  const tracker =
    mode === "pair"
      ? `${item.paired_count}/${Math.max(labels, item.paired_count)}`
      : item.expected_qty != null
        ? `${units}/${item.expected_qty}`
        : `${units}`;
  const barcode = item.barcode || item.scanned_code;
  li.innerHTML = `
    ${
      item.image_url
        ? `<img class="bcell__img" src="${escapeHtml(item.image_url)}" alt="" loading="lazy" />`
        : `<span class="bcell__img bcell__img--empty"></span>`
    }
    <div class="bcell__info">
      <div class="bcell__name">${escapeHtml(itemDisplayName(item))}</div>
      <div class="bcell__meta">${
        item.sku
          ? "SKU: " + escapeHtml(item.sku)
          : item.resolved
            ? "no SKU"
            : "⚠ unknown barcode"
      }</div>
      ${barcode ? `<div class="bcell__meta">Barcode: ${escapeHtml(barcode)}</div>` : ""}
      ${
        item.skipped
          ? `<div class="bcell__meta bcell__skipped">⊘ Skipped${
              item.skip_reason ? " — " + escapeHtml(item.skip_reason) : ""
            } · no label, nothing counted</div>`
          : ""
      }
      ${
        item.tagged_before
          ? `<div class="bcell__meta bcell__done">✓ ${item.tagged_before} already tagged — no labels will print for those</div>`
          : ""
      }
      ${
        unitBreakdown(item)
          ? `<div class="bcell__meta bcell__cases" title="${escapeHtml(
              `${item.qty_scanned} loose box(es) plus ${item.case_count} sealed case(s) of ${item.case_units} — ${item.labels_total} label(s) in total`
            )}">${escapeHtml(unitBreakdown(item))} — ${item.labels_total} label(s)</div>`
          : ""
      }
      ${
        item.other_bins
          ? `<div class="bcell__meta bcell__split">${
              item.kind === "bundle"
                ? `Components on ${escapeHtml(item.other_bins)} — a bundle, not a box of its own`
                : `Also on ${escapeHtml(item.other_bins)} — ${
                    item.kind === "multi_box"
                      ? `ships as ${boxSlots(item)} boxes`
                      : "this item is split across shelves"
                  }`
            }</div>`
          : ""
      }
    </div>
    <span class="bcell__tracker">${tracker}</span>`;
  return li;
}

// Stage chips are navigation: click any chip to jump to that step (going
// back to fix something is the whole point).
bEl.stages.querySelectorAll(".stage").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (!batch) return;
    showBatchStage(chip.dataset.stage);
  });
});

// --- Stage 1: collect -------------------------------------------------------
bEl.scan.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const code = bEl.scan.value.trim();
  bEl.scan.value = "";
  if (!code || !batch) return;
  setBatchResult("Looking up…", "busy");
  try {
    let data = await postJson(`/api/batches/${batch.id}/scan`, { code });
    // A case code pauses the scan to ask one question, because opening the
    // box or not changes the count, the labels and the tags.
    if (data.needs_case_decision) {
      batchSound("other");
      const c = data.case;
      const opened = confirm(
        `${c.barcode} is a box of ${c.units} × ${c.sku}\n` +
          `${c.product_title || ""}\n` +
          (c.scan_note ? `\n⚠ ${c.scan_note}\n` : "") +
          `\nAre you opening it?\n\n` +
          `OK  — opened: counts ${c.units} units and prints ${c.units} labels.\n` +
          `Cancel — left sealed: counts ${c.units} units but prints ONE ` +
          `label reading "${c.units} x ${c.sku}".`
      );
      data = await postJson(`/api/batches/${batch.id}/scan`, {
        code,
        case_action: opened ? "open" : "sealed",
      });
    }
    const item = data.item;
    const existing = batchItems.findIndex((i) => i.id === item.id);
    const wasListed = existing >= 0;
    if (existing >= 0) batchItems.splice(existing, 1);
    // Freshly scanned floats to the top — big bins pre-seed a long list
    // and the row you just ticked should stay in view.
    batchItems.unshift(item);
    if (data.bin_mismatch) item._binMismatch = true;
    renderBatchItems();
    batchSound(!item.resolved ? "err" : wasListed ? "ok" : "other");
    if (!item.resolved) {
      setBatchResult(
        `"${code}" isn't in the system — kept in the count as unresolved. ` +
          `Link it later at the Scan Station.`,
        "err"
      );
    } else if (data.serial_note) {
      setBatchResult(
        `⚠ ${data.serial_note} — ${itemDisplayName(item)}: ${item.qty_scanned} scanned.`,
        "err"
      );
    } else if (data.case) {
      // Say both numbers: a case makes units and labels diverge.
      setBatchResult(
        (data.case.scan_note ? `⚠ ${data.case.scan_note} — ` : "") +
          `${itemDisplayName(item)} — ${item.units_total} unit(s)` +
          (unitBreakdown(item) ? ` (${unitBreakdown(item)})` : "") +
          `, ${item.labels_total} label(s)` +
          (data.case_action === "sealed" ? " — box left sealed." : "."),
        data.case.scan_note ? "err" : "ok"
      );
    } else {
      setBatchResult(
        `${itemDisplayName(item)} — ${item.qty_scanned} scanned` +
          (item.expected_qty != null
            ? ` (Shopify on-hand ${item.expected_qty})`
            : ""),
        "ok"
      );
    }
    // Receiving: say when the box in hand sits on an open PO. The hint
    // clears on every scan so it always describes the LAST product.
    document.getElementById("batch-planner-hint").hidden = true;
    if (item.resolved && isReceivingBatch())
      showPlannerHint(item.sku, "batch-planner-hint");
  } catch (err) {
    batchSound("err");
    setBatchResult(err.message, "err");
  }
  bEl.scan.focus();
});

function renderBatchItems() {
  const summary = document.getElementById("bcollect-summary");
  const expected = batchItems.filter((i) => i.expected_qty != null);
  if (expected.length) {
    const started = expected.filter(
      (i) => i.qty_scanned > 0 || i.tagged_before > 0
    ).length;
    const boxes = batchItems.reduce((n, i) => n + i.qty_scanned, 0);
    const tagged = batchItems.reduce(
      (n, i) => n + (i.tagged_before || 0), 0
    );
    summary.textContent =
      `${started} of ${expected.length} expected products scanned · ` +
      `${boxes} box(es) total` +
      (tagged ? ` · ${tagged} already tagged (baseline)` : "");
    summary.hidden = false;
  } else {
    summary.hidden = true;
  }
  bEl.items.innerHTML = "";
  batchItems.forEach((item) => {
    const li = itemCard(item, "collect");
    const qty = document.createElement("span");
    qty.className = "bqty";
    qty.innerHTML = `
      <button type="button" data-d="-1">−</button>
      <span class="bqty__n">${item.qty_scanned}</span>
      <button type="button" data-d="1">+</button>`;
    qty.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () =>
        adjustItemQty(item, item.qty_scanned + Number(btn.dataset.d))
      )
    );
    li.append(qty);
    if (item._binMismatch) {
      const warn = document.createElement("div");
      warn.className = "binwarn";
      warn.innerHTML = `
        <span>Saved bin is <b>${escapeHtml(item.bin_location || "?")}</b>, not ${escapeHtml(batch.bin_name)}.</span>
        <button class="reset" type="button" data-act="keep">Keep saved bin</button>
        <button class="reset" type="button" data-act="move">Move product to ${escapeHtml(batch.bin_name)} (Shopify)</button>`;
      warn.querySelector('[data-act="keep"]').addEventListener("click", () => {
        item._binMismatch = false;
        renderBatchItems();
      });
      warn.querySelector('[data-act="move"]').addEventListener("click", () =>
        moveItemBin(item)
      );
      li.append(warn);
      li.classList.add("bcell--stacked");
    }
    // Anything filling more than one box slot needs an answer before labels
    // print, and only the person holding the box can give it.
    if (item.resolved && item.other_bins) {
      li.append(kindRow(item));
      // The card is nowrap by default; without this the row lands beside the
      // name instead of under it.
      li.classList.add("bcell--stacked");
    }
    bEl.items.append(li);
  });
}

function kindRow(item) {
  const bundle = item.kind === "bundle";
  const row = document.createElement("div");
  row.className = "kindrow" + (bundle ? " kindrow--bundle" : "");
  const n = boxSlots(item);
  row.innerHTML = `
    <span class="kindrow__what">${
      bundle
        ? "Bundle — made of separate products, so nothing here gets a tag"
        : `Multi-box product — ${n} boxes, one label each`
    }</span>
    <button class="reset" type="button" data-act="toggle">${
      bundle ? "No — it's one product in " + n + " boxes" : "No — it's a bundle"
    }</button>
    ${
      bundle
        ? `<button class="reset" type="button" data-act="drop">Drop from RFID entirely</button>`
        : ""
    }`;
  row.querySelector('[data-act="toggle"]').addEventListener("click", () =>
    setItemKind(item, bundle ? "multi_box" : "bundle", false)
  );
  const drop = row.querySelector('[data-act="drop"]');
  if (drop) {
    drop.addEventListener("click", () => {
      if (
        !confirm(
          `Drop "${itemDisplayName(item)}" from the RFID system?\n\n` +
            `It won't be added to future batches and will never be ` +
            `labelled. Its component products are unaffected — they keep ` +
            `their own tags.\n\nYou can undo this from the product's panel ` +
            `in History.`
        )
      )
        return;
      setItemKind(item, "bundle", true);
    });
  }
  return row;
}

async function setItemKind(item, kind, excluded) {
  try {
    const data = await postJson(
      `/api/batches/${batch.id}/items/${item.id}/kind`,
      // Blank is fine — the server falls back to whoever started the batch.
      { kind, excluded, updated_by: operatorEl.value.trim() || null }
    );
    setBatchResult(data.message, "ok");
    await pullBatch(false);
  } catch (err) {
    setBatchResult(err.message, "err");
  }
  bEl.scan.focus();
}

async function adjustItemQty(item, qty) {
  qty = Math.max(0, qty);
  try {
    const updated = await postJson(
      `/api/batches/${batch.id}/items/${item.id}/qty`,
      { qty }
    );
    Object.assign(item, updated);
    renderBatchItems();
  } catch (err) {
    setBatchResult(err.message, "err");
  }
  bEl.scan.focus();
}

// The one Shopify write reachable from a batch — the existing, confirmed
// Scan Station bin update, re-used verbatim.
async function moveItemBin(item) {
  if (
    !confirm(
      `Update the bin on "${item.product_title}" in Shopify: ` +
        `${item.bin_location || "(none)"} → ${batch.bin_name}?`
    )
  )
    return;
  try {
    await postJson("/api/bin-updates", {
      target: item.sku || item.barcode,
      bin: batch.bin_name,
      changed_by: operatorEl.value || null,
    });
    item.bin_location = batch.bin_name;
    item._binMismatch = false;
    renderBatchItems();
    setBatchResult(`Bin updated to ${batch.bin_name} in Shopify.`, "ok");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
}

bEl.toLabels.addEventListener("click", () => {
  if (!labelItems().length) {
    setBatchResult("Nothing scanned yet — scan at least one known product.", "err");
    return;
  }
  showBatchStage("labels");
});

// --- Stage 2: check ---------------------------------------------------------
// Only items needing a human decision appear here (server decides why);
// everything else sails straight through to label queueing.
function labelItems() {
  return batchItems.filter((i) => i.resolved && i.qty_scanned > 0);
}

const FLAG_TEXT = {
  skipped: "skipped — couldn't be scanned, nothing counted",
  "tagged-not-detected":
    "tags on file for this shelf, but the sweep read none — find the " +
    "tagged box(es) before printing more",
  bundle: "a bundle — no box of its own to tag",
  "not-on-shelf":
    "Shopify expects this here, but none was scanned — it's in another " +
    "bin or the count is wrong",
  ambiguous: "barcode matches several listings",
  "count-mismatch": "count differs from Shopify",
  "unconfirmed-name": "serial name not confirmed",
  unresolved: "unknown barcode",
  "wrong-bin": "saved bin is a different shelf",
  "double-count":
    "boxes scanned AND marked already-tagged — if the stickered boxes " +
    "were among the scans, lower the scan count (−/+ in the editor)",
};

let checkEntries = [];
let bitemEntry = null;
let bitemIdx = 0;
// Wrong-bin warnings the operator chose to ignore for this batch only.
let ignoredBinItems = new Set();
// Odd-barcode rescue state (unresolved scans).
let oddList = [];
let oddIdx = 0;
let bitemLabelMode = "header";

// --- Side trips ------------------------------------------------------------
// Boxes found on the wrong shelf, caught at Check before anything prints.
// Rather than rewriting the product's bin, carry them to where the rest of
// that product already lives: a small batch for THAT bin, whose labels — and
// so whose tags — name the right shelf. Nothing to reprint or peel off.
let parentBatch = null;

function renderStrayBins(bins) {
  const wrap = document.getElementById("bcheck-strays");
  wrap.innerHTML = "";
  // A side trip can't start from inside a side trip; finish this one first.
  if (!bins.length || (batch && batch.parent_batch_id)) return;
  bins.forEach((b) => {
    const row = document.createElement("div");
    row.className = "kindrow";
    row.innerHTML = `
      <span class="kindrow__what">${b.count} product(s) here actually live in
        <b>${escapeHtml(b.bin)}</b> — ${escapeHtml(b.skus.filter(Boolean).join(", "))}</span>
      <button class="reset" type="button">Take them to ${escapeHtml(b.bin)}…</button>`;
    row.querySelector("button").addEventListener("click", () => divertToBin(b.bin));
    wrap.append(row);
  });
}

async function divertToBin(binName) {
  if (
    !confirm(
      `Carry these boxes to ${binName}?\n\n` +
        `They leave this batch and become a short side trip for ${binName}: ` +
        `their labels print with ${binName} on them, you pair them there, ` +
        `then you're back here.\n\n` +
        `Nothing has printed yet, so there's nothing to reprint or peel off.`
    )
  )
    return;
  try {
    const res = await postJson(`/api/batches/${batch.id}/divert`, {
      bin: binName,
      created_by: operatorEl.value.trim() || null,
    });
    parentBatch = res.parent;
    batch = res.batch;
    batchItems = [];
    await pullBatch(false);
    renderSideTrip();
    showBatchStage("pair");
    setBatchResult(res.message, "ok");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
}

function renderSideTrip() {
  const bar = document.getElementById("batch-sidetrip");
  const on = !!(batch && batch.parent_batch_id);
  bar.hidden = !on;
  if (!on) return;
  // The parent's stray offer is still sitting in the DOM; leaving it there
  // would invite a side trip from inside a side trip.
  document.getElementById("bcheck-strays").innerHTML = "";
  document.getElementById("sidetrip-what").textContent =
    `Side trip — tagging strays into ${batch.bin_name}` +
    (parentBatch ? `, then back to ${parentBatch.bin_name}` : "") +
    `. These labels say ${batch.bin_name}.`;
}

document
  .getElementById("sidetrip-finish")
  .addEventListener("click", async () => {
    const left = batchItems.filter(
      (i) => i.resolved && i.paired_count < (i.labels_total ?? i.qty_scanned)
    );
    if (
      left.length &&
      !confirm(
        `${left.length} product(s) here still have labels waiting to be ` +
          `paired.\n\nClose the side trip anyway?`
      )
    )
      return;
    try {
      const res = await postJson(`/api/batches/${batch.id}/close-divert`, {});
      if (res.parent) {
        batch = res.parent;
        batchItems = [];
        parentBatch = null;
        await pullBatch(false);
        renderSideTrip();
        showBatchStage("labels");
        loadBatchReview();
      }
      setBatchResult(res.message, "ok");
    } catch (err) {
      setBatchResult(err.message, "err");
    }
  });

async function loadBatchReview(showAll) {
  const list = document.getElementById("bcheck-list");
  const empty = document.getElementById("bcheck-empty");
  empty.hidden = true;
  list.innerHTML = '<li class="recent__empty">Checking the batch…</li>';
  try {
    const data = await apiJson(`/api/batches/${batch.id}/review`);
    renderStrayBins(data.stray_bins || []);
    checkEntries = data.items
      .map((e) => ({
        ...e,
        flags: e.flags.filter(
          (f) => !(f === "wrong-bin" && ignoredBinItems.has(e.item.id))
        ),
      }))
      .filter((e) => e.flags.length);
    if (showAll) {
      // "Review all products": every scanned product, flagged or not, so
      // label names/SKUs can be edited before printing.
      const flagged = new Map(checkEntries.map((e) => [e.item.id, e]));
      checkEntries = labelItems().map(
        (item) =>
          flagged.get(item.id) || { item, flags: [], candidates: [] }
      );
    }
    renderCheckList();
  } catch (err) {
    list.innerHTML = `<li class="recent__empty">${escapeHtml(err.message)}</li>`;
  }
}

// Draw the Check list from what's already loaded. Kept apart from the fetch
// because re-checking is expensive — it asks Shopify about every item — and
// closing an edit window is no reason to pay for it. The ↻ button does that.
function renderCheckList() {
  const list = document.getElementById("bcheck-list");
  const empty = document.getElementById("bcheck-empty");
  // Only offer the bulk re-check when there's something unknown to re-check.
  document.getElementById("bcheck-recheck").hidden = !checkEntries.some(
    (e) => !e.item.resolved
  );
  list.innerHTML = "";
  empty.hidden = checkEntries.length > 0;
  if (!checkEntries.length) return;
  checkEntries.forEach((entry) => {
    const li = itemCard(entry.item, "collect");
    if (entry.flags.length) {
      const flags = document.createElement("div");
      flags.className = "bcell__meta bcell__flags";
      flags.textContent =
        "⚠ " + entry.flags.map((f) => FLAG_TEXT[f] || f).join(" · ");
      li.querySelector(".bcell__info").append(flags);
    }
    li.style.cursor = "pointer";
    li.addEventListener("click", () => openBitem(entry));
    list.append(li);
  });
}

// --- Check-item editor (candidates arrows, counts, serial name) -------------
function openBitem(entry) {
  bitemEntry = entry;
  const cands = entry.candidates || [];
  bitemIdx = Math.max(
    0,
    cands.findIndex(
      (c) => c.shopify_variant_id === entry.item.shopify_variant_id
    )
  );
  document.getElementById("bitem-msg").textContent = "";
  document.getElementById("bitem-overlay").hidden = false;
  renderBitem();
}

function renderBitem() {
  const it = bitemEntry.item;
  const cands = bitemEntry.candidates || [];
  const multi = cands.length > 1;
  const showing = multi ? cands[bitemIdx] : it;
  document.getElementById("bitem-title").textContent =
    (showing.product_title || "(unknown)") +
    (showing.variant_title ? ` (${showing.variant_title})` : "");
  document.getElementById("bitem-meta").textContent =
    `SKU: ${showing.sku || "—"} · Barcode: ${showing.barcode || it.scanned_code || "—"}` +
    ` · Bin: ${showing.bin_location || "—"}`;
  const img = document.getElementById("bitem-img");
  const imgUrl = showing.image_url || (showing === it ? it.image_url : null);
  if (imgUrl) {
    img.src = imgUrl;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  document.getElementById("bitem-flags").textContent =
    "⚠ " + bitemEntry.flags.map((f) => FLAG_TEXT[f] || f).join(" · ");

  const prev = document.getElementById("bitem-prev");
  const next = document.getElementById("bitem-next");
  prev.style.visibility = multi ? "visible" : "hidden";
  next.style.visibility = multi ? "visible" : "hidden";
  prev.disabled = bitemIdx === 0;
  next.disabled = bitemIdx >= cands.length - 1;
  const pos = document.getElementById("bitem-candpos");
  pos.hidden = !multi;
  if (multi) {
    const current =
      cands[bitemIdx].shopify_variant_id === it.shopify_variant_id;
    pos.textContent =
      `Listing ${bitemIdx + 1} of ${cands.length} sharing this barcode` +
      (current ? " — currently selected" : "");
    const useWrap = document.getElementById("bitem-usewrap");
    useWrap.hidden = false;
    document.getElementById("bitem-use").disabled = current;
    // Splitting needs at least two boxes to divide and no tags yet — the
    // server refuses both anyway, but a button that can only fail is worse
    // than no button.
    document.getElementById("bitem-split").hidden =
      it.qty_scanned < 2 || it.paired_count > 0;
  } else {
    document.getElementById("bitem-usewrap").hidden = true;
  }
  document.getElementById("bitem-splitwrap").hidden = true;

  const nameWrap = document.getElementById("bitem-namewrap");
  nameWrap.hidden = !bitemEntry.flags.includes("unconfirmed-name");
  if (!nameWrap.hidden) {
    document.getElementById("bitem-name").value = it.label_name || "";
  }

  // Wrong shelf: saved bin differs from the bin being walked.
  const binWarn = document.getElementById("bitem-binwarn");
  binWarn.hidden = !bitemEntry.flags.includes("wrong-bin");
  if (!binWarn.hidden) {
    document.getElementById("bitem-bintext").innerHTML =
      `Found here in <b>${escapeHtml(batch.bin_name)}</b>, but the system ` +
      `has it in <b>${escapeHtml(it.bin_location || "?")}</b>.`;
  }

  // Unresolved barcode rescue.
  const unres = document.getElementById("bitem-unresolved");
  unres.hidden = it.resolved;
  if (!unres.hidden) {
    document.getElementById("bitem-oddwrap").hidden = true;
  }

  // Bundle: flagged here so the call gets made before labels print.
  const bundleWrap = document.getElementById("bitem-bundlewrap");
  bundleWrap.hidden = it.kind !== "bundle";

  // Label format editor — every resolved product gets one.
  const labelWrap = document.getElementById("bitem-labelwrap");
  labelWrap.hidden = !it.resolved;
  if (it.resolved) {
    bitemLabelMode = it._labelPlacement || "header";
    document.getElementById("bitem-labeltext").value = it._labelText || "";
    updateBitemLabelMode();
  }

  document.getElementById("bitem-qty").textContent = it.qty_scanned;
  document.getElementById("bitem-expected").textContent =
    it.expected_qty != null
      ? `boxes scanned · Shopify on-hand ${it.expected_qty}`
      : "boxes scanned";
  // Reprinting one product's labels only makes sense once it resolved.
  document.getElementById("bitem-refreshwrap").hidden = !it.resolved;
  // A bundle has no box to put a label on, and the server refuses the
  // print — so don't offer a button that can only fail.
  document.getElementById("bitem-printwrap").hidden =
    !it.resolved || it.kind === "bundle";
  document.getElementById("bitem-printqty").value = 1;
}

// --- label format (Change Name / Change SKU / Change Both) ------------------
const BITEM_MODES = ["header", "sku", "both"];
const BITEM_MODE_TEXT = {
  header: "Change Name",
  sku: "Change SKU",
  both: "Change Both",
};

function updateBitemLabelMode() {
  document.getElementById("bitem-labelmode").textContent =
    BITEM_MODE_TEXT[bitemLabelMode];
  const it = bitemEntry ? bitemEntry.item : {};
  const typed = document.getElementById("bitem-labeltext").value.trim();
  const asHeader = typed && (bitemLabelMode === "header" || bitemLabelMode === "both");
  const asSku = typed && (bitemLabelMode === "sku" || bitemLabelMode === "both");
  const header = asHeader ? typed : "Telescopes Canada";
  const el = document.getElementById("bitem-prev-header");
  el.textContent = header;
  el.className =
    "label-preview__header " +
    (!asHeader || header.length <= 26
      ? "label-preview__header--lg"
      : header.length <= 56
        ? "label-preview__header--md"
        : "label-preview__header--sm");
  document.getElementById("bitem-prev-sku").textContent = asSku
    ? typed
    : it.sku || "";
  document.getElementById("bitem-prev-bc").textContent =
    it.barcode || it.sku || "";
  document.getElementById("bitem-prev-bin").textContent =
    "BIN: " + (batch ? batch.bin_name : "—");
}

document.getElementById("bitem-labelmode").addEventListener("click", () => {
  bitemLabelMode =
    BITEM_MODES[(BITEM_MODES.indexOf(bitemLabelMode) + 1) % BITEM_MODES.length];
  updateBitemLabelMode();
});
document
  .getElementById("bitem-labeltext")
  .addEventListener("input", updateBitemLabelMode);
document.getElementById("bitem-labelclear").addEventListener("click", () => {
  document.getElementById("bitem-labeltext").value = "";
  updateBitemLabelMode();
  document.getElementById("bitem-labelsave").click();
});

document.getElementById("bitem-labelsave").addEventListener("click", async () => {
  const it = bitemEntry.item;
  const msg = document.getElementById("bitem-msg");
  if (!it.sku) {
    msg.textContent = "This product has no SKU to attach a label name to.";
    return;
  }
  const name = document.getElementById("bitem-labeltext").value.trim();
  try {
    await apiJson(`/api/label-names/${encodeURIComponent(it.sku)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label_name: name,
        placement: bitemLabelMode,
        updated_by: operatorEl.value || null,
      }),
    });
    it._labelText = name;
    it._labelPlacement = bitemLabelMode;
    msg.textContent = name
      ? `Saved ✓ — labels print this as the ${
          bitemLabelMode === "both"
            ? "name and SKU"
            : bitemLabelMode === "sku"
              ? "SKU line"
              : "name"
        }.`
      : "Cleared ✓ — standard label.";
  } catch (err) {
    msg.textContent = err.message;
  }
});

// --- wrong shelf: drop / move / ignore --------------------------------------
document.getElementById("bitem-binwarn").addEventListener("click", async (ev) => {
  const act = ev.target.dataset ? ev.target.dataset.act : null;
  if (!act || !bitemEntry) return;
  const it = bitemEntry.item;
  const msg = document.getElementById("bitem-msg");
  if (act === "ignore") {
    ignoredBinItems.add(it.id);
    document.getElementById("bitem-overlay").hidden = true;
    setBatchResult(
      "Ignored for this batch — it'll come up again next time.",
      "ok"
    );
    loadBatchReview();
    return;
  }
  if (act === "drop") {
    if (
      !confirm(
        `Drop ${it.product_title || it.sku} from this batch? ` +
          `Its ${it.qty_scanned} box(es) stop counting here and no labels ` +
          `print for it — take them to bin ${it.bin_location}.`
      )
    )
      return;
    try {
      await apiFetch(`/api/batches/${batch.id}/items/${it.id}`, {
        method: "DELETE",
      });
      document.getElementById("bitem-overlay").hidden = true;
      await pullBatch(false);
      loadBatchReview();
      setBatchResult("Dropped from this batch.", "ok");
    } catch (err) {
      msg.textContent = err.message;
    }
    return;
  }
  if (act === "move") {
    if (
      !confirm(
        `Update the bin on "${it.product_title}" in Shopify: ` +
          `${it.bin_location || "(none)"} → ${batch.bin_name}?`
      )
    )
      return;
    try {
      await postJson("/api/bin-updates", {
        target: it.sku || it.barcode,
        bin: batch.bin_name,
        changed_by: operatorEl.value || null,
      });
      it.bin_location = batch.bin_name;
      document.getElementById("bitem-overlay").hidden = true;
      await pullBatch(false);
      loadBatchReview();
      setBatchResult(`Bin updated to ${batch.bin_name} in Shopify.`, "ok");
    } catch (err) {
      msg.textContent = err.message;
    }
  }
});

// --- re-check against Shopify ----------------------------------------------
// The answer to "the product had no barcode, so I set one in Shopify — now
// what": ask the server to look the row up again instead of making the
// operator re-scan the boxes. Read-only; nothing is written to the store.
function recheckItem(item) {
  return apiJson(`/api/batches/${batch.id}/items/${item.id}/resolve`, {
    method: "POST",
  });
}

async function bitemRecheck() {
  const it = bitemEntry.item;
  const msg = document.getElementById("bitem-msg");
  msg.textContent = "Asking Shopify again…";
  try {
    const data = await recheckItem(it);
    if (!data.resolved) {
      msg.textContent = data.message;
      return;
    }
    // A plain refresh of an already-resolved product: stay put and show the
    // updated details. Anything structural (it just resolved, or it merged
    // into another row) changes the list, so close and let it reload.
    if (data.was_resolved && !data.merged) {
      bitemEntry.item = data.item;
      renderBitem();
      msg.textContent = data.message;
      await pullBatch(false);
      loadBatchReview();
      return;
    }
    document.getElementById("bitem-overlay").hidden = true;
    await pullBatch(false);
    loadBatchReview();
    setBatchResult(data.message, "ok");
  } catch (err) {
    msg.textContent = err.message;
  }
}

// Bundle decisions from the Check step. Both change the list (a bundle stops
// being labelled; a drop removes the row), so close the editor and reload.
async function bitemSetKind(kind, excluded) {
  await setItemKind(bitemEntry.item, kind, excluded);
  document.getElementById("bitem-overlay").hidden = true;
  loadBatchReview();
}

document.getElementById("bcheck-refresh").addEventListener("click", () => {
  loadBatchReview();
});

document
  .getElementById("bitem-kind-multi")
  .addEventListener("click", () => bitemSetKind("multi_box", false));

document.getElementById("bitem-kind-drop").addEventListener("click", () => {
  const it = bitemEntry.item;
  if (
    !confirm(
      `Drop "${itemDisplayName(it)}" from the RFID system?\n\n` +
        `It won't be added to future batches and will never be labelled. ` +
        `Its component products are unaffected — they keep their own tags.`
    )
  )
    return;
  bitemSetKind("bundle", true);
});

document
  .getElementById("bitem-recheck")
  .addEventListener("click", bitemRecheck);
document
  .getElementById("bitem-refresh")
  .addEventListener("click", bitemRecheck);

// Same thing for every unknown barcode at once — one at a time so a bin
// full of them doesn't fire twenty Shopify lookups in parallel.
document.getElementById("bcheck-recheck").addEventListener("click", async () => {
  const btn = document.getElementById("bcheck-recheck");
  const rows = checkEntries.filter((e) => !e.item.resolved).map((e) => e.item);
  if (!rows.length) return;
  const label = btn.textContent;
  btn.disabled = true;
  let fixed = 0;
  const stuck = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      btn.textContent = `Re-checking ${i + 1} of ${rows.length}…`;
      try {
        const data = await recheckItem(rows[i]);
        if (data.resolved) fixed += 1;
        else stuck.push(rows[i].scanned_code);
      } catch (err) {
        stuck.push(rows[i].scanned_code);
      }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
  await pullBatch(false);
  loadBatchReview();
  if (fixed && !stuck.length) {
    setBatchResult(`Re-checked ✓ — ${fixed} now resolved.`, "ok");
  } else if (fixed) {
    setBatchResult(
      `${fixed} now resolved ✓ — still unknown: ${stuck.join(", ")}.`,
      "ok"
    );
  } else {
    setBatchResult(
      `Still nothing in Shopify for ${stuck.join(", ")}. If you just ` +
        `changed a barcode there, give it a few seconds and try again.`,
      "err"
    );
  }
});

// --- unresolved barcode rescue ---------------------------------------------
function renderOdd() {
  const wrap = document.getElementById("bitem-oddwrap");
  if (!oddList.length) {
    wrap.hidden = true;
    document.getElementById("bitem-msg").textContent =
      "No products in this bin have an odd barcode.";
    return;
  }
  wrap.hidden = false;
  const p = oddList[oddIdx];
  document.getElementById("bitem-oddtitle").textContent =
    (p.product_title || "(unknown)") +
    (p.variant_title ? ` (${p.variant_title})` : "");
  document.getElementById("bitem-oddmeta").textContent =
    `SKU: ${p.sku || "—"} · current barcode: ${p.barcode || "(none)"} · ${p.reason}`;
  const img = document.getElementById("bitem-oddimg");
  if (p.image_url) {
    img.src = p.image_url;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  document.getElementById("bitem-oddpos").textContent =
    `Candidate ${oddIdx + 1} of ${oddList.length}`;
  const prev = document.getElementById("bitem-oddprev");
  const next = document.getElementById("bitem-oddnext");
  prev.style.visibility = oddList.length > 1 ? "visible" : "hidden";
  next.style.visibility = oddList.length > 1 ? "visible" : "hidden";
  prev.disabled = oddIdx === 0;
  next.disabled = oddIdx >= oddList.length - 1;
}

async function loadOdd(recommendedOnly) {
  const it = bitemEntry.item;
  const code = it.scanned_code;
  const msg = document.getElementById("bitem-msg");
  msg.textContent = "Looking through this bin…";
  try {
    const data = await apiJson(
      `/api/bins/${encodeURIComponent(batch.bin_name)}/odd-barcodes` +
        `?scanned=${encodeURIComponent(code)}`
    );
    if (recommendedOnly) {
      oddList = data.recommended ? [data.recommended] : [];
    } else {
      oddList = data.candidates;
    }
    oddIdx = 0;
    msg.textContent = "";
    renderOdd();
  } catch (err) {
    msg.textContent = err.message;
  }
}

document
  .getElementById("bitem-odd")
  .addEventListener("click", () => loadOdd(false));
document
  .getElementById("bitem-recommend")
  .addEventListener("click", () => loadOdd(true));
document.getElementById("bitem-oddprev").addEventListener("click", () => {
  if (oddIdx > 0) {
    oddIdx--;
    renderOdd();
  }
});
document.getElementById("bitem-oddnext").addEventListener("click", () => {
  if (oddIdx < oddList.length - 1) {
    oddIdx++;
    renderOdd();
  }
});

// Give the chosen product the barcode that wouldn't resolve. This is a real
// Shopify write — the same audited overwrite the Scan Station uses.
document.getElementById("bitem-oddapply").addEventListener("click", async () => {
  const p = oddList[oddIdx];
  const it = bitemEntry.item;
  const msg = document.getElementById("bitem-msg");
  if (!p) return;
  if (
    !confirm(
      `Are you absolutely sure?\n\n` +
        `"${p.product_title}"\n` +
        `barcode ${p.barcode || "(none)"} → ${it.scanned_code}\n\n` +
        `This changes the barcode in Shopify for real. Only do this if ` +
        `the box in your hand IS this product.`
    )
  )
    return;
  try {
    await postJson("/api/barcode-overwrites", {
      target: p.sku || p.barcode,
      new_barcode: it.scanned_code,
      changed_by: operatorEl.value || null,
      // The operator just answered "are you absolutely sure?" above; the
      // endpoint refuses to touch Shopify without this.
      confirmed: true,
    });
    // The unresolved row's count has to be re-scanned against the real
    // product, so take it out of the batch.
    await apiFetch(`/api/batches/${batch.id}/items/${it.id}`, {
      method: "DELETE",
    });
    document.getElementById("bitem-overlay").hidden = true;
    await pullBatch(false);
    loadBatchReview();
    setBatchResult(
      `Barcode updated in Shopify ✓ — now RE-SCAN those ` +
        `${it.qty_scanned} box(es); they'll come up as ${p.product_title}.`,
      "ok"
    );
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("bitem-drop").addEventListener("click", async () => {
  const it = bitemEntry.item;
  if (
    !confirm(
      `Remove this unresolved scan (${it.scanned_code}, ${it.qty_scanned} ` +
        `box(es)) from the list? Nothing permanent changes — scanning it ` +
        `again brings it back.`
    )
  )
    return;
  try {
    await apiFetch(`/api/batches/${batch.id}/items/${it.id}`, {
      method: "DELETE",
    });
    document.getElementById("bitem-overlay").hidden = true;
    await pullBatch(false);
    loadBatchReview();
    setBatchResult("Removed from the list.", "ok");
  } catch (err) {
    document.getElementById("bitem-msg").textContent = err.message;
  }
});

document.getElementById("bitem-prev").addEventListener("click", () => {
  if (bitemIdx > 0) {
    bitemIdx--;
    renderBitem();
  }
});
document.getElementById("bitem-next").addEventListener("click", () => {
  if (bitemIdx < (bitemEntry.candidates || []).length - 1) {
    bitemIdx++;
    renderBitem();
  }
});

// --- split one scanned pile between listings sharing a barcode -------------
// Two 94216 boxes, one regular and one open-box, same barcode: reassign
// moves ALL of them, so there was no honest way to say "one of each". The
// form gives every candidate a count; Split stays locked until the counts
// add up to exactly what was scanned, so a box can't vanish or duplicate.
function openSplitForm() {
  const it = bitemEntry.item;
  const cands = bitemEntry.candidates || [];
  const wrap = document.getElementById("bitem-splitwrap");
  const rows = document.getElementById("bitem-split-rows");
  document.getElementById("bitem-split-title").textContent =
    `Divide the ${it.qty_scanned} scanned box(es) between these listings:`;
  rows.innerHTML = "";
  cands.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "linkbox__form";
    row.style.marginBottom = "6px";
    // The row it's currently sitting on starts with the full count; the
    // operator moves boxes off it.
    const startQty =
      c.shopify_variant_id === it.shopify_variant_id ? it.qty_scanned : 0;
    row.innerHTML = `
      <input type="number" class="linkbox__input bitem-split-qty" min="0"
             max="${it.qty_scanned}" value="${startQty}"
             data-variant="${escapeHtml(c.shopify_variant_id)}"
             style="max-width:70px" />
      <span class="linkbox__text">${escapeHtml(
        c.product_title || c.sku || "?"
      )}${c.sku ? ` · ${escapeHtml(c.sku)}` : ""}</span>`;
    rows.append(row);
  });
  const refresh = () => {
    const total = [...rows.querySelectorAll(".bitem-split-qty")].reduce(
      (n, inp) => n + (Number(inp.value) || 0),
      0
    );
    const ok = total === it.qty_scanned;
    document.getElementById("bitem-split-count").textContent = ok
      ? `${total} of ${it.qty_scanned} assigned ✓`
      : `${total} of ${it.qty_scanned} assigned — every box needs a home`;
    document.getElementById("bitem-split-go").disabled = !ok;
  };
  rows.querySelectorAll(".bitem-split-qty").forEach((inp) =>
    inp.addEventListener("input", refresh)
  );
  refresh();
  wrap.hidden = false;
}

document
  .getElementById("bitem-split")
  .addEventListener("click", openSplitForm);
document
  .getElementById("bitem-split-cancel")
  .addEventListener("click", () => {
    document.getElementById("bitem-splitwrap").hidden = true;
  });

document
  .getElementById("bitem-split-go")
  .addEventListener("click", async () => {
    const msg = document.getElementById("bitem-msg");
    const parts = [
      ...document.querySelectorAll("#bitem-split-rows .bitem-split-qty"),
    ].map((inp) => ({
      shopify_variant_id: inp.dataset.variant,
      qty: Number(inp.value) || 0,
    }));
    try {
      const data = await postJson(
        `/api/batches/${batch.id}/items/${bitemEntry.item.id}/split`,
        { parts }
      );
      batchSound("ok");
      document.getElementById("bitem-overlay").hidden = true;
      setBatchResult(data.message, "ok");
      await pullBatch(false);
      loadBatchReview();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

document.getElementById("bitem-use").addEventListener("click", async () => {
  const cand = bitemEntry.candidates[bitemIdx];
  const msg = document.getElementById("bitem-msg");
  try {
    const data = await apiJson(
      `/api/batches/${batch.id}/items/${bitemEntry.item.id}/reassign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopify_variant_id: cand.shopify_variant_id }),
      }
    );
    batchSound("ok");
    document.getElementById("bitem-overlay").hidden = true;
    setBatchResult(
      (data.merged ? "Merged into the existing row for " : "Reassigned to ") +
        (data.item.product_title || data.item.sku) +
        ".",
      "ok"
    );
    await pullBatch(false);
    loadBatchReview();
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("bitem-name-save").addEventListener("click", async () => {
  const it = bitemEntry.item;
  const name = document.getElementById("bitem-name").value.trim();
  const msg = document.getElementById("bitem-msg");
  if (!name || !it.serial_prefix) return;
  try {
    await apiJson(
      `/api/serial-prefixes/${encodeURIComponent(it.serial_prefix)}/label`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label_name: name }),
      }
    );
    it.label_name = name;
    msg.textContent = "Name confirmed ✓";
  } catch (err) {
    msg.textContent = err.message;
  }
});

async function bitemAdjust(delta) {
  const it = bitemEntry.item;
  const qty = Math.max(0, it.qty_scanned + delta);
  try {
    const updated = await postJson(
      `/api/batches/${batch.id}/items/${it.id}/qty`,
      { qty }
    );
    Object.assign(it, updated);
    const inList = batchItems.find((i) => i.id === it.id);
    if (inList) Object.assign(inList, updated);
    renderBitem();
  } catch (err) {
    document.getElementById("bitem-msg").textContent = err.message;
  }
}
document.getElementById("bitem-minus").addEventListener("click", () => bitemAdjust(-1));
document.getElementById("bitem-plus").addEventListener("click", () => bitemAdjust(1));

document.getElementById("bcheck-all").addEventListener("click", () =>
  loadBatchReview(true)
);

// Labels already printed? Jump to pairing without queueing a second run.
document.getElementById("batch-skip-print").addEventListener("click", async () => {
  if (!batch) return;
  if (
    !confirm(
      `Skip printing for bin ${batch.bin_name} and go straight to pairing?` +
        `\n\nUse this when the labels are already printed and applied.`
    )
  )
    return;
  try {
    const b = await postJson(`/api/batches/${batch.id}/skip-print`, {});
    batch.status = b.status;
    showBatchStage("pair");
    setBatchResult("Straight to pairing — no labels queued.", "ok");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

// Print labels for just this product — a damaged sticker shouldn't mean
// reprinting the whole bin.
document.getElementById("bitem-print").addEventListener("click", async () => {
  const it = bitemEntry.item;
  const msg = document.getElementById("bitem-msg");
  const btn = document.getElementById("bitem-print");
  const qty = Math.max(
    1,
    Math.min(50, Number(document.getElementById("bitem-printqty").value) || 1)
  );
  if (
    !confirm(
      `Print ${qty} label(s) for ${it.product_title || it.sku}?\n\n` +
        `They join the print queue with the rest — the other products in ` +
        `this bin aren't reprinted.`
    )
  )
    return;
  btn.disabled = true;
  msg.textContent = "Queueing…";
  try {
    const res = await postJson(
      `/api/batches/${batch.id}/items/${it.id}/labels`,
      { quantity: qty, requested_by: operatorEl.value || null }
    );
    batchSound("ok");
    msg.textContent = `${res.count} label(s) queued — collect them at the printer.`;
  } catch (err) {
    batchSound("err");
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// Closing an edit window redraws the list from what's already loaded; it no
// longer re-runs the whole check. Re-checking asks Shopify about every item,
// which is slow and threw the list around after each edit — the ↻ button
// does it when the operator actually wants it.
document.getElementById("bitem-close").addEventListener("click", () => {
  document.getElementById("bitem-overlay").hidden = true;
  renderCheckList();
});
document.getElementById("bitem-overlay").addEventListener("click", (e) => {
  if (e.target.id === "bitem-overlay") {
    document.getElementById("bitem-overlay").hidden = true;
    renderCheckList();
  }
});

bEl.queue.addEventListener("click", async () => {
  const total = labelItems().reduce((n, i) => n + i.qty_scanned, 0);
  if (!confirm(`Queue ${total} label(s) for bin ${batch.bin_name}?`)) return;
  bEl.queue.disabled = true;
  try {
    const data = await postJson(`/api/batches/${batch.id}/queue-labels`, {
      requested_by: operatorEl.value || null,
    });
    batch.status = "printing";
    setBatchResult(`${data.count} label(s) queued.`, "ok");
    showBatchStage("print");
  } catch (err) {
    setBatchResult(err.message, "err");
  } finally {
    bEl.queue.disabled = false;
  }
});

// --- Stage 3: print ---------------------------------------------------------
async function pollBatchPrint() {
  if (!batch) return;
  try {
    const [agent, jobs] = await Promise.all([
      apiJson("/api/print-agent/status"),
      apiJson(`/api/print-jobs?batch_id=${batch.id}&limit=200`),
    ]);
    bEl.printAgent.textContent = agent.online
      ? "Printer agent: online ✓ (warehouse PC)"
      : "Printer agent: OFFLINE — is the warehouse PC on? Jobs stay queued.";
    const counts = { done: 0, error: 0, pending: 0, printing: 0 };
    jobs.jobs.forEach((j) => {
      counts[j.status] = (counts[j.status] || 0) + 1;
    });
    const total = jobs.jobs.length;
    bEl.printStatus.textContent =
      `Printed ${counts.done}/${total}` +
      (counts.error ? ` — ${counts.error} FAILED (see Print queue)` : "") +
      (counts.pending + counts.printing
        ? ` — ${counts.pending + counts.printing} in the queue…`
        : " ✓");
    if (total && counts.done + counts.error + (counts.canceled || 0) >= total) {
      stopBatchPrintPoll();
    }
  } catch (err) {
    /* transient; next tick retries */
  }
}

bEl.toPair.addEventListener("click", () => showBatchStage("pair"));

// --- Stage 4: pair ----------------------------------------------------------
function matchBatchItem(code) {
  const low = code.toLowerCase();
  const hits = batchItems.filter(
    (i) =>
      i.resolved &&
      ((i.barcode && i.barcode.toLowerCase() === low) ||
        (i.sku && i.sku.toLowerCase() === low) ||
        (i.scanned_code && i.scanned_code.toLowerCase() === low))
  );
  // Twins sharing a barcode (SS TH10 and its open-box listing, both seeded
  // from the same bin) both match — but only one has labels waiting for
  // tags. A row with nothing printed can't be the thing being paired, so
  // it must never win the tie.
  const labels = (i) => (i.labels_total != null ? i.labels_total : i.qty_scanned);
  return (
    hits.find((i) => labels(i) > i.paired_count) ||
    hits.find((i) => labels(i) > 0) ||
    hits[0] ||
    (/^\d{5,12}$/.test(code)
      ? batchItems.find(
          (i) => i.resolved && i.serial_prefix === code.slice(0, 4)
        )
      : null)
  );
}

function renderPairCard() {
  // Pairing is measured against LABELS PRINTED, not boxes scanned — those
  // differ whenever a count was corrected after queueing.
  const summary = document.getElementById("bpair-summary");
  const target = batchItems.reduce(
    (n, i) => n + (i.printed_count ?? i.qty_scanned),
    0
  );
  const paired = batchItems.reduce((n, i) => n + i.paired_count, 0);
  summary.textContent = `${paired} of ${target} printed label(s) paired${
    target - paired > 0 ? ` · ${target - paired} to go` : " ✓"
  }`;

  const item = batchItems.find((i) => i.id === pairActiveItemId);
  bEl.pairCard.hidden = !item;
  if (!item) return;
  const goal = item.printed_count ?? item.qty_scanned;
  bEl.pairActive.textContent = itemDisplayName(item);
  document.getElementById("bpair-norfid").textContent =
    item.rfid_incompatible
      ? "⊘ RFID flag ON — remove"
      : "⊘ Won't RFID scan";
  bEl.pairProgress.textContent =
    `${item.paired_count} of ${goal} printed label(s) paired · ` +
    `${Math.max(0, goal - item.paired_count)} remaining` +
    (item.printed_count != null && item.printed_count !== item.qty_scanned
      ? ` (${item.qty_scanned} box(es) scanned)`
      : "");
  bEl.pairUndo.disabled = !pairHistory.length;
}

function renderPairItems() {
  bEl.pairItems.innerHTML = "";
  batchItems
    .filter((i) => i.resolved && i.qty_scanned > 0)
    .forEach((item) => {
      const li = itemCard(item, "pair");
      if (item.printed_count != null) {
        const t = li.querySelector(".bcell__tracker");
        if (t) t.textContent = `${item.paired_count}/${item.printed_count}`;
      }
      li.addEventListener("click", () => {
        pairActiveItemId = item.id;
        renderPairItems();
        renderPairCard();
        bEl.pairInput.focus();
      });
      bEl.pairItems.append(li);
    });
}

bEl.pairInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const code = bEl.pairInput.value.trim();
  bEl.pairInput.value = "";
  if (!code || !batch) return;

  // A barcode from this batch switches the active product…
  const item = matchBatchItem(code);
  if (item) {
    pairActiveItemId = item.id;
    renderPairItems();
    renderPairCard();
    batchSound("ok");
    setBatchResult(`Active product: ${itemDisplayName(item)}`, "ok");
    return;
  }
  // Barcode/serial-shaped scans that match nothing are NOT tags — saving
  // them as EPCs would pollute the tag table.
  if (/^\d{5,14}$/.test(code)) {
    batchSound("err");
    setBatchResult(
      `"${code}" looks like a barcode or serial but doesn't match a ` +
        `product in this batch.`,
      "err"
    );
    return;
  }
  // …anything else is an RFID tag for the active product.
  if (!pairActiveItemId) {
    setBatchResult(
      "Scan a product barcode from this batch first — then its tags.",
      "err"
    );
    return;
  }
  try {
    const data = await postJson(`/api/batches/${batch.id}/pair`, {
      epc: code,
      item_id: pairActiveItemId,
      created_by: operatorEl.value || null,
    });
    const idx = batchItems.findIndex((i) => i.id === data.item.id);
    if (idx >= 0) {
      const flags = batchItems[idx]._binMismatch;
      batchItems[idx] = data.item;
      batchItems[idx]._binMismatch = flags;
    }
    pairHistory.push({ epc: data.assignment.rfid_id, item_id: data.item.id });
    renderPairItems();
    renderPairCard();
    setBatchResult(
      data.assignment.suspect
        ? `Saved, but ${code} doesn't look like a normal 24-char EPC — ` +
            `probably a bad read. Re-scan it to be safe.`
        : `Tag paired → ${itemDisplayName(data.item)} ` +
            `(${data.item.paired_count}/${data.item.qty_scanned}).`,
      data.assignment.suspect ? "err" : "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  }
  bEl.pairInput.focus();
});

// --- Fix label & reprint ----------------------------------------------------
// The labels printed wrong — usually a preferred name saved onto the wrong
// line ("Telescopes Canada" fixed but the SKU line clobbered). Correct the
// saved name store-wide, void this product's labels in the batch, release
// any tags tied to them, and print a fresh set: the tracker returns to 0/N
// with N the fresh count, never old-plus-new.
const STORE_HEADER = "Telescopes Canada";
// Defaults for the two boxes, captured when the dialog opens. Cancelling
// discards edits: every open re-reads the SAVED state, so the boxes show
// what they did before the first open, never a half-typed leftover.
let reprintDefaults = { top: STORE_HEADER, sku: "" };

// Approximate ZPL font-0 advance width, as a fraction of the font height.
// Same geometry as the print agent: 2.125in x 203dpi = 431 dots across.
const LABEL_PW = 431;
function zplTextDots(text, size) {
  const NARROW = "iIl1jft.,:;'|!()[] -";
  const WIDE = "MWmw@";
  let w = 0;
  for (const ch of text) {
    w += (NARROW.includes(ch) ? 0.35 : WIDE.includes(ch) ? 0.78 : 0.55) * size;
  }
  return w;
}

// Mirrors the print agent's layout rules: the top zone holds at most two
// lines (font steps down 28/20/16 with length) and ends where the SKU
// line starts; the SKU line is ONE line at font 30 — ZPL overprints
// rather than clipping, which is exactly the mess being fixed.
function labelFitIssues(top, sku) {
  const issues = [];
  if (top && top !== STORE_HEADER) {
    if (top.length > 76)
      issues.push("Top line: cut off after 76 characters.");
    const size = top.length <= 26 ? 28 : top.length <= 56 ? 20 : 16;
    const lines = Math.max(1, Math.ceil(zplTextDots(top, size) / LABEL_PW));
    if (lines > 2)
      issues.push(
        "Top line: needs more than the two lines available — the text " +
          "will overprint itself."
      );
    else if (lines === 2 && size === 28)
      issues.push(
        "Top line: wraps onto a second line that lands ON the SKU line."
      );
  }
  if (sku) {
    if (sku.length > 56)
      issues.push("SKU line: cut off after 56 characters.");
    else if (zplTextDots(sku, 30) > LABEL_PW)
      issues.push(
        "SKU line: too wide for its single line — the text will overlap " +
          "itself on the sticker."
      );
  }
  return issues;
}

// The item behind the open reprint dialog, for the preview's barcode/bin.
let breprintItem = null;

function updateReprintFitWarn() {
  const top =
    document.getElementById("breprint-top").value.trim() || STORE_HEADER;
  const skuLine = document.getElementById("breprint-sku").value.trim();
  // Live sticker preview, same tiers the printer steps through.
  const el = document.getElementById("breprint-prev-header");
  el.textContent = top;
  el.className =
    "label-preview__header " +
    (top === STORE_HEADER || top.length <= 26
      ? "label-preview__header--lg"
      : top.length <= 56
        ? "label-preview__header--md"
        : "label-preview__header--sm");
  document.getElementById("breprint-prev-sku").textContent = skuLine || "—";
  if (breprintItem) {
    document.getElementById("breprint-prev-bc").textContent =
      breprintItem.barcode || breprintItem.sku || "";
    document.getElementById("breprint-prev-bin").textContent =
      "BIN: " + (batch ? batch.bin_name : "—");
  }
  const warnEl = document.getElementById("breprint-fitwarn");
  const issues = labelFitIssues(top, skuLine);
  warnEl.hidden = !issues.length;
  warnEl.textContent = issues.length
    ? "⚠ " + issues.join("\n⚠ ") + "\nYou can still print — this is a warning, not a block."
    : "";
}

document.getElementById("bpair-reprint").addEventListener("click", async () => {
  const item = batchItems.find((i) => i.id === pairActiveItemId);
  if (!item || !batch) return;
  document.getElementById("breprint-title").textContent =
    itemDisplayName(item);
  document.getElementById("breprint-count").value =
    item.printed_count ?? item.qty_scanned;
  document.getElementById("breprint-warn").textContent = item.paired_count
    ? `⚠ ${item.paired_count} tag(s) are already paired to the old labels. ` +
      `PEEL THOSE STICKERS OFF the boxes before printing — a leftover ` +
      `sticker answers sweeps alongside the new one. You'll be asked to ` +
      `confirm they're off.`
    : `The old printed labels become invalid — bin them so they never ` +
      `end up on a box.`;
  document.getElementById("breprint-msg").textContent = "";
  breprintItem = item;
  reprintDefaults = { top: STORE_HEADER, sku: item.sku || "" };
  // Prefill from what's SAVED, never from a previous unconfirmed edit.
  let top = STORE_HEADER;
  let skuLine = item.sku || "";
  try {
    const cur = await apiJson(
      `/api/label-names/${encodeURIComponent(item.sku || "")}`
    );
    if (cur.label_name && cur.placement !== "sku") top = cur.label_name;
    if (cur.sku_text) skuLine = cur.sku_text;
    else if (cur.label_name && (cur.placement === "sku" || cur.placement === "both"))
      skuLine = cur.label_name;
  } catch {
    /* no saved name — defaults stand */
  }
  document.getElementById("breprint-top").value = top;
  document.getElementById("breprint-sku").value = skuLine;
  updateReprintFitWarn();
  document.getElementById("breprint-overlay").hidden = false;
});

document.getElementById("breprint-top").addEventListener("input", updateReprintFitWarn);
document.getElementById("breprint-sku").addEventListener("input", updateReprintFitWarn);
document.getElementById("breprint-top-reset").addEventListener("click", () => {
  document.getElementById("breprint-top").value = reprintDefaults.top;
  updateReprintFitWarn();
});
document.getElementById("breprint-sku-reset").addEventListener("click", () => {
  document.getElementById("breprint-sku").value = reprintDefaults.sku;
  updateReprintFitWarn();
});

document
  .getElementById("breprint-cancel")
  .addEventListener("click", () => {
    document.getElementById("breprint-overlay").hidden = true;
  });

document.getElementById("breprint-go").addEventListener("click", async () => {
  const item = batchItems.find((i) => i.id === pairActiveItemId);
  if (!item || !batch) return;
  const count = parseInt(
    document.getElementById("breprint-count").value,
    10
  );
  if (!Number.isFinite(count) || count < 1) {
    document.getElementById("breprint-msg").textContent =
      "How many labels should print?";
    return;
  }
  if (
    item.paired_count &&
    !confirm(
      `${item.paired_count} tag(s) are paired to the old labels.\n\n` +
        `Have you peeled the old RFID stickers OFF the boxes?\n\n` +
        `OK = they're off, release the ties and reprint.`
    )
  )
    return;
  const btn = document.getElementById("breprint-go");
  btn.disabled = true;
  try {
    const res = await postJson(
      `/api/batches/${batch.id}/items/${item.id}/reprint-labels`,
      {
        count,
        top_text: document.getElementById("breprint-top").value.trim(),
        sku_line: document.getElementById("breprint-sku").value.trim(),
        created_by: operatorEl.value || null,
        old_stickers_removed: true,
      }
    );
    document.getElementById("breprint-overlay").hidden = true;
    pairHistory = [];
    await pullBatch(false);
    renderPairItems();
    renderPairCard();
    setBatchResult(res.message, "ok");
  } catch (err) {
    document.getElementById("breprint-msg").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// Won't-RFID-scan toggle from the pair card: per-PRODUCT and store-wide,
// because every box of these shares the same tag-killing design. Labels
// still print and pairing still counts; sweeps stop expecting an answer.
document.getElementById("bpair-norfid").addEventListener("click", async () => {
  const item = batchItems.find((i) => i.id === pairActiveItemId);
  if (!item || !item.sku || !batch) return;
  const want = !item.rfid_incompatible;
  if (
    want &&
    !confirm(
      `Flag ${itemDisplayName(item)} as "won't RFID scan"?\n\n` +
        `Labels still print and pairing still counts — but sweeps and ` +
        `Verify stop expecting its tags to answer. Applies to this ` +
        `product store-wide, and is logged.`
    )
  )
    return;
  try {
    await apiJson(
      `/api/products/${encodeURIComponent(item.sku)}/rfid-incompatible`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incompatible: want,
          changed_by: operatorEl.value || null,
        }),
      }
    );
    batchItems.forEach((i) => {
      if ((i.sku || "").toUpperCase() === item.sku.toUpperCase())
        i.rfid_incompatible = want;
    });
    renderPairCard();
    setBatchResult(
      want
        ? `⊘ ${itemDisplayName(item)} flagged — sweeps won't expect it to answer.`
        : `Flag removed from ${itemDisplayName(item)}.`,
      "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

bEl.pairUndo.addEventListener("click", async () => {
  const last = pairHistory.pop();
  if (!last || !batch) return;
  try {
    const data = await postJson(`/api/batches/${batch.id}/pair/undo`, last);
    const idx = batchItems.findIndex((i) => i.id === data.item.id);
    if (idx >= 0) Object.assign(batchItems[idx], data.item);
    renderPairItems();
    renderPairCard();
    setBatchResult(`Undid tag ${last.epc}.`, "ok");
  } catch (err) {
    setBatchResult(err.message, "err");
  }
  bEl.pairInput.focus();
});

// Release every tie this batch made — for when a shelf needs re-pairing
// from scratch (no reprinting, the labels are still good).
document.getElementById("bpair-reset").addEventListener("click", async () => {
  if (!batch) return;
  const paired = batchItems.reduce((n, i) => n + i.paired_count, 0);
  if (!paired) {
    setBatchResult("Nothing paired in this batch yet.", "err");
    return;
  }
  if (
    !confirm(
      `Release all ${paired} tag(s) paired in this batch?\n\nThe printed ` +
        `labels stay valid — you just re-scan them onto their products. ` +
        `Nothing in Shopify changes.`
    )
  )
    return;
  try {
    const res = await postJson(`/api/batches/${batch.id}/unpair-all`, {});
    pairHistory = [];
    pairActiveItemId = null;
    await pullBatch(false);
    renderPairItems();
    renderPairCard();
    setBatchResult(
      `${res.removed} tie(s) released — pair the shelf again.`,
      "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

bEl.toVerify.addEventListener("click", () => showBatchStage("verify"));

// "Set to N" on a verify row: raise Shopify on-hand to the count the
// shelf walk physically found. One confirmation, server-guarded to
// increases only, logged with an Undo in History.
bEl.verifyReport.addEventListener("click", async (e) => {
  // Corrected counts from an expanded flagged row: scan count + already-
  // tagged count. LOCAL batch numbers only — nothing here touches
  // Shopify; the on-hand button stays the one explicit write.
  const saveBtn = e.target.closest(".bvx-save");
  if (saveBtn && batch) {
    const detail = saveBtn.closest("tr.bvx-detail");
    const qty = parseInt(detail.querySelector(".bvx-qty").value, 10);
    const tb = parseInt(detail.querySelector(".bvx-tb").value, 10);
    const id = parseInt(saveBtn.dataset.item, 10);
    if (isNaN(qty) || isNaN(tb) || qty < 0 || tb < 0) return;
    saveBtn.disabled = true;
    try {
      await postJson(`/api/batches/${batch.id}/items/${id}/qty`, { qty });
      await apiJson(`/api/batches/${batch.id}/items/${id}/tagged-before`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: tb,
          updated_by: operatorEl.value || null,
        }),
      });
      await runVerifyCheck();
      setBatchResult(
        "Counts corrected ✓ — batch records only. If Shopify's on-hand " +
          "should change too, use the row's Set-to button.",
        "ok"
      );
    } catch (err) {
      setBatchResult(err.message, "err");
      saveBtn.disabled = false;
    }
    return;
  }
  // "This batch physically handled the box(es) here" — a walked bin is a
  // deep manual check, so a disagreeing Shopify bin gets a one-tap fix
  // (the same audited bin write as everywhere else).
  const setBin = e.target.closest(".bvx-setbin");
  if (setBin && batch) {
    const sku = setBin.dataset.sku;
    const was = setBin.dataset.was || "nothing";
    if (
      !confirm(
        `Set the Shopify bin for ${sku} to ${batch.bin_name}?\n\n` +
          `Shopify currently says: ${was}. This is the normal audited ` +
          `bin write — Shopify, the bin map and this product's tags all ` +
          `follow, with a History entry.`
      )
    )
      return;
    setBin.disabled = true;
    try {
      await postJson("/api/bin-updates", {
        target: sku,
        bin: batch.bin_name,
        changed_by: operatorEl.value || null,
      });
      setBatchResult(
        `Shopify bin for ${sku} set to ${batch.bin_name} ✓`,
        "ok"
      );
      await runVerifyCheck();
    } catch (err) {
      setBatchResult(err.message, "err");
      setBin.disabled = false;
    }
    return;
  }
  // Flagged rows expand into their explanation, like the Review inbox.
  const flagRow = e.target.closest("tr.bvx-flag");
  if (flagRow && !e.target.closest("a, button, input, label")) {
    const det = bEl.verifyReport.querySelector(
      `tr.bvx-detail[data-for="${flagRow.dataset.item}"]`
    );
    if (det) {
      det.hidden = !det.hidden;
      if (!det.hidden) updateBvxSum(det);
    }
    return;
  }
  // "Raise all": one confirmation listing every change, then each row's
  // update runs as its OWN write — separate API call, History entry and
  // Undo, exactly as if each button were pressed by hand.
  const allBtn = e.target.closest("#bverify-fixall");
  if (allBtn && batch) {
    const btns = [...bEl.verifyReport.querySelectorAll(".onhand-fix")];
    if (!btns.length) return;
    const lines = btns.map(
      (b) => `${b.dataset.sku}: ${b.dataset.exp} → ${b.dataset.qty}`
    );
    if (
      !confirm(
        `Raise Shopify ON-HAND for ${btns.length} product(s)?\n\n` +
          lines.join("\n") +
          `\n\nEach writes separately — every product gets its own ` +
          `History entry and Undo.`
      )
    )
      return;
    allBtn.disabled = true;
    let done = 0;
    const failed = [];
    for (const b of btns) {
      try {
        await postJson("/api/onhand-updates", {
          sku: b.dataset.sku,
          new_qty: parseInt(b.dataset.qty, 10),
          changed_by: operatorEl.value || null,
          confirmed: true,
          batch_id: batch.id,
          item_id: parseInt(b.dataset.item, 10) || null,
        });
        done++;
      } catch (err) {
        failed.push(`${b.dataset.sku}: ${err.message}`);
      }
    }
    await runVerifyCheck();
    setBatchResult(
      `${done} on-hand value(s) raised` +
        (failed.length
          ? ` · ${failed.length} FAILED — ${failed.join(" · ")}`
          : " ✓ (each has its own Undo in History)"),
      failed.length ? "err" : "ok"
    );
    return;
  }
  const btn = e.target.closest(".onhand-fix");
  if (!btn || !batch) return;
  const sku = btn.dataset.sku;
  const qty = parseInt(btn.dataset.qty, 10);
  if (
    !confirm(
      `Set Shopify ON-HAND for ${sku} to ${qty}?\n\n` +
        `Shopify expected ${btn.dataset.exp}; the shelf walk physically ` +
        `found ${qty}.\n\nThis WRITES the number to Shopify. Undo stays ` +
        `available in History.`
    )
  )
    return;
  btn.disabled = true;
  try {
    const res = await postJson("/api/onhand-updates", {
      sku,
      new_qty: qty,
      changed_by: operatorEl.value || null,
      confirmed: true,
      batch_id: batch.id,
      item_id: parseInt(btn.dataset.item, 10) || null,
    });
    setBatchResult(res.message, "ok");
    await runVerifyCheck();
  } catch (err) {
    btn.disabled = false;
    setBatchResult(err.message, "err");
  }
});

// --- Stage 5: verify --------------------------------------------------------
bEl.verifyInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const code = bEl.verifyInput.value.trim();
  bEl.verifyInput.value = "";
  if (!code) return;
  verifyEpcs.add(code.toUpperCase());
  bEl.verifyCount.textContent = `${verifyEpcs.size} unique tags collected.`;
});

// The C72 companion app sends its sweep to the server over Wi-Fi; this
// pulls the most recent one into the verify set — no Bluetooth, no wedge —
// then checks the bin straight away (pulling to not check was busywork).
document.getElementById("bverify-pull").addEventListener("click", async () => {
  try {
    const cap = await apiJson("/api/epc-captures/latest");
    const before = verifyEpcs.size;
    cap.epcs.forEach((e) => verifyEpcs.add(String(e).toUpperCase()));
    bEl.verifyCount.textContent = `${verifyEpcs.size} unique tags collected.`;
    setBatchResult(
      `Pulled sweep #${cap.id} from ${cap.device || "the C72"} ` +
        `(${cap.epc_count} tags, ${fmtWhen(cap.created_at)}) — ` +
        `${verifyEpcs.size - before} new. Checking…`,
      "ok"
    );
    await runVerifyCheck();
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

async function runVerifyCheck() {
  if (!batch) return;
  const rep = await postJson(`/api/batches/${batch.id}/verify`, {
    epcs: [...verifyEpcs],
  });
  // Per-product agreement: boxes scanned == tags paired == tags detected.
  let boxesOk = true;
  let pairedOk = true;
  let detectedOk = true;
  const rows = rep.items
    .map((r) => {
      // "Won't RFID scan" products are expected silent: their detected
      // column reads n/a and never drags the verdict down.
      const na = r.rfid_incompatible;
      // Boxes already stickered before this batch (side trip, earlier
      // session): no scans or pairs happened HERE — that's expected —
      // but they are boxes on the shelf and their tags must answer the
      // sweep like anyone else's.
      const tb = r.tagged_before || 0;
      const boxes = r.qty_scanned + tb;
      const paired = r.paired_count === r.qty_scanned;
      // Accept EITHER this batch's own pairs alone (the already-tagged
      // boxes' tags may sit out of range) OR pairs + already-tagged
      // together. A count in between — one or two answering from across
      // the store rather than the whole bundle — or above is the only
      // case worth a flag (Nick, 2026-08-06).
      const detected =
        na ||
        r.detected === r.paired_count ||
        r.detected === r.paired_count + tb;
      if (r.qty_scanned !== r.paired_count) boxesOk = false;
      if (!paired) pairedOk = false;
      if (!detected) detectedOk = false;
      // Shopify's expected count, with the shortfall/overage in brackets:
      // "6 (−2)" = expected 6, found 4. DISPLAY ONLY — nothing here (and
      // no click) ever writes a count back.
      const found = r.units_total ?? r.qty_scanned;
      let expCell = "—";
      if (r.expected_qty != null) {
        const diff = found - r.expected_qty;
        expCell =
          `${r.expected_qty}` +
          (diff
            ? ` <span class="bexp--off">(${diff > 0 ? "+" : "−"}${Math.abs(diff)})</span>`
            : "");
        // Correction offered ONLY upward: finding more boxes than Shopify
        // knew about is physical proof; finding fewer proves nothing (the
        // rest may sit mis-binned elsewhere). Confirmed, logged, undoable.
        if (diff > 0 && r.sku) {
          expCell += `<div><button class="reset onhand-fix" type="button"
            data-sku="${escapeHtml(r.sku)}" data-qty="${found}"
            data-exp="${r.expected_qty}" data-item="${r.item_id}"
            title="Write the found count to Shopify on-hand — confirmed, logged, undoable from History">Set to ${found}</button></div>`;
        }
      }
      const flaggedRow = !(paired && detected) && !na;
      // A flagged row expands (like the Review inbox) into the item's
      // preview, what the sweep actually said, and the two counts whose
      // sum is checked against Shopify — corrected here, never written
      // anywhere automatically.
      const binsSaid = (r.detected_bins || [])
        .map((b) => `${escapeHtml(b.bin)} ×${b.count}`)
        .join(", ");
      const detail = flaggedRow
        ? `<tr class="bvx-detail" data-for="${r.item_id}" data-exp="${r.expected_qty ?? ""}" hidden><td colspan="7">
            <div class="bvx__wrap">
              ${r.image_url ? `<img class="bvx__img" src="${escapeHtml(r.image_url)}" alt="">` : ""}
              <div class="bvx__body">
                <div class="bvx__why">${
                  !paired
                    ? `${r.paired_count} tag(s) paired vs ${r.qty_scanned} box(es) scanned — finish pairing at the gun, or fix the scan count below. `
                    : ""
                }${
                  !detected
                    ? `The sweep heard <b>${r.detected}</b> tag(s) of this product${
                        binsSaid ? ` (records say: ${binsSaid})` : ""
                      }; this batch paired ${r.paired_count}${
                        tb ? ` and ${tb} were marked already-tagged` : ""
                      }. If the extra box(es) are really on this shelf, raise "Already tagged" until the numbers agree.`
                    : ""
                }</div>
                <div class="bvx__inputs">
                  <label>New boxes scanned
                    <input type="number" min="0" max="500" class="bvx-qty" value="${r.qty_scanned}"></label>
                  <label>Already RFID-tagged
                    <input type="number" min="0" max="500" class="bvx-tb" value="${tb}"></label>
                  <span class="bvx__sum"></span>
                  <button class="reset bvx-save" type="button" data-item="${r.item_id}">Save counts</button>
                </div>
              </div>
            </div>
          </td></tr>`
        : "";
      return `<tr${
        flaggedRow
          ? ` class="bvx-flag" data-item="${r.item_id}" title="Click to review — what the sweep heard vs this batch's counts"`
          : ""
      }>
        <td>${productLink(r.product_title, r.shopify_product_id)}${
          na
            ? ' <span class="noscan-chip" title="tag won\'t scan when on box — sweeps don\'t expect it to answer">⊘</span>'
            : ""
        }${
          tb
            ? ` <span class="tagged-chip" title="${tb} box(es) on this shelf were already RFID tagged before this batch (side trip or earlier session) — no scans or pairs expected here, but the sweep must hear their tags">✓${tb} already tagged</span>`
            : ""
        }${
          r.bin_differs && r.sku
            ? ` <button class="binfix bvx-setbin" type="button" data-sku="${escapeHtml(
                r.sku
              )}" data-was="${escapeHtml(
                r.bin_location || "nothing"
              )}" title="Shopify's bin for this product says ${escapeHtml(
                r.bin_location || "nothing"
              )}, but this batch physically handled it on ${escapeHtml(
                batch.bin_name
              )}. Click to write ${escapeHtml(
                batch.bin_name
              )} to Shopify (audited, undoable via History).">bin ⇢ ${escapeHtml(
                batch.bin_name
              )}</button>`
            : ""
        }</td>
        <td class="mono">${escapeHtml(r.sku || "—")}</td>
        <td class="num">${boxes}${
          tb ? ` <span class="bexp--note" title="${r.qty_scanned} scanned this batch + ${tb} already tagged">(${r.qty_scanned}+${tb})</span>` : ""
        }</td>
        <td class="num">${expCell}</td>
        <td class="num${paired ? "" : " bexp--off"}">${r.paired_count}${
          tb ? ` <span class="bexp--note" title="the ${tb} already-tagged box(es) were paired in an earlier session, not here">+${tb} earlier</span>` : ""
        }</td>
        <td class="num${detected ? "" : " bexp--off"}">${
          na ? (r.detected > 0 ? `${r.detected} ⊘` : "n/a") : r.detected
        }</td>
        <td>${na && paired ? "⊘" : paired && detected ? "✓" : "⚠ ▸"}</td>
      </tr>${detail}`;
    })
    .join("");

  const otherCount = rep.foreign.length + rep.unknown_epcs.length;
  const otherRows = [
    ...rep.foreign.map(
      (f) =>
        `<li>${escapeHtml(f.product_title || "?")} <span class="mono">${escapeHtml(f.epc)}</span>${
          f.bin_location ? " · bin " + escapeHtml(f.bin_location) : ""
        }</li>`
    ),
    ...rep.unknown_epcs.map(
      (e) => `<li>Unknown tag <span class="mono">${escapeHtml(e)}</span></li>`
    ),
  ].join("");

  // The verdict line states which of the three columns agree.
  const mismatches = [];
  if (!pairedOk) mismatches.push("tags paired ≠ boxes scanned");
  if (!detectedOk) mismatches.push("tags detected ≠ tags paired");
  const verdict = mismatches.length
    ? `<p class="result result--err">⚠ Boxes / paired / detected do NOT all agree — ${mismatches.join(
        " · "
      )}. Check the ⚠ rows.</p>`
    : `<p class="result result--ok">✓ Boxes, paired and detected all agree for every product.</p>`;
  // Expected silence is stated out loud, not hidden inside a green tick:
  // flagged products were paired but no sweep will ever hear them.
  const naSilent = rep.items.filter(
    (r) => r.rfid_incompatible && r.paired_count > 0 && r.detected === 0
  ).length;
  const naNote = naSilent
    ? `<p class="result">⊘ ${naSilent} product(s) flagged "won't RFID scan" answered nothing, as expected — their tags are paired and counted; the sweep can't hear them on the box.</p>`
    : "";
  // The already-tagged exception is said out loud too: 0 scanned and 0
  // paired on those rows is CORRECT, not a miss — the boxes arrived with
  // stickers from an earlier session and only need to answer the sweep.
  const tbRows = rep.items.filter((r) => (r.tagged_before || 0) > 0);
  const tbNote = tbRows.length
    ? `<p class="result">✓ ${tbRows.length} product(s) had boxes already RFID tagged before this batch (side trip or earlier session) — 0 scans and 0 pairs there is expected; their tags are counted in Detected instead.</p>`
    : "";

  // One button to press every eligible "Set to N" in turn — each write
  // stays its own API call and its own History row with its own Undo.
  const fixable = rep.items.filter(
    (r) =>
      r.sku &&
      r.expected_qty != null &&
      (r.units_total ?? r.qty_scanned) > r.expected_qty
  );
  const fixAll =
    fixable.length > 1
      ? `<div class="linkbox__actions" style="margin-top:8px">
           <button class="reset" id="bverify-fixall" type="button"
             title="Runs each row's Set-to button in turn — every product gets its own confirmation summary line, History entry and Undo">
             Raise on-hand for all ${fixable.length} short products…</button>
         </div>`
      : "";

  bEl.verifyReport.innerHTML = `
    ${verdict}${naNote}${tbNote}
    <div class="inventory__scroll"><table class="inventory__table">
      <thead><tr><th>Product</th><th>SKU</th><th class="num">Boxes</th><th class="num" title="Shopify on-hand for this shelf; brackets show scanned-vs-expected">Expected</th><th class="num">Paired</th><th class="num">Detected</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>${fixAll}
    ${
      otherCount
        ? `<div class="linkbox__actions" style="margin-top:8px">
             <button class="reset" id="bverify-others" type="button">See other detected items (${otherCount})</button>
           </div>
           <ul class="recent__list" id="bverify-otherlist" hidden>${otherRows}</ul>`
        : ""
    }`;
  const othersBtn = document.getElementById("bverify-others");
  if (othersBtn)
    othersBtn.addEventListener("click", () => {
      const list = document.getElementById("bverify-otherlist");
      list.hidden = !list.hidden;
      othersBtn.textContent = list.hidden
        ? `See other detected items (${otherCount})`
        : "Hide other detected items";
    });
  return rep;
}

// "Check bin" is now a lookup: point the current sweep at ANY bin and see
// what it says — handy when a stray tag might belong to a neighbour.
bEl.verifyCheck.addEventListener("click", async () => {
  const name = prompt(
    "Check which bin against this sweep?",
    batch ? batch.bin_name : ""
  );
  if (name === null) return;
  const bin = name.trim();
  if (!bin) return;
  bEl.verifyCheck.disabled = true;
  try {
    const rep = await postJson(`/api/bins/${encodeURIComponent(bin)}/check`, {
      epcs: [...verifyEpcs],
    });
    const rows = rep.items
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.product_title || "")}</td>
          <td class="mono">${escapeHtml(r.sku || "—")}</td>
          <td class="num">${r.expected_qty ?? "—"}</td>
          <td class="num">${r.tags_on_file}</td>
          <td class="num${r.detected ? "" : " bexp--off"}">${r.detected}</td>
        </tr>`
      )
      .join("");
    bEl.verifyReport.innerHTML = `
      <p class="result">Bin <b>${escapeHtml(rep.bin)}</b> checked against ${rep.swept} swept tag(s) — ${rep.count} product(s) on file there.</p>
      <div class="inventory__scroll"><table class="inventory__table">
        <thead><tr><th>Product</th><th>SKU</th><th class="num">On hand</th><th class="num">Tags on file</th><th class="num">Detected</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="inventory__empty">Nothing on file for that bin.</td></tr>'}</tbody>
      </table></div>`;
  } catch (err) {
    setBatchResult(err.message, "err");
  } finally {
    bEl.verifyCheck.disabled = false;
  }
});

// Live sum in an expanded verify row: (new + already-tagged) vs Shopify.
function updateBvxSum(detail) {
  const q = parseInt(detail.querySelector(".bvx-qty").value, 10) || 0;
  const t = parseInt(detail.querySelector(".bvx-tb").value, 10) || 0;
  const exp = detail.dataset.exp;
  const sum = detail.querySelector(".bvx__sum");
  let text = `= ${q + t} box(es) total`;
  if (exp !== "") {
    const diff = q + t - parseInt(exp, 10);
    text += ` vs expected ${exp}${
      diff ? ` (${diff > 0 ? "+" : "−"}${Math.abs(diff)})` : " ✓"
    }`;
  }
  sum.textContent = text;
}

bEl.verifyReport.addEventListener("input", (e) => {
  const detail = e.target.closest("tr.bvx-detail");
  if (detail) updateBvxSum(detail);
});

bEl.complete.addEventListener("click", async () => {
  if (!batch) return;
  // RFID check before finishing: every scanned box should have a tag
  // paired ("entered into inventory using RFID"). Finishing short is
  // allowed, but only past an explicit are-you-sure with the shortfall.
  const unpaired = batchItems.filter(
    (i) => i.resolved && i.paired_count < i.qty_scanned
  );
  const missingBoxes = unpaired.reduce(
    (n, i) => n + (i.qty_scanned - i.paired_count),
    0
  );
  let msg = `Complete the batch for bin ${batch.bin_name}?`;
  if (unpaired.length) {
    const names = unpaired
      .slice(0, 6)
      .map(
        (i) =>
          `• ${i.product_title || i.sku || i.scanned_code}: ` +
          `${i.paired_count}/${i.qty_scanned} entered by RFID`
      )
      .join("\n");
    msg =
      `⚠ ${unpaired.length} product(s) — ${missingBoxes} box(es) — ` +
      `have NOT been entered into inventory with RFID tags yet:\n\n` +
      `${names}${unpaired.length > 6 ? "\n…" : ""}\n\n` +
      `Are you sure you want to finish? The missing ones will be filed ` +
      `in Review as incomplete pairing.`;
  }
  // Closing a bin without ever sweeping it means the tags were never
  // checked against the shelf — worth one more question.
  if (!batch.verified_at) {
    msg =
      `This bin has never been verified — no RFID sweep has been checked ` +
      `against it.\n\n${msg}`;
  }
  if (!confirm(msg)) return;
  bEl.complete.disabled = true;
  try {
    const data = await postJson(`/api/batches/${batch.id}/complete`, {
      created_by: operatorEl.value || null,
      finalize: true,
    });
    const n = data.review_tasks.length;
    batch = null;
    batchItems = [];
    pairHistory = [];
    pairActiveItemId = null;
    stopBatchLive();
    enterBatchTab();
    setBatchResult(
      n
        ? `Batch done. ${n} item(s) sent to Review (count/pairing follow-ups).`
        : "Batch done — no follow-ups. Clean bin ✓",
      "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  } finally {
    bEl.complete.disabled = false;
  }
});

// === Print queue tab ========================================================
async function loadQueue() {
  const body = document.getElementById("queue-body");
  const pill = document.getElementById("agent-pill");
  try {
    const [agent, data] = await Promise.all([
      apiJson("/api/print-agent/status"),
      apiJson("/api/print-jobs?limit=100"),
    ]);
    pill.textContent = agent.online
      ? "Printer agent: online ✓"
      : "Printer agent: offline";
    pill.className = "pill " + (agent.online ? "pill--ok" : "pill--bad");
    if (!data.jobs.length) {
      body.innerHTML =
        '<tr><td colspan="9" class="inventory__empty">No print jobs yet.</td></tr>';
      return;
    }
    body.innerHTML = "";
    data.jobs.forEach((j) => {
      const tr = document.createElement("tr");
      const canCancel = j.status === "pending";
      const canReprint = ["done", "error", "canceled"].includes(j.status);
      tr.innerHTML = `
        <td class="mono">#${j.id}</td>
        <td>${
          j.sku
            ? `<span class="prodopen queue-prod">${escapeHtml(j.label_name || j.product_title || "")}</span>`
            : escapeHtml(j.label_name || j.product_title || "")
        }${
          j.variant_title ? ` <span class="inventory__variant">(${escapeHtml(j.variant_title)})</span>` : ""
        }</td>
        <td class="mono">${
          j.sku
            ? `<a href="#" class="queue-sku">${escapeHtml(j.sku)}</a>`
            : "—"
        }</td>
        <td>${escapeHtml(j.bin_location || "—")}</td>
        <td class="mono">${j.batch_id ? "#" + j.batch_id : "—"}</td>
        <td>${escapeHtml(j.requested_by || "—")}</td>
        <td><span class="chip-status chip-status--${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>${
          j.error ? ` <span class="recent__meta" title="${escapeHtml(j.error)}">ⓘ</span>` : ""
        }</td>
        <td class="recent__meta">${escapeHtml(fmtWhen(j.printed_at || j.created_at))}</td>
        <td>${canCancel ? '<button class="recent__unassign" data-act="cancel">cancel</button>' : ""}${
          canReprint ? '<button class="recent__unassign" data-act="reprint">reprint</button>' : ""
        }</td>`;
      // SKU and product name both open the product's own window.
      tr.querySelectorAll(".queue-sku, .queue-prod").forEach((a) =>
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          openProductHistory(j.sku);
        })
      );
      const cancelBtn = tr.querySelector('[data-act="cancel"]');
      if (cancelBtn)
        cancelBtn.addEventListener("click", async () => {
          try {
            await postJson(`/api/print-jobs/${j.id}/cancel`, {});
            loadQueue();
          } catch (err) {
            alert(err.message);
          }
        });
      const reprintBtn = tr.querySelector('[data-act="reprint"]');
      if (reprintBtn)
        reprintBtn.addEventListener("click", async () => {
          if (!confirm(`Reprint one label for ${j.sku || j.product_title}? (New EPC — the damaged label's tag stays unassigned.)`)) return;
          try {
            await postJson("/api/print-jobs", {
              quantity: 1,
              shopify_variant_id: j.shopify_variant_id,
              shopify_product_id: j.shopify_product_id,
              product_title: j.product_title,
              variant_title: j.variant_title,
              sku: j.sku,
              barcode: j.barcode,
              bin_location: j.bin_location,
              label_name: j.label_name,
              requested_by: operatorEl.value || j.requested_by,
            });
            loadQueue();
          } catch (err) {
            alert(err.message);
          }
        });
      body.append(tr);
    });
  } catch (err) {
    body.innerHTML =
      '<tr><td colspan="9" class="inventory__empty">Could not load the queue.</td></tr>';
    pill.textContent = "Printer agent: unknown";
    pill.className = "pill";
  }
}

// === Review tab (WIP: task inbox) ==========================================
let reviewTasks = [];
let reviewFilter = "";
let reviewOpenIds = new Set();

async function loadReview() {
  const list = document.getElementById("review-list");
  try {
    const { tasks } = await apiJson("/api/review-tasks?status=open&limit=100");
    reviewTasks = tasks;
    // The type filter offers exactly the categories present right now.
    const sel = document.getElementById("review-filter");
    const cats = [...new Set(tasks.map((t) => t.category))].sort();
    if (reviewFilter && !cats.includes(reviewFilter)) reviewFilter = "";
    sel.innerHTML =
      '<option value="">All types</option>' +
      cats
        .map(
          (c) =>
            `<option value="${escapeHtml(c)}"${c === reviewFilter ? " selected" : ""}>${escapeHtml(evLabel(c))}</option>`
        )
        .join("");
    renderReview();
  } catch (err) {
    list.innerHTML =
      '<li class="recent__empty">Could not load review tasks.</li>';
  }
}

function renderReview() {
  const list = document.getElementById("review-list");
  const tasks = reviewFilter
    ? reviewTasks.filter((t) => t.category === reviewFilter)
    : reviewTasks;
  list.innerHTML = "";
  if (!tasks.length) {
    list.innerHTML = `<li class="recent__empty">${
      reviewFilter
        ? "No open tasks of that type."
        : "Inbox zero — nothing needs review."
    }</li>`;
    return;
  }
  tasks.forEach((t) => {
    const li = document.createElement("li");
    li.style.display = "block";
    const open = reviewOpenIds.has(t.id);
    // The boilerplate recommendation sentence lives behind the expansion,
    // on its own line — the collapsed row keeps just the facts.
    const rec = /Recommend[^.]*\.\s*$/.exec(t.detail || "");
    const short = rec ? t.detail.slice(0, rec.index).trim() : t.detail;
    // Bin checks carry their bin in the detail ("Bin K3-1: …") — that's
    // enough to jump straight into the Audits tab with the bin loaded.
    const checkBin =
      t.category === "bin-check" && /^Bin\s+(.+?):/.exec(t.detail || "");
    li.innerHTML =
      `<div class="rv-row">
        ${evChip(t.category)}
        <span class="recent__prod"><b>${escapeHtml(t.product_title || t.sku || "")}</b> ${escapeHtml(short)}</span>
        <span class="recent__meta recent__when" title="${escapeHtml(fmtWhen(t.created_at))}">${escapeHtml(fmtAgo(t.created_at))}</span>
        ${
          checkBin
            ? `<button class="rv-btn rv-btn--audit" data-act="audit" type="button"
                 title="Open the Audits tab with ${escapeHtml(checkBin[1])} loaded — runs right away if a fresh C72 sweep is waiting">run audit</button>`
            : ""
        }
        <button class="rv-btn rv-btn--resolve" data-act="resolve" type="button">resolve</button>
        <button class="rv-btn rv-btn--dismiss" data-act="dismiss" type="button">dismiss</button>
        <span class="auditrow__chev">${open ? "▾" : "▸"}</span>
      </div>` +
      (open
        ? `<div class="rv-detail">
            ${
              t.image_url
                ? `<img class="rv-img" src="${escapeHtml(t.image_url)}" alt="" />`
                : ""
            }
            <div>
              <div>${
                t.sku
                  ? `<b class="prodopen rv-prod" title="Open this product — label editor, RFID flag, full history">${escapeHtml(t.product_title || "")}</b>`
                  : `<b>${escapeHtml(t.product_title || "")}</b>`
              }${
                t.sku
                  ? ` <span class="mono recent__meta">· ${escapeHtml(t.sku)}</span>`
                  : ""
              }</div>
              <div class="recent__meta" style="margin-top:2px">${escapeHtml(short)}</div>
              ${
                rec
                  ? `<div class="recent__meta" style="margin-top:4px"><i>${escapeHtml(rec[0].trim())}</i></div>`
                  : ""
              }
            </div>
          </div>`
        : "");
    li.querySelector(".rv-row").addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      if (reviewOpenIds.has(t.id)) reviewOpenIds.delete(t.id);
      else reviewOpenIds.add(t.id);
      renderReview();
    });
    // The product opens ONLY from the expanded detail — never from the
    // collapsed row, where the click belongs to expand/resolve/dismiss.
    const rvProd = li.querySelector(".rv-detail .rv-prod");
    if (rvProd)
      rvProd.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openProductHistory(t.sku);
      });
    const act = async (dismissed) => {
      const operator = operatorEl.value;
      if (!operator) {
        alert("Pick who's scanning (top right) first.");
        return;
      }
      try {
        await postJson(`/api/review-tasks/${t.id}/resolve`, {
          resolved_by: operator,
          dismissed,
        });
        reviewTasks = reviewTasks.filter((x) => x.id !== t.id);
        renderReview();
      } catch (err) {
        alert(err.message);
      }
    };
    li.querySelector('[data-act="resolve"]').addEventListener("click", () => act(false));
    li.querySelector('[data-act="dismiss"]').addEventListener("click", () => act(true));
    const auditBtn = li.querySelector('[data-act="audit"]');
    if (auditBtn)
      auditBtn.addEventListener("click", () => jumpToBinAudit(checkBin[1]));
    list.append(li);
  });
}

document.getElementById("review-filter").addEventListener("change", (e) => {
  reviewFilter = e.target.value;
  renderReview();
});

// Looping ". .. ..." on a button while a slow refresh runs — proof of
// life, not progress. Returns a stop function that restores the label.
function startDots(el, base) {
  const prev = el.textContent;
  let n = 0;
  const timer = setInterval(() => {
    n = (n % 3) + 1;
    el.textContent = base + ".".repeat(n);
  }, 400);
  el.textContent = base + ".";
  return () => {
    clearInterval(timer);
    el.textContent = prev;
  };
}

// === Audits tab =============================================================
// Shopify on-hand vs RFID units, per product, summed per bin — biggest
// total mismatch first (the received-but-nowhere-to-be-found detector).
let auditData = null;
let auditShowUntagged = false;
let auditOpenBins = new Set();

function renderAuditBins() {
  const list = document.getElementById("audit-bins");
  const meta = document.getElementById("audit-meta");
  if (!auditData) return;
  const q = document
    .getElementById("audit-filter")
    .value.trim()
    .toLowerCase();
  meta.textContent =
    `(on-hand from Shopify ` +
    (auditData.onhand_age_minutes == null
      ? "— age unknown"
      : auditData.onhand_age_minutes < 60
        ? `${auditData.onhand_age_minutes} min ago`
        : `${Math.round(auditData.onhand_age_minutes / 60)} h ago`) +
    `${auditData.refreshing ? " · refreshing now…" : ""})`;
  // Default = bins that went through batch tagging to completion. A lone
  // Scan-Station tag or a carried-in stray must not promote a bin whose
  // score would be almost all never-tagged noise (the E6-1 lesson).
  document.getElementById("audit-untagged").textContent = auditShowUntagged
    ? "Show only batch-tagged bins"
    : `Show not-yet-tagged bins (${auditData.bin_count - auditData.done_bin_count})`;

  const rows = auditData.bins.filter((b) => {
    if (!auditShowUntagged && !b.batch_done) return false;
    if (!q) return true;
    return (
      b.bin.toLowerCase().includes(q) ||
      b.products.some((p) => (p.sku || "").toLowerCase().includes(q))
    );
  });
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<li class="recent__empty">${
      q
        ? "No bins match that."
        : "No batch-tagged bins yet — complete a batch first."
    }</li>`;
    return;
  }
  rows.forEach((b) => {
    const li = document.createElement("li");
    li.style.display = "block";
    const clean = b.score === 0;
    const open = auditOpenBins.has(b.bin);
    li.innerHTML =
      `<div class="auditrow${clean ? " auditrow--clean" : ""}">
         <span class="inventory__bin">${escapeHtml(b.bin)}</span>
         <span class="auditrow__num ${clean ? "auditrow__num--ok" : ""}" title="sum of |Shopify − RFID| across this bin's products">${
           clean ? "✓" : b.score
         }</span>
         <span class="binlist__count" style="margin-left:auto">${b.product_count} product(s)${
           clean
             ? " · all match"
             : ` · ${b.mismatched_count} mismatched`
         }${
           b.batch_done
             ? ""
             : b.tagged
               ? ` · NOT batch-tagged (${b.tagged_products} of ${b.product_count} have stray tags)`
               : " · not batch-tagged"
         }</span>
         <span class="auditrow__chev">${open ? "▾" : "▸"}</span>
       </div>` +
      (open
        ? `<div class="inventory__scroll" style="margin:6px 0 10px 30px"><table class="inventory__table">
             <thead><tr><th>Product</th><th>SKU</th><th class="num">Shopify</th><th class="num">RFID</th><th class="num">Diff</th></tr></thead>
             <tbody>${b.products
               .map(
                 (p) => `<tr>
                   <td>${escapeHtml(p.product_title || "")}${
                     p.rfid_incompatible
                       ? ' <span class="noscan-chip" title="tag won\'t scan when on box">⊘</span>'
                       : ""
                   }</td>
                   <td class="mono"><span class="skulink" data-sku="${escapeHtml(p.sku || "")}">${escapeHtml(p.sku || "—")}</span></td>
                   <td class="num">${p.on_hand == null ? "—" : p.on_hand}</td>
                   <td class="num">${p.rfid_units}</td>
                   <td class="num${p.diff ? " bexp--off" : ""}">${
                     p.diff > 0 ? "+" + p.diff : p.diff
                   }</td>
                 </tr>`
               )
               .join("")}</tbody>
           </table></div>`
        : "");
    li.querySelector(".auditrow").addEventListener("click", () => {
      if (auditOpenBins.has(b.bin)) auditOpenBins.delete(b.bin);
      else auditOpenBins.add(b.bin);
      renderAuditBins();
    });
    li.querySelectorAll(".skulink").forEach((s) =>
      s.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (s.dataset.sku) openProductHistory(s.dataset.sku);
      })
    );
    list.append(li);
  });
}

// === Bin audit: newest C72 sweep vs any bin =================================
// The Check-step story without a batch: per product, what Shopify expects,
// what's tagged here, what the sweep actually heard — plus strays and
// unknown tags. The check is read-only; the panel's two WRITES are both
// operator-confirmed — "Set to N" (Shopify on-hand, increase-only, undoable
// from History) and "Record as batch tagged" (local batch record only).
let binAudit = null; // { rep, cap } — kept so toggles re-render for free
let binAuditShowUntagged = false;

// One-tap jump from a Review bin-check card: land on the Audits tab with
// the bin loaded. If the newest C72 sweep is fresh the operator has
// clearly just walked the shelf, so the audit runs itself; a stale sweep
// would only produce a scary everything-is-missing report, so instead the
// panel says what to go do.
async function jumpToBinAudit(bin) {
  document.querySelector('.tabs__tab[data-tab="audits"]').click();
  const binEl = document.getElementById("binaudit-bin");
  const out = document.getElementById("binaudit-report");
  binEl.value = bin;
  binEl.scrollIntoView({ behavior: "smooth", block: "center" });
  try {
    const cap = await apiJson("/api/epc-captures/latest");
    const ageMs = Date.now() - tsDate(cap.created_at).getTime();
    if (Number.isFinite(ageMs) && ageMs <= 5 * 60000) {
      document.getElementById("binaudit-run").click();
      return;
    }
    out.innerHTML = `<p class="result">Walk-scan ${escapeHtml(bin)} with the C72
      (SWEEP → SEND), then hit RUN — the newest sweep on file is
      ${escapeHtml(fmtAgo(cap.created_at))}.</p>`;
  } catch (err) {
    out.innerHTML = `<p class="result">Walk-scan ${escapeHtml(bin)} with the C72
      (SWEEP → SEND), then hit RUN.</p>`;
  }
}

document.getElementById("binaudit-run").addEventListener("click", async () => {
  const binEl = document.getElementById("binaudit-bin");
  const out = document.getElementById("binaudit-report");
  const bin = binEl.value.trim();
  if (!bin) {
    out.innerHTML = `<p class="result result--err">Which bin? Type it first (e.g. D2-2).</p>`;
    binEl.focus();
    return;
  }
  out.innerHTML = `<p class="result">Pulling the latest sweep…</p>`;
  try {
    const cap = await apiJson("/api/epc-captures/latest");
    const rep = await postJson(
      `/api/bins/${encodeURIComponent(bin)}/check`,
      { epcs: cap.epcs }
    );
    binAudit = { rep, cap };
    binAuditShowUntagged = false;
    renderBinAudit();
  } catch (err) {
    out.innerHTML = `<p class="result result--err">${escapeHtml(err.message)}</p>`;
  }
});

function renderBinAudit() {
  const out = document.getElementById("binaudit-report");
  if (!binAudit) return;
  const { rep, cap } = binAudit;

  const scored = rep.items
    // Nothing expected, nothing tagged, nothing heard: not part of this
    // bin's story at all.
    .filter((r) => (r.expected_qty || 0) > 0 || r.tags_here > 0 || r.detected > 0)
    .map((r) => {
      const flags = [];
      if (r.rfid_incompatible) {
        flags.push(["⊘ won't scan on box", "chip--na"]);
      } else if (r.detected < r.tags_here) {
        flags.push([
          `${r.tags_here - r.detected} tagged box(es) silent`,
          "chip--warn",
        ]);
      }
      // Untagged: Shopify expects stock here but the RFID system holds
      // nothing for it. On a part-tagged shelf that's most of the list,
      // so it sits behind a toggle, below everything that IS tagged.
      const untagged = r.tags_here === 0 && r.detected === 0;
      return { r, flags, untagged };
    })
    .sort(
      (a, b) =>
        a.untagged - b.untagged ||
        b.flags.length - a.flags.length ||
        String(a.r.product_title).localeCompare(String(b.r.product_title))
    );
  const untaggedCount = scored.filter((s) => s.untagged).length;
  const shown = binAuditShowUntagged
    ? scored
    : scored.filter((s) => !s.untagged);

  const cells = shown
    .map(({ r, flags, untagged }) => {
      const tagsNote = (units, tags) =>
        units !== tags
          ? ` <span class="bexp--note">(${tags} tag${tags === 1 ? "" : "s"})</span>`
          : "";
      // Expected reads exactly like the batch-tagging verify table:
      // Shopify's number with the difference in brackets, and the
      // increase-only on-hand write offered when the shelf holds more
      // than Shopify knows about.
      let expCell = "—";
      if (r.expected_qty != null) {
        const diff = r.units_here - r.expected_qty;
        expCell =
          `${r.expected_qty}` +
          (diff
            ? ` <span class="bexp--off">(${diff > 0 ? "+" : "−"}${Math.abs(diff)})</span>`
            : "");
        if (diff > 0 && r.sku) {
          expCell += `<div><button class="reset binaudit-fix" type="button"
            data-sku="${escapeHtml(r.sku)}" data-qty="${r.units_here}"
            data-exp="${r.expected_qty}"
            title="Write the tagged count to Shopify on-hand — confirmed, logged, undoable from History">Set to ${r.units_here}</button></div>`;
        }
      }
      return `<tr${untagged ? ' class="binaudit-untagged"' : ""}>
        <td>${
          r.image_url
            ? `<img class="bvx__img" style="width:40px;height:40px" src="${escapeHtml(r.image_url)}" alt="">`
            : ""
        }</td>
        <td>${
          r.sku
            ? `<span class="prodopen" data-sku="${escapeHtml(r.sku)}" title="Open this product — label editor, RFID flag, full history">${escapeHtml(r.product_title || "(unknown)")}</span>`
            : escapeHtml(r.product_title || "(unknown)")
        }${r.variant_title ? ` (${escapeHtml(r.variant_title)})` : ""}</td>
        <td class="mono"><span class="skulink" data-sku="${escapeHtml(r.sku || "")}" title="Open this product — label editor, RFID flag, full history">${escapeHtml(r.sku || "—")}</span></td>
        <td class="num">${expCell}</td>
        <td class="num">${r.units_here}${tagsNote(r.units_here, r.tags_here)}</td>
        <td class="num">${r.detected_units}${tagsNote(r.detected_units, r.detected)}</td>
        <td>${
          flags.length
            ? flags
                .map(
                  ([t, c]) =>
                    `<span class="binaudit-chip ${c}">${escapeHtml(t)}</span>`
                )
                .join(" ")
            : "✓"
        }</td>
      </tr>`;
    })
    .join("");

  const strays = rep.foreign
    .map(
      (f) =>
        `<li>${
          f.sku
            ? `<span class="prodopen" data-sku="${escapeHtml(f.sku)}">${escapeHtml(f.product_title || "?")}</span>`
            : escapeHtml(f.product_title || "?")
        } <span class="mono">${escapeHtml(f.sku || "")}</span>${
          f.bin_location ? " · recorded at " + escapeHtml(f.bin_location) : ""
        } <span class="mono">${escapeHtml(f.epc)}</span></li>`
    )
    .join("");
  const unknowns = rep.unknown_epcs
    .map((e) => `<li>Unknown tag <span class="mono">${escapeHtml(e)}</span></li>`)
    .join("");

  out.innerHTML = `
    <p class="result result--ok">Sweep #${cap.id} from ${escapeHtml(
      cap.device || "the C72"
    )} — ${cap.epc_count} tag(s), ${escapeHtml(fmtWhen(cap.created_at))} —
    checked against ${escapeHtml(rep.bin)}.</p>
    ${
      rep.batch_done
        ? `<p class="result result--ok">✓ Already recorded as batch tagged —
           batch #${rep.batch_done_id}${
             rep.batch_done_at
               ? `, finished ${escapeHtml(fmtWhen(rep.batch_done_at))}`
               : ""
           }. Nothing to record here.${
             (rep.abandoned_batches || []).length
               ? ` (Bin also has ${
                   rep.abandoned_batches.length
                 } abandoned attempt(s): ${rep.abandoned_batches
                   .map((n) => "#" + n)
                   .join(", ")} — superseded by #${rep.batch_done_id}.)`
               : ""
           }</p>`
        : `<p class="result result--warn-soft">This bin has no completed batch —
           it doesn't count as tagged. If the shelf really is fully tagged (a
           batch abandoned after every tag was paired), you can record it:
           <button class="reset" id="binaudit-marktagged" type="button"
             title="Records the bin as batch tagged from the tags already on file — tags nothing, prints nothing, writes nothing to Shopify">Record ${escapeHtml(rep.bin)} as batch tagged…</button></p>`
    }
    <div class="inventory__scroll"><table class="inventory__table">
      <thead><tr><th></th><th>Product</th><th>SKU</th>
        <th class="num" title="Shopify on-hand for this bin; brackets show tagged-vs-expected">Expected</th>
        <th class="num" title="Units whose tag records say this bin">Tagged here</th>
        <th class="num" title="Units whose tags answered this sweep">Seen</th>
        <th></th></tr></thead>
      <tbody>${
        cells ||
        `<tr><td colspan="7">${
          untaggedCount
            ? "Nothing on this shelf is tagged yet."
            : `Nothing expected or tagged in ${escapeHtml(rep.bin)}.`
        }</td></tr>`
      }</tbody>
    </table></div>
    ${
      untaggedCount
        ? `<div class="linkbox__actions" style="margin-top:8px">
             <button class="reset" id="binaudit-toggle" type="button">${
               binAuditShowUntagged ? "Hide" : "Show"
             } ${untaggedCount} product(s) with no tags here</button>
           </div>`
        : ""
    }
    ${
      strays || unknowns
        ? `<div class="recent__head" style="margin-top:14px"><h2>Also heard on this shelf (${rep.foreign.length + rep.unknown_epcs.length})</h2></div>
           <ul class="recent__list">${strays}${unknowns}</ul>`
        : `<p class="result">No stray or unknown tags in the sweep.</p>`
    }`;
}

// One delegated handler for the whole panel — the report re-renders on
// every toggle and every write, so per-element listeners would go stale.
document
  .getElementById("binaudit-report")
  .addEventListener("click", async (e) => {
    const open = e.target.closest(".prodopen, .skulink");
    if (open && open.dataset.sku) {
      openProductHistory(open.dataset.sku);
      return;
    }
    if (e.target.closest("#binaudit-toggle")) {
      binAuditShowUntagged = !binAuditShowUntagged;
      renderBinAudit();
      return;
    }
    // Increase-only on-hand write, same contract as the verify table's
    // button: confirmed, logged, undoable from History.
    const fix = e.target.closest(".binaudit-fix");
    if (fix) {
      const sku = fix.dataset.sku;
      const qty = parseInt(fix.dataset.qty, 10);
      if (
        !confirm(
          `Set Shopify ON-HAND for ${sku} to ${qty}?\n\n` +
            `Shopify expects ${fix.dataset.exp}; this bin holds ${qty} ` +
            `tagged unit(s).\n\nThis WRITES the number to Shopify. Undo ` +
            `stays available in History.`
        )
      )
        return;
      fix.disabled = true;
      try {
        const res = await postJson("/api/onhand-updates", {
          sku,
          new_qty: qty,
          changed_by: operatorEl.value || null,
          confirmed: true,
        });
        alert(res.message);
        document.getElementById("binaudit-run").click();
      } catch (err) {
        alert(err.message);
        fix.disabled = false;
      }
      return;
    }
    const mark = e.target.closest("#binaudit-marktagged");
    if (mark && binAudit) {
      const bin = binAudit.rep.bin;
      mark.disabled = true;
      try {
        // Unconfirmed first: the server answers 409 with the exact
        // consequence text, which becomes the confirmation.
        await postJson(`/api/bins/${encodeURIComponent(bin)}/mark-tagged`, {
          created_by: operatorEl.value || null,
        });
      } catch (err) {
        if (!/Confirm to record it/.test(err.message)) {
          alert(err.message);
          mark.disabled = false;
          return;
        }
        if (!confirm(err.message)) {
          mark.disabled = false;
          return;
        }
        try {
          const res = await postJson(
            `/api/bins/${encodeURIComponent(bin)}/mark-tagged`,
            { created_by: operatorEl.value || null, confirmed: true }
          );
          alert(res.message);
          document.getElementById("binaudit-run").click();
          loadAuditBins();
        } catch (err2) {
          alert(err2.message);
          mark.disabled = false;
        }
      }
    }
  });

async function loadAuditBins() {
  const list = document.getElementById("audit-bins");
  list.innerHTML = '<li class="recent__empty">Comparing…</li>';
  try {
    auditData = await apiJson("/api/audit/bins");
    renderAuditBins();
  } catch (err) {
    list.innerHTML = `<li class="recent__empty">${escapeHtml(err.message)}</li>`;
  }
}

document.getElementById("audit-untagged").addEventListener("click", () => {
  auditShowUntagged = !auditShowUntagged;
  renderAuditBins();
});
document
  .getElementById("audit-reload")
  .addEventListener("click", async (ev) => {
    const stopDots = startDots(ev.currentTarget, "Reloading");
    try {
      await loadAuditBins();
    } finally {
      stopDots();
    }
  });
let auditFilterTimer;
document.getElementById("audit-filter").addEventListener("input", () => {
  clearTimeout(auditFilterTimer);
  auditFilterTimer = setTimeout(renderAuditBins, 150);
});
// Full re-read of bins + on-hand from Shopify (~a minute in the
// background), then the list reloads itself when the walk finishes.
document.getElementById("audit-refresh").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  const stopDots = startDots(btn, "Refreshing from Shopify (about a minute)");
  try {
    await postJson("/api/bin-map/refresh", {});
    const poll = setInterval(async () => {
      try {
        const s = await apiJson("/api/bin-map/status");
        if (!s.refreshing) {
          clearInterval(poll);
          stopDots();
          btn.disabled = false;
          loadAuditBins();
        }
      } catch {
        clearInterval(poll);
        stopDots();
        btn.disabled = false;
      }
    }, 5000);
  } catch (err) {
    stopDots();
    btn.disabled = false;
    setResult(err.message, "err");
  }
});

async function loadAudits() {
  loadAuditBins();
  const list = document.getElementById("audit-list");
  try {
    const { tasks } = await apiJson("/api/review-tasks?status=open&limit=100");
    // Biggest single-product mismatch first — the size is parsed out of
    // the task's own wording ("N unit(s) counted but Shopify on-hand is
    // M"); anything unparsable sorts last rather than lying.
    const checks = tasks
      .filter((t) => t.category === "inventory-check")
      .map((t) => {
        const m = /(\d+)\s+unit\(s\).*?on-hand is (\d+)/.exec(t.detail || "");
        return { ...t, mismatch: m ? Math.abs(+m[1] - +m[2]) : 0 };
      })
      .sort(
        (a, b) =>
          b.mismatch - a.mismatch ||
          String(b.created_at || "").localeCompare(String(a.created_at || ""))
      );
    list.innerHTML = checks.length
      ? ""
      : '<li class="recent__empty">No product checks recommended right now.</li>';
    checks.forEach((t) => {
      // [Bin chip] [Product name] ......... [mismatch chip] [N days ago]
      const binMatch = /^Bin\s+([^:]+):/.exec(t.detail || "");
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="inventory__bin">${escapeHtml(binMatch ? binMatch[1] : "—")}</span>
        <span class="recent__prod" title="${escapeHtml(t.detail)}"><b>${escapeHtml(t.product_title || t.sku || "")}</b></span>
        <span class="audit-mm" title="${escapeHtml(t.detail)}">${t.mismatch || "?"}</span>
        <span class="recent__meta recent__when" title="${escapeHtml(fmtWhen(t.created_at))}">${escapeHtml(fmtAgo(t.created_at))}</span>`;
      list.append(li);
    });
  } catch (err) {
    list.innerHTML = '<li class="recent__empty">Could not load.</li>';
  }
  const sweeps = document.getElementById("sweep-list");
  try {
    const { captures } = await apiJson("/api/epc-captures?limit=10");
    sweeps.innerHTML = "";
    if (!captures.length) {
      sweeps.innerHTML =
        '<li class="recent__empty">No sweeps from the C72 app yet.</li>';
      return;
    }
    captures.forEach((c) => {
      const li = document.createElement("li");
      li.innerHTML = `
        ${evChip("sweep")}
        <span class="recent__prod"><b>#${c.id} · ${c.epc_count} tags</b> from ${escapeHtml(c.device || "C72")}${c.note ? " — " + escapeHtml(c.note) : ""}</span>
        <span class="recent__meta recent__when">${escapeHtml(fmtAgo(c.created_at))}</span>`;
      sweeps.append(li);
    });
  } catch (err) {
    sweeps.innerHTML = '<li class="recent__empty">Could not load sweeps.</li>';
  }
}

// === History tab ============================================================
let historyEvents = [];

async function loadHistory() {
  const body = document.getElementById("hist-body");
  try {
    const { events } = await apiJson("/api/history?limit=200");
    historyEvents = events;
    renderHistory();
  } catch (err) {
    body.innerHTML =
      '<tr><td colspan="7" class="inventory__empty">Could not load history.</td></tr>';
  }
}

function renderHistory() {
  const body = document.getElementById("hist-body");
  const q = document.getElementById("hist-search").value.trim().toLowerCase();
  const rows = q
    ? historyEvents.filter((e) =>
        [e.type, e.worker, e.sku, e.title, e.detail]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : historyEvents;
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="inventory__empty">No events yet.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((e, i) => {
      // Sweep events fold their EPCs behind an expander: the row reads
      // "4 × RFID tag", the tags themselves are one click away.
      const exp =
        e.epcs && e.epcs.length
          ? ` <a href="#" class="hist-exp" data-idx="${i}" data-n="${e.epcs.length}">▸ show EPCs</a>`
          : "";
      const sub =
        e.epcs && e.epcs.length
          ? `<tr class="hist-epcrow" data-for="${i}" hidden><td colspan="7"><div class="hist-epclist">${e.epcs
              .map((x) => `<div class="mono">${escapeHtml(x || "?")}</div>`)
              .join("")}</div></td></tr>`
          : "";
      return `<tr>
      <td class="recent__meta" style="white-space:nowrap">${escapeHtml(fmtWhen(e.at))}</td>
      <td>${evChip(e.type)}</td>
      <td>${escapeHtml(e.worker || "—")}</td>
      <td class="mono">${
        e.sku
          ? `<a href="#" class="hist-sku" data-sku="${escapeHtml(e.sku)}">${escapeHtml(e.sku)}</a>`
          : "—"
      }</td>
      <td>${
        e.sku && e.title
          ? `<span class="prodopen hist-prod" data-sku="${escapeHtml(e.sku)}">${escapeHtml(e.title)}</span>`
          : escapeHtml(e.title || "—")
      }</td>
      <td class="recent__meta">${escapeHtml(e.detail || "")}${exp}</td>
      <td>${
        e.undo
          ? `<button class="reset hist-undo" data-idx="${i}" type="button">Undo</button>`
          : ""
      }</td>
    </tr>${sub}`;
    })
    .join("");
  body.querySelectorAll(".hist-undo").forEach((btn) => {
    btn.addEventListener("click", () => undoHistoryEvent(rows[+btn.dataset.idx], btn));
  });
  body.querySelectorAll(".hist-exp").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const sub = body.querySelector(
        `tr.hist-epcrow[data-for="${a.dataset.idx}"]`
      );
      if (!sub) return;
      sub.hidden = !sub.hidden;
      a.textContent = sub.hidden ? "▸ show EPCs" : "▾ hide EPCs";
    });
  });
  body.querySelectorAll(".hist-sku, .hist-prod").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      openProductHistory(a.dataset.sku);
    });
  });
}

// --- Per-product history: the full paper trail for one SKU/barcode, each
// event marked whether it touched Shopify or only this system. Counts are
// observations — nothing here writes stock numbers anywhere. Opens as a
// modal so it works from History AND Print queue; serialized products can
// edit their preferred label name here, and any product can print labels.
let phistData = null;

async function openProductHistory(term) {
  const overlay = document.getElementById("phist-overlay");
  const body = document.getElementById("phist-body");
  const termBox = document.getElementById("phist-term");
  if (termBox) termBox.value = term;
  overlay.hidden = false;
  phistData = null;
  document.getElementById("phist-msg").textContent = "";
  document.getElementById("phist-serial").hidden = true;
  body.innerHTML =
    '<tr><td colspan="5" class="inventory__empty">Loading…</td></tr>';
  try {
    const data = await apiJson(
      `/api/product-history?term=${encodeURIComponent(term)}`
    );
    phistData = data;
    const p = data.product;
    // Preferred-name editor for EVERY cataloged product: serialized brands
    // write through their serial record; everything else uses the per-SKU
    // label-name store. Blank = standard "Telescopes Canada" header.
    if (p) {
      document.getElementById("phist-serial").hidden = false;
      // Two-box prefill from what's SAVED — cancelling any edit leaves no
      // trace. Serialized products edit the top line through their serial
      // record and keep a standard SKU line, so that box locks for them.
      const serial = !!data.serial_prefix;
      phistDefaults = { top: STORE_HEADER, sku: data.sku || "" };
      let top = STORE_HEADER;
      let skuLine = data.sku || "";
      if (serial) {
        top = phistEffectiveName() || data.serial_label || "";
      } else if (data.custom_label) {
        if (data.custom_placement !== "sku") top = data.custom_label;
        if (data.custom_sku_text) skuLine = data.custom_sku_text;
        else if (
          data.custom_placement === "sku" ||
          data.custom_placement === "both"
        )
          skuLine = data.custom_label;
      }
      document.getElementById("phist-top").value = top;
      const skuBox = document.getElementById("phist-skuline");
      skuBox.value = skuLine;
      skuBox.disabled = serial;
      document.getElementById("phist-top-reset").hidden = serial;
      document.getElementById("phist-skuline-reset").hidden = serial;
      document.getElementById("phist-label-hint").textContent = serial
        ? "Serialized product — the top line is its item name, printed " +
          "on every label including Scan Station auto-prints. The SKU " +
          "line stays standard:"
        : "Edit the two label lines — saved store-wide, every future " +
          "print uses them. ✕ resets a line to its default:";
      updateLabelPreview();
    }
    renderNoScan(!!data.rfid_incompatible);
    // Multi-box/bundle standing. Only shown when an answer was actually
    // saved — an auto-detected product has nothing to undo.
    const kindBox = document.getElementById("phist-kind");
    const pk = data.product_kind;
    kindBox.hidden = !pk;
    if (pk) {
      const who = pk.updated_by ? ` by ${pk.updated_by}` : "";
      const when = pk.updated_at
        ? ` on ${tsDate(pk.updated_at).toLocaleString()}`
        : "";
      kindBox.classList.toggle("kindrow--bundle", pk.kind === "bundle");
      document.getElementById("phist-kind-what").textContent = pk.excluded
        ? `Dropped from the RFID system${who}${when} — it isn't seeded into ` +
          `new batches and never gets a label.`
        : pk.kind === "bundle"
          ? `Marked as a bundle${who}${when} — no labels print for it; its ` +
            `component products carry the tags.`
          : `Marked as a multi-box product${who}${when} — one label per box.`;
    }
    document.getElementById("phist-print").disabled = !p;
    document.getElementById("phist-title").textContent = p
      ? p.product_title + (p.variant_title ? ` (${p.variant_title})` : "")
      : `(not in the catalog) ${term}`;
    document.getElementById("phist-meta").textContent =
      `SKU: ${data.sku || "—"} · Barcode: ${data.barcode || "—"}` +
      (p ? ` · Bin: ${p.bin_location || "—"}` : "") +
      ` · ${data.tag_count} tag(s) on file` +
      (data.on_hand != null ? ` · on-hand ${data.on_hand}` : "");
    const img = document.getElementById("phist-img");
    if (data.image_url) {
      img.src = data.image_url;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
    }
    if (!data.events.length) {
      body.innerHTML =
        '<tr><td colspan="5" class="inventory__empty">No recorded events for this product yet.</td></tr>';
      return;
    }
    body.innerHTML = data.events
      .map(
        (e) => `<tr>
        <td class="recent__meta" style="white-space:nowrap">${escapeHtml(fmtWhen(e.at))}</td>
        <td>${evChip(e.type)}</td>
        <td>${escapeHtml(e.worker || "—")}</td>
        <td class="recent__meta">${escapeHtml(e.detail || "")}</td>
        <td>${
          e.shopify
            ? '<span class="chip-status chip-status--done">Shopify ✓</span>'
            : '<span class="chip-status chip-status--pending">local</span>'
        }</td>
      </tr>`
      )
      .join("");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="inventory__empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById("phist-open").addEventListener("click", () => {
  const term = document.getElementById("phist-term").value.trim();
  if (term) openProductHistory(term);
});
document.getElementById("phist-term").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const term = e.target.value.trim();
    if (term) openProductHistory(term);
  }
});
document.getElementById("phist-close").addEventListener("click", () => {
  document.getElementById("phist-overlay").hidden = true;
});
document.getElementById("phist-overlay").addEventListener("click", (e) => {
  if (e.target.id === "phist-overlay")
    document.getElementById("phist-overlay").hidden = true;
});

// Defaults for the panel's two label boxes, captured per product on open.
let phistDefaults = { top: "Telescopes Canada", sku: "" };

function phistEffectiveName() {
  if (!phistData) return null;
  if (phistData.serial_prefix)
    return phistData.serial_label_saved ? phistData.serial_label : null;
  return phistData.custom_label;
}

// Miniature sticker mirrors the agent's real layout, including the
// smaller font tiers long names trigger — plus the same fit check the
// reprint dialog runs, so bad text is flagged (never blocked) here too.
function updateLabelPreview() {
  if (!phistData) return;
  const p = phistData.product || {};
  const top =
    document.getElementById("phist-top").value.trim() || STORE_HEADER;
  const skuLine =
    document.getElementById("phist-skuline").value.trim() ||
    phistDefaults.sku;
  const el = document.getElementById("phist-prev-header");
  el.textContent = top;
  el.className =
    "label-preview__header " +
    (top === STORE_HEADER || top.length <= 26
      ? "label-preview__header--lg"
      : top.length <= 56
        ? "label-preview__header--md"
        : "label-preview__header--sm");
  document.getElementById("phist-prev-sku").textContent = skuLine || "—";
  document.getElementById("phist-prev-bc").textContent =
    p.barcode || p.sku || phistData.barcode || "";
  document.getElementById("phist-prev-bin").textContent =
    "BIN: " + (p.bin_location || "—");
  const issues = labelFitIssues(top, skuLine);
  const warn = document.getElementById("phist-fitwarn");
  warn.hidden = !issues.length;
  warn.textContent = issues.length
    ? "⚠ " + issues.join("\n⚠ ") +
      "\nYou can still print — this is a warning, not a block."
    : "";
}

document
  .getElementById("phist-top")
  .addEventListener("input", updateLabelPreview);
document
  .getElementById("phist-skuline")
  .addEventListener("input", updateLabelPreview);
document.getElementById("phist-top-reset").addEventListener("click", () => {
  document.getElementById("phist-top").value = phistDefaults.top;
  updateLabelPreview();
});
document
  .getElementById("phist-skuline-reset")
  .addEventListener("click", () => {
    document.getElementById("phist-skuline").value = phistDefaults.sku;
    updateLabelPreview();
  });

// Won't-RFID-scan flag: add OR remove, always offered for a cataloged
// product. Labels still print and pairing still counts — sweeps just stop
// expecting an answer. Every flip is logged.
function renderNoScan(flagged) {
  const row = document.getElementById("phist-norfid");
  if (!phistData || !phistData.product || !phistData.sku) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  phistData.rfid_incompatible = flagged;
  document.getElementById("phist-norfid-what").innerHTML = flagged
    ? '<span class="noscan-chip">⊘ won\'t RFID scan</span> tag won\'t ' +
      "scan when on box — sweeps and Verify don't expect it to answer."
    : "RFID OK — sweeps expect this product's tags to answer. If a tag " +
      "reads in hand but never on the box, flag it:";
  document.getElementById("phist-norfid-btn").textContent = flagged
    ? "Remove flag"
    : "Flag: won't RFID scan";
}

document
  .getElementById("phist-norfid-btn")
  .addEventListener("click", async () => {
    if (!phistData || !phistData.sku) return;
    const want = !phistData.rfid_incompatible;
    const msg = document.getElementById("phist-msg");
    try {
      await apiJson(
        `/api/products/${encodeURIComponent(phistData.sku)}/rfid-incompatible`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            incompatible: want,
            changed_by: operatorEl.value || null,
          }),
        }
      );
      renderNoScan(want);
      msg.textContent = want
        ? "Flagged ⊘ — logged; sweeps stop expecting this product to answer."
        : "Flag removed ✓ — logged; sweeps expect it again.";
    } catch (err) {
      msg.textContent = err.message;
    }
  });

// Label save — serialized products write the top line through their
// serial record (Scan Station auto-prints use it too); everything else
// saves both lines to the per-SKU label store. Lines left at their
// defaults mean "standard label".
document.getElementById("phist-label-save").addEventListener("click", async () => {
  if (!phistData) return;
  const msg = document.getElementById("phist-msg");
  const top = document.getElementById("phist-top").value.trim();
  const skuLine = document.getElementById("phist-skuline").value.trim();
  try {
    if (phistData.serial_prefix) {
      if (!top || top === STORE_HEADER) {
        msg.textContent =
          "Serialized products need a name — shorten it instead of clearing.";
        return;
      }
      await apiJson(
        `/api/serial-prefixes/${encodeURIComponent(phistData.serial_prefix)}/label`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label_name: top }),
        }
      );
      phistData.serial_label = top;
      phistData.serial_label_saved = true;
    } else {
      const res = await apiJson(
        `/api/label-names/${encodeURIComponent(phistData.sku)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            top_text: top || STORE_HEADER,
            sku_line: skuLine || phistDefaults.sku,
            updated_by: operatorEl.value || null,
          }),
        }
      );
      phistData.custom_label = res.label_name;
      phistData.custom_placement = res.placement || "header";
      phistData.custom_sku_text = res.sku_text || null;
    }
    updateLabelPreview();
    msg.textContent = "Label saved ✓ — new prints use it.";
  } catch (err) {
    msg.textContent = err.message;
  }
});

// Print fresh labels for this product right from the panel (each gets a
// new EPC; they land in the Print queue like any other job).
document.getElementById("phist-print").addEventListener("click", async () => {
  const msg = document.getElementById("phist-msg");
  if (!phistData || !phistData.product) return;
  const operator = requireOperator();
  if (!operator) {
    msg.textContent = "Pick who's scanning (top right) first.";
    return;
  }
  const qty = Math.max(
    1,
    Math.min(50, Number(document.getElementById("phist-qty").value) || 1)
  );
  const p = phistData.product;
  const btn = document.getElementById("phist-print");
  btn.disabled = true;
  msg.textContent = "Queueing…";
  try {
    const res = await apiFetch("/api/print-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: qty,
        shopify_variant_id: p.shopify_variant_id,
        shopify_product_id: p.shopify_product_id,
        product_title: p.product_title,
        variant_title: p.variant_title,
        sku: p.sku,
        barcode: p.barcode,
        bin_location: p.bin_location,
        label_name: phistEffectiveName(),
        label_placement: phistEffectiveName()
          ? phistData.serial_prefix
            ? "header"
            : phistData.custom_placement || "header"
          : null,
        requested_by: operator,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      msg.textContent = body.detail || "Queueing failed.";
    } else {
      msg.textContent = `${qty} label(s) queued ✓ — collect at the printer (Print queue tab tracks them).`;
    }
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document
  .getElementById("phist-kind-restore")
  .addEventListener("click", async () => {
    if (!phistData || !phistData.sku) return;
    const pk = phistData.product_kind || {};
    if (
      !confirm(
        pk.excluded
          ? `Put "${phistData.sku}" back into the RFID system?\n\nIt will ` +
            `be seeded into new batches again and detected automatically.`
          : `Clear the manual setting for "${phistData.sku}"?\n\nIt goes ` +
            `back to being detected automatically from its title and SKU.`
      )
    )
      return;
    const msg = document.getElementById("phist-msg");
    try {
      const res = await postJson("/api/product-kinds", {
        sku: phistData.sku,
        kind: null,
        updated_by: operatorEl.value.trim() || null,
      });
      // Reload first — it clears the message slot — then say what happened.
      await openProductHistory(phistData.sku);
      msg.textContent = res.message;
    } catch (err) {
      msg.textContent = err.message;
    }
  });

// Undoable events carry an `undo` descriptor from the server. Today that's
// barcode links (alias rows are live, so deleting one IS the undo — the
// scanned code simply stops resolving to that product).
async function undoHistoryEvent(e, btn) {
  if (!e || !e.undo) return;
  // Resolved/dismissed review tasks: undo = reopen — the task returns to
  // the Review inbox and this resolution entry leaves History (the task
  // is simply open again, as if never closed).
  if (e.undo.kind === "review-reopen") {
    if (
      !confirm(
        `Reopen this review task?\n\n${e.title || e.sku || ""} — it goes ` +
          `back to the Review inbox, as if it was never closed.`
      )
    )
      return;
    btn.disabled = true;
    try {
      await postJson(`/api/review-tasks/${e.undo.task_id}/reopen`, {});
      await loadHistory();
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
    return;
  }
  // On-hand corrections: two-phase undo. The unconfirmed call answers
  // with exactly what will happen — including the CURRENT live value, in
  // case something else moved the number since — and that text IS the
  // confirmation prompt.
  if (e.undo.kind === "on-hand") {
    btn.disabled = true;
    try {
      await postJson(`/api/onhand-updates/${e.undo.change_id}/undo`, {
        changed_by: operatorEl.value || null,
      });
      await loadHistory();
    } catch (err) {
      const msg = String(err.message || "");
      if (!msg.includes("Confirm to write it")) {
        btn.disabled = false;
        alert(msg);
        return;
      }
      if (!confirm(msg)) {
        btn.disabled = false;
        return;
      }
      try {
        const res = await postJson(
          `/api/onhand-updates/${e.undo.change_id}/undo`,
          { changed_by: operatorEl.value || null, confirmed: true }
        );
        await loadHistory();
        alert(res.message);
      } catch (err2) {
        btn.disabled = false;
        alert(err2.message);
      }
    }
    return;
  }
  // Batch events: release every tag tie that batch created, in one go.
  if (e.undo.kind === "batch-ties") {
    if (
      !confirm(
        `Release all ${e.undo.ties} tag tie(s) from batch #${e.undo.batch_id} ` +
          `(${e.title})?\n\nThe products stop being tied to those labels. ` +
          `Nothing in Shopify changes, and the labels themselves stay valid.`
      )
    )
      return;
    btn.disabled = true;
    try {
      const res = await postJson(
        `/api/batches/${e.undo.batch_id}/unpair-all`,
        {}
      );
      await loadHistory();
      alert(
        `${res.removed} tie(s) released` +
          (res.legacy
            ? ` (${res.legacy} of them paired before batches tracked their own ties).`
            : ".")
      );
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
    return;
  }
  // Multi-box/bundle decisions: undo means handing the product back to
  // automatic detection, which also un-drops it if it was excluded.
  if (e.undo.kind === "product-kind") {
    const what = e.undo.excluded
      ? `Put "${e.sku}" back into the RFID system?\n\nIt will be seeded ` +
        `into new batches again and detected automatically.`
      : `Clear the manual multi-box/bundle setting for "${e.sku}"?\n\n` +
        `It goes back to being detected automatically from its title ` +
        `and SKU.`;
    if (!confirm(what)) return;
    btn.disabled = true;
    try {
      const res = await postJson("/api/product-kinds", {
        sku: e.undo.sku,
        kind: null,
        updated_by: operatorEl.value.trim() || null,
      });
      await loadHistory();
      alert(res.message);
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
    return;
  }
  if (e.undo.kind !== "barcode-alias") return;
  const alias = e.undo.alias_barcode;
  const target = e.sku || e.title || "that product";
  if (
    !confirm(
      `Undo this barcode link?\n\n${alias} → ${target}\n\nThe scanned ` +
        `barcode will stop resolving to this product. You can re-link it ` +
        `(to the right product) at the Scan Station.`
    )
  )
    return;
  btn.disabled = true;
  const res = await apiFetch(
    `/api/barcode-aliases/${encodeURIComponent(alias)}`,
    { method: "DELETE" }
  );
  if (res.ok || res.status === 404) {
    await loadHistory();
  } else {
    btn.disabled = false;
    alert("Could not undo that link — try again.");
  }
}

let histSearchTimer;
document.getElementById("hist-search").addEventListener("input", () => {
  clearTimeout(histSearchTimer);
  histSearchTimer = setTimeout(renderHistory, 150);
});

// Boot
resetStation();
loadRecent();
