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
  activate("barcode");
}

// --- Step 1: barcode -> Shopify lookup -------------------------------------
el.barcode.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const barcode = el.barcode.value.trim();
  if (!barcode) return;

  setResult("Looking up product…", "busy");
  try {
    const res = await apiFetch(
      `/api/products/by-barcode/${encodeURIComponent(barcode)}`
    );
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      const info =
        body.detail && typeof body.detail === "object" ? body.detail : null;
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
});

function acceptProduct(product, message) {
  pendingProduct = product;
  autoPrintedThisScan = false;
  closeLinkbox();
  showProduct(product);
  showSerialPanel(product);
  setResult(message, "ok");
  activate("rfid");
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
    (p.source === "telcan" ? "TELCAN" : p.source === "shopify" ? "Shopify" : "—") +
    (p.serial_brand ? ` · ${p.serial_brand} serial` : "");
  el.productCard.hidden = false;
  el.printPanel.hidden = !printingEnabled;
  loadTags(p);
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
    if (saved.suspect || !el.autoReset.checked) {
      // Keep the product loaded (bulk mode, or so a flagged tag can be
      // re-scanned immediately).
      el.rfid.value = "";
      el.rfid.focus();
      loadTags(pendingProduct);
    } else {
      // One tag per product: brief confirmation, then back to the barcode.
      setTimeout(resetStation, 700);
    }
  } catch (err) {
    setResult("Network error while saving the RFID tag.", "err", "rfid");
  }
});

// --- Recent list -----------------------------------------------------------
function recentRow(a) {
  const li = document.createElement("li");
  li.dataset.rfid = a.rfid_id;
  const when = a.assigned_at
    ? new Date(a.assigned_at).toLocaleString(undefined, {
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

async function loadInventory() {
  const body = document.getElementById("inv-body");
  try {
    const res = await apiFetch("/api/inventory/summary");
    if (!res.ok) {
      body.innerHTML =
        '<tr><td colspan="6" class="inventory__empty">Could not load inventory.</td></tr>';
      return;
    }
    inventoryRows = (await res.json()).products;
    renderInventory();
  } catch (err) {
    body.innerHTML =
      '<tr><td colspan="6" class="inventory__empty">Network error.</td></tr>';
  }
}

function renderInventory() {
  const body = document.getElementById("inv-body");
  const q = document.getElementById("inv-search").value.trim().toLowerCase();
  const rows = q
    ? inventoryRows.filter((p) =>
        [p.product_title, p.variant_title, p.sku, p.barcode, p.bin_location]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : inventoryRows;
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="inventory__empty">No products yet — assign or print a first tag.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((p) => {
      const title =
        escapeHtml(p.product_title || "") +
        (p.variant_title
          ? ` <span class="inventory__variant">(${escapeHtml(p.variant_title)})</span>`
          : "");
      const when = p.last_assigned_at
        ? new Date(p.last_assigned_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "—";
      return `<tr>
        <td>${title}</td>
        <td class="mono">${escapeHtml(p.sku || "—")}</td>
        <td>${p.bin_location && p.bin_location !== "No bin assigned"
          ? `<span class="inventory__bin">${escapeHtml(p.bin_location)}</span>`
          : "—"}</td>
        <td class="num">${p.tag_count}</td>
        <td class="num">${p.shopify_qty ?? "—"}</td>
        <td>${escapeHtml(when)}</td>
      </tr>`;
    })
    .join("");
}

let invSearchTimer;
document.getElementById("inv-search").addEventListener("input", () => {
  clearTimeout(invSearchTimer);
  invSearchTimer = setTimeout(renderInventory, 150);
});

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
    ? new Date(iso).toLocaleString(undefined, {
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
let labelIndex = 0;
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
  labelCount: document.getElementById("blabel-count"),
  labelImg: document.getElementById("blabel-img"),
  labelTitle: document.getElementById("blabel-title"),
  labelSku: document.getElementById("blabel-sku"),
  labelQty: document.getElementById("blabel-qty"),
  labelExpected: document.getElementById("blabel-expected"),
  labelName: document.getElementById("blabel-name"),
  labelSave: document.getElementById("blabel-save"),
  labelPrev: document.getElementById("blabel-prev"),
  labelNext: document.getElementById("blabel-next"),
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
  if (batch) {
    showBatchStage(batchStage);
    return;
  }
  bEl.start.hidden = false;
  bEl.active.hidden = true;
  loadResumeList();
  bEl.bin.focus();
}

async function loadResumeList() {
  try {
    const { batches } = await apiJson("/api/batches?status=open&limit=10");
    bEl.resumeList.innerHTML = "";
    bEl.resumeWrap.hidden = !batches.length;
    batches.forEach((b) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<b>Bin ${escapeHtml(b.bin_name)}</b> — ${b.products} product(s), ` +
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

bEl.create.addEventListener("click", startBatch);
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
    batchItems = [];
    bEl.bin.value = "";
    openBatchView("collect");
  } catch (err) {
    setBatchResult(err.message, "err");
  } finally {
    bEl.create.disabled = false;
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

function openBatchView(stage) {
  bEl.start.hidden = true;
  bEl.active.hidden = false;
  bEl.binChip.textContent = `Bin ${batch.bin_name}`;
  setBatchResult("", null);
  showBatchStage(stage);
}

const BATCH_STAGES = ["collect", "labels", "print", "pair", "verify"];

function showBatchStage(stage) {
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
  if (stage === "collect") {
    renderBatchItems();
    bEl.scan.focus();
  } else if (stage === "labels") {
    labelIndex = Math.min(labelIndex, labelItems().length - 1);
    if (labelIndex < 0) labelIndex = 0;
    renderLabelCard();
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
}

function stopBatchPrintPoll() {
  if (batchPrintTimer) {
    clearInterval(batchPrintTimer);
    batchPrintTimer = null;
  }
}

bEl.abandon.addEventListener("click", async () => {
  if (!batch) return;
  if (!confirm(`Abandon the batch for bin ${batch.bin_name}? Collected counts are kept in History but the batch closes.`)) return;
  try {
    await postJson(`/api/batches/${batch.id}/abandon`, {});
  } catch (err) {
    /* already closed is fine */
  }
  batch = null;
  batchItems = [];
  stopBatchPrintPoll();
  enterBatchTab();
});

// --- Stage 1: collect -------------------------------------------------------
bEl.scan.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const code = bEl.scan.value.trim();
  bEl.scan.value = "";
  if (!code || !batch) return;
  setBatchResult("Looking up…", "busy");
  try {
    const data = await postJson(`/api/batches/${batch.id}/scan`, { code });
    const item = data.item;
    const existing = batchItems.findIndex((i) => i.id === item.id);
    if (existing >= 0) batchItems[existing] = item;
    else batchItems.push(item);
    if (data.bin_mismatch) item._binMismatch = true;
    renderBatchItems();
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
    } else {
      setBatchResult(
        `${itemDisplayName(item)} — ${item.qty_scanned} scanned` +
          (item.expected_qty != null
            ? ` (Shopify on-hand ${item.expected_qty})`
            : ""),
        "ok"
      );
    }
  } catch (err) {
    setBatchResult(err.message, "err");
  }
  bEl.scan.focus();
});

function renderBatchItems() {
  bEl.items.innerHTML = "";
  batchItems.forEach((item) => {
    const li = document.createElement("li");
    if (!item.resolved) li.classList.add("warn");
    const expected =
      item.expected_qty != null
        ? `<span class="bexp${
            item.qty_scanned !== item.expected_qty ? " bexp--off" : ""
          }">${item.qty_scanned} / ${item.expected_qty} on hand</span>`
        : "";
    li.innerHTML = `
      <span class="recent__prod"><b>${escapeHtml(itemDisplayName(item))}</b></span>
      <span class="mono recent__meta">${escapeHtml(item.sku || item.scanned_code || "")}</span>
      ${expected}
      <span class="bqty">
        <button type="button" data-d="-1">−</button>
        <span class="bqty__n">${item.qty_scanned}</span>
        <button type="button" data-d="1">+</button>
      </span>`;
    li.querySelectorAll(".bqty button").forEach((btn) =>
      btn.addEventListener("click", () =>
        adjustItemQty(item, item.qty_scanned + Number(btn.dataset.d))
      )
    );
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
    }
    bEl.items.append(li);
  });
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
    setBatchResult("Nothing to label yet — scan at least one known product.", "err");
    return;
  }
  labelIndex = 0;
  showBatchStage("labels");
});

// --- Stage 2: labels --------------------------------------------------------
function labelItems() {
  return batchItems.filter((i) => i.resolved && i.qty_scanned > 0);
}

function renderLabelCard() {
  const items = labelItems();
  const item = items[labelIndex];
  if (!item) return;
  bEl.labelCount.textContent = `Product ${labelIndex + 1} of ${items.length}`;
  bEl.labelTitle.textContent =
    (item.product_title || "—") +
    (item.variant_title ? ` (${item.variant_title})` : "");
  bEl.labelSku.textContent = item.sku || "—";
  bEl.labelQty.textContent = `${item.qty_scanned} → ${item.qty_scanned} label(s)`;
  bEl.labelExpected.textContent =
    item.expected_qty != null ? String(item.expected_qty) : "—";
  bEl.labelName.value = item.label_name || item.product_title || "";
  if (item.image_url) {
    bEl.labelImg.src = item.image_url;
    bEl.labelImg.hidden = false;
  } else {
    bEl.labelImg.hidden = true;
    bEl.labelImg.removeAttribute("src");
  }
  bEl.labelPrev.disabled = labelIndex === 0;
  bEl.labelNext.disabled = labelIndex >= items.length - 1;
  bEl.labelSave.textContent = "Save name";
}

async function saveBatchLabelName() {
  const item = labelItems()[labelIndex];
  const name = bEl.labelName.value.trim();
  if (!item || !name) return;
  try {
    const updated = await apiJson(
      `/api/batches/${batch.id}/items/${item.id}/label`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label_name: name }),
      }
    );
    Object.assign(item, updated);
    bEl.labelSave.textContent = "Saved ✓";
    setTimeout(() => (bEl.labelSave.textContent = "Save name"), 1500);
  } catch (err) {
    setBatchResult(err.message, "err");
  }
}

bEl.labelSave.addEventListener("click", saveBatchLabelName);
bEl.labelName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBatchLabelName();
});
bEl.labelPrev.addEventListener("click", () => {
  if (labelIndex > 0) {
    labelIndex--;
    renderLabelCard();
  }
});
bEl.labelNext.addEventListener("click", () => {
  if (labelIndex < labelItems().length - 1) {
    labelIndex++;
    renderLabelCard();
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
  return (
    batchItems.find(
      (i) =>
        i.resolved &&
        ((i.barcode && i.barcode.toLowerCase() === low) ||
          (i.sku && i.sku.toLowerCase() === low) ||
          (i.scanned_code && i.scanned_code.toLowerCase() === low))
    ) ||
    (/^\d{5,12}$/.test(code)
      ? batchItems.find(
          (i) => i.resolved && i.serial_prefix === code.slice(0, 4)
        )
      : null)
  );
}

function renderPairCard() {
  const item = batchItems.find((i) => i.id === pairActiveItemId);
  bEl.pairCard.hidden = !item;
  if (!item) return;
  bEl.pairActive.textContent = itemDisplayName(item);
  bEl.pairProgress.textContent = `${item.paired_count} of ${item.qty_scanned} tags paired · ${Math.max(
    0,
    item.qty_scanned - item.paired_count
  )} remaining`;
  bEl.pairUndo.disabled = !pairHistory.length;
}

function renderPairItems() {
  bEl.pairItems.innerHTML = "";
  batchItems
    .filter((i) => i.resolved && i.qty_scanned > 0)
    .forEach((item) => {
      const li = document.createElement("li");
      if (item.id === pairActiveItemId) li.classList.add("active");
      const done = item.paired_count >= item.qty_scanned;
      li.innerHTML = `
        <span class="recent__prod"><b>${escapeHtml(itemDisplayName(item))}</b></span>
        <span class="mono recent__meta">${escapeHtml(item.sku || "")}</span>
        <span class="bexp${done ? "" : " bexp--off"}">${item.paired_count} / ${item.qty_scanned} paired${done ? " ✓" : ""}</span>`;
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
    setBatchResult(`Active product: ${itemDisplayName(item)}`, "ok");
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

bEl.toVerify.addEventListener("click", () => showBatchStage("verify"));

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
// pulls the most recent one into the verify set — no Bluetooth, no wedge.
document.getElementById("bverify-pull").addEventListener("click", async () => {
  try {
    const cap = await apiJson("/api/epc-captures/latest");
    const before = verifyEpcs.size;
    cap.epcs.forEach((e) => verifyEpcs.add(String(e).toUpperCase()));
    bEl.verifyCount.textContent = `${verifyEpcs.size} unique tags collected.`;
    setBatchResult(
      `Pulled sweep #${cap.id} from ${cap.device || "the C72"} ` +
        `(${cap.epc_count} tags, ${fmtWhen(cap.created_at)}) — ` +
        `${verifyEpcs.size - before} new.`,
      "ok"
    );
  } catch (err) {
    setBatchResult(err.message, "err");
  }
});

bEl.verifyCheck.addEventListener("click", async () => {
  if (!batch) return;
  bEl.verifyCheck.disabled = true;
  try {
    const rep = await postJson(`/api/batches/${batch.id}/verify`, {
      epcs: [...verifyEpcs],
    });
    const rows = rep.items
      .map((r) => {
        const ok = r.detected >= r.paired_count && r.paired_count >= r.qty_scanned;
        return `<tr>
          <td>${escapeHtml(r.product_title || "")}</td>
          <td class="mono">${escapeHtml(r.sku || "—")}</td>
          <td class="num">${r.qty_scanned}</td>
          <td class="num">${r.paired_count}</td>
          <td class="num">${r.detected}</td>
          <td>${ok ? "✓" : "⚠"}</td>
        </tr>`;
      })
      .join("");
    const extras = [];
    if (rep.foreign.length) {
      extras.push(
        `<p class="result result--err">${rep.foreign.length} tag(s) from OTHER products detected: ` +
          rep.foreign
            .map((f) => `${escapeHtml(f.product_title || "?")} (${escapeHtml(f.epc)}${f.bin_location ? ", bin " + escapeHtml(f.bin_location) : ""})`)
            .join("; ") +
          `</p>`
      );
    }
    if (rep.unknown_epcs.length) {
      extras.push(
        `<p class="result result--err">${rep.unknown_epcs.length} unknown tag(s): ` +
          rep.unknown_epcs.map(escapeHtml).join(", ") +
          `</p>`
      );
    }
    bEl.verifyReport.innerHTML = `
      ${rep.ok ? '<p class="result result--ok">Bin verified ✓ — everything paired was detected.</p>' : ""}
      <div class="inventory__scroll"><table class="inventory__table">
        <thead><tr><th>Product</th><th>SKU</th><th class="num">Boxes</th><th class="num">Paired</th><th class="num">Detected</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${extras.join("")}`;
  } catch (err) {
    setBatchResult(err.message, "err");
  } finally {
    bEl.verifyCheck.disabled = false;
  }
});

bEl.complete.addEventListener("click", async () => {
  if (!batch) return;
  if (!confirm(`Complete the batch for bin ${batch.bin_name}?`)) return;
  bEl.complete.disabled = true;
  try {
    const data = await postJson(`/api/batches/${batch.id}/complete`, {
      created_by: operatorEl.value || null,
    });
    const n = data.review_tasks.length;
    batch = null;
    batchItems = [];
    pairHistory = [];
    pairActiveItemId = null;
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
        <td>${escapeHtml(j.label_name || j.product_title || "")}${
          j.variant_title ? ` <span class="inventory__variant">(${escapeHtml(j.variant_title)})</span>` : ""
        }</td>
        <td class="mono">${escapeHtml(j.sku || "—")}</td>
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
async function loadReview() {
  const list = document.getElementById("review-list");
  try {
    const { tasks } = await apiJson("/api/review-tasks?status=open&limit=100");
    list.innerHTML = "";
    if (!tasks.length) {
      list.innerHTML =
        '<li class="recent__empty">Inbox zero — nothing needs review.</li>';
      return;
    }
    tasks.forEach((t) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="evtype">${escapeHtml(t.category)}</span>
        <span class="recent__prod"><b>${escapeHtml(t.product_title || t.sku || "")}</b> ${escapeHtml(t.detail)}</span>
        <span class="recent__meta recent__when">${escapeHtml(fmtWhen(t.created_at))}</span>
        <button class="recent__unassign" data-act="resolve">resolve</button>
        <button class="recent__unassign" data-act="dismiss">dismiss</button>`;
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
          li.remove();
        } catch (err) {
          alert(err.message);
        }
      };
      li.querySelector('[data-act="resolve"]').addEventListener("click", () => act(false));
      li.querySelector('[data-act="dismiss"]').addEventListener("click", () => act(true));
      list.append(li);
    });
  } catch (err) {
    list.innerHTML =
      '<li class="recent__empty">Could not load review tasks.</li>';
  }
}

// === Audits tab (WIP: recommended checks pointer) ==========================
async function loadAudits() {
  const list = document.getElementById("audit-list");
  try {
    const { tasks } = await apiJson("/api/review-tasks?status=open&limit=100");
    const checks = tasks.filter((t) => t.category === "inventory-check");
    list.innerHTML = checks.length
      ? ""
      : '<li class="recent__empty">No product checks recommended right now.</li>';
    checks.forEach((t) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="evtype">check</span>
        <span class="recent__prod"><b>${escapeHtml(t.product_title || t.sku || "")}</b> ${escapeHtml(t.detail)}</span>
        <span class="recent__meta recent__when">${escapeHtml(fmtWhen(t.created_at))}</span>`;
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
        <span class="evtype">sweep #${c.id}</span>
        <span class="recent__prod"><b>${c.epc_count} tags</b> from ${escapeHtml(c.device || "C72")}${c.note ? " — " + escapeHtml(c.note) : ""}</span>
        <span class="recent__meta recent__when">${escapeHtml(fmtWhen(c.created_at))}</span>`;
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
      '<tr><td colspan="6" class="inventory__empty">Could not load history.</td></tr>';
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
      '<tr><td colspan="6" class="inventory__empty">No events yet.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (e) => `<tr>
      <td class="recent__meta" style="white-space:nowrap">${escapeHtml(fmtWhen(e.at))}</td>
      <td><span class="evtype">${escapeHtml(e.type)}</span></td>
      <td>${escapeHtml(e.worker || "—")}</td>
      <td class="mono">${escapeHtml(e.sku || "—")}</td>
      <td>${escapeHtml(e.title || "—")}</td>
      <td class="recent__meta">${escapeHtml(e.detail || "")}</td>
    </tr>`
    )
    .join("");
}

let histSearchTimer;
document.getElementById("hist-search").addEventListener("input", () => {
  clearTimeout(histSearchTimer);
  histSearchTimer = setTimeout(renderHistory, 150);
});

// Boot
resetStation();
loadRecent();
