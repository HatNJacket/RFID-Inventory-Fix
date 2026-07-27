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
        (!q || b.bin.toLowerCase().includes(q))
    )
  );
  countEl.textContent =
    `(${binBoard.todo_count} of ${binBoard.total_bins} left · ` +
    `${binBoard.done_bins} done` +
    `${binBoard.hidden_count ? ` · ${binBoard.hidden_count} hidden` : ""}` +
    `${
      binBoard.malformed_count
        ? ` · ${binBoard.malformed_count} odd name(s)`
        : ""
    })`;
  hideBtn.innerHTML = showHiddenBins
    ? `${ICON_EYE_OFF}<span>Hide ignored</span>`
    : `${ICON_EYE}<span>Show hidden${
        binBoard.hidden_count ? ` (${binBoard.hidden_count})` : ""
      }</span>`;
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<li class="recent__empty">${
      q
        ? "No bins match that."
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
    li.innerHTML =
      `<button class="binlist__eye" type="button" title="${
        b.hidden ? "Show bin" : "Hide bin"
      }" aria-label="${b.hidden ? "Show bin" : "Hide bin"}">${
        b.hidden ? ICON_EYE : ICON_EYE_OFF
      }</button>` +
      `<span class="binlist__name">${escapeHtml(b.bin)}</span>` +
      `${
        b.malformed
          ? `<span class="binlist__odd" title="Bin name doesn't match the A1-2 format (one letter, then 1-99, dash, 1-99). Usually means one product's stock is split across shelves — worth fixing in Shopify before tagging this bin.">⚠ odd name</span>`
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
    list.append(li);
  });
}

document.getElementById("binboard-showhidden").addEventListener("click", () => {
  showHiddenBins = !showHiddenBins;
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
  countEl.textContent = "(re-reading bins from Shopify…)";
  try {
    await postJson("/api/bin-map/refresh", {});
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await apiJson("/api/bin-map/status");
      if (!s.refreshing) break;
    }
    await loadBinBoard();
  } catch (err) {
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

function openBatchView(stage) {
  bEl.start.hidden = true;
  bEl.active.hidden = false;
  document.querySelector(".binboard").hidden = true;
  bEl.binChip.textContent = `Bin ${batch.bin_name}`;
  setBatchResult("", null);
  showBatchStage(stage);
  startBatchLive();
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
function itemCard(item, mode) {
  const li = document.createElement("li");
  li.className = "bcell";
  if (!item.resolved) li.classList.add("bcell--warn");
  if (mode === "pair") {
    if (item.id === pairActiveItemId) li.classList.add("bcell--active");
    if (item.qty_scanned > 0 && item.paired_count >= item.qty_scanned)
      li.classList.add("bcell--exact");
  } else if (item.expected_qty != null) {
    if (item.qty_scanned === item.expected_qty && item.qty_scanned > 0)
      li.classList.add("bcell--exact");
    else if (item.qty_scanned > item.expected_qty)
      li.classList.add("bcell--over");
  }
  const tracker =
    mode === "pair"
      ? `${item.paired_count}/${Math.max(item.qty_scanned, item.paired_count)}`
      : item.expected_qty != null
        ? `${item.qty_scanned}/${item.expected_qty}`
        : `${item.qty_scanned}`;
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
        item.other_bins
          ? `<div class="bcell__meta bcell__split">Also on ${escapeHtml(item.other_bins)} — this item is split across shelves</div>`
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
    const data = await postJson(`/api/batches/${batch.id}/scan`, { code });
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
    batchSound("err");
    setBatchResult(err.message, "err");
  }
  bEl.scan.focus();
});

function renderBatchItems() {
  const summary = document.getElementById("bcollect-summary");
  const expected = batchItems.filter((i) => i.expected_qty != null);
  if (expected.length) {
    const started = expected.filter((i) => i.qty_scanned > 0).length;
    const boxes = batchItems.reduce((n, i) => n + i.qty_scanned, 0);
    summary.textContent =
      `${started} of ${expected.length} expected products scanned · ` +
      `${boxes} box(es) total`;
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
  ambiguous: "barcode matches several listings",
  "count-mismatch": "count differs from Shopify",
  "unconfirmed-name": "serial name not confirmed",
  unresolved: "unknown barcode",
  "wrong-bin": "saved bin is a different shelf",
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

async function loadBatchReview(showAll) {
  const list = document.getElementById("bcheck-list");
  const empty = document.getElementById("bcheck-empty");
  empty.hidden = true;
  list.innerHTML = '<li class="recent__empty">Checking the batch…</li>';
  try {
    const data = await apiJson(`/api/batches/${batch.id}/review`);
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
    list.innerHTML = "";
    if (!checkEntries.length) {
      empty.hidden = false;
      return;
    }
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
  } catch (err) {
    list.innerHTML = `<li class="recent__empty">${escapeHtml(err.message)}</li>`;
  }
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
  } else {
    document.getElementById("bitem-usewrap").hidden = true;
  }

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
  document.getElementById("bitem-printwrap").hidden = !it.resolved;
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

document.getElementById("bitem-close").addEventListener("click", () => {
  document.getElementById("bitem-overlay").hidden = true;
  loadBatchReview();
});
document.getElementById("bitem-overlay").addEventListener("click", (e) => {
  if (e.target.id === "bitem-overlay") {
    document.getElementById("bitem-overlay").hidden = true;
    loadBatchReview();
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
      const paired = r.paired_count === r.qty_scanned;
      const detected = r.detected === r.paired_count;
      if (r.qty_scanned !== r.paired_count) boxesOk = false;
      if (!paired) pairedOk = false;
      if (!detected) detectedOk = false;
      return `<tr>
        <td>${escapeHtml(r.product_title || "")}</td>
        <td class="mono">${escapeHtml(r.sku || "—")}</td>
        <td class="num">${r.qty_scanned}</td>
        <td class="num${paired ? "" : " bexp--off"}">${r.paired_count}</td>
        <td class="num${detected ? "" : " bexp--off"}">${r.detected}</td>
        <td>${paired && detected ? "✓" : "⚠"}</td>
      </tr>`;
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

  bEl.verifyReport.innerHTML = `
    ${verdict}
    <div class="inventory__scroll"><table class="inventory__table">
      <thead><tr><th>Product</th><th>SKU</th><th class="num">Boxes</th><th class="num">Paired</th><th class="num">Detected</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
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
        <td>${escapeHtml(j.label_name || j.product_title || "")}${
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
      const skuLink = tr.querySelector(".queue-sku");
      if (skuLink)
        skuLink.addEventListener("click", (ev) => {
          ev.preventDefault();
          openProductHistory(j.sku);
        });
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
    .map(
      (e, i) => `<tr>
      <td class="recent__meta" style="white-space:nowrap">${escapeHtml(fmtWhen(e.at))}</td>
      <td><span class="evtype">${escapeHtml(e.type)}</span></td>
      <td>${escapeHtml(e.worker || "—")}</td>
      <td class="mono">${
        e.sku
          ? `<a href="#" class="hist-sku" data-sku="${escapeHtml(e.sku)}">${escapeHtml(e.sku)}</a>`
          : "—"
      }</td>
      <td>${escapeHtml(e.title || "—")}</td>
      <td class="recent__meta">${escapeHtml(e.detail || "")}</td>
      <td>${
        e.undo
          ? `<button class="reset hist-undo" data-idx="${i}" type="button">Undo</button>`
          : ""
      }</td>
    </tr>`
    )
    .join("");
  body.querySelectorAll(".hist-undo").forEach((btn) => {
    btn.addEventListener("click", () => undoHistoryEvent(rows[+btn.dataset.idx], btn));
  });
  body.querySelectorAll(".hist-sku").forEach((a) => {
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
      document.getElementById("phist-label-input").value =
        phistEffectiveName() || "";
      phistPlacement = data.serial_prefix
        ? "header"
        : data.custom_placement || "header";
      // Serialized names are header-only by design (name-at-top labels);
      // the placement toggle applies to everything else.
      document.getElementById("phist-placement").hidden =
        !!data.serial_prefix;
      document.getElementById("phist-label-clear").hidden =
        !!data.serial_prefix;
      updatePlacementBtn();
      document.getElementById("phist-label-hint").textContent =
        data.serial_prefix
          ? "Preferred label name (serialized product) — printed at the " +
            "top of every label, including Scan Station auto-prints. " +
            "Long names print smaller to fit two lines:"
          : "Preferred label name — prints where the toggle says " +
            "(replacing the store name, or the SKU line above the " +
            "barcode). ✕ clears it back to the standard label:";
      updateLabelPreview();
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
        <td><span class="evtype">${escapeHtml(e.type)}</span></td>
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

// The name a label would print for this product right now (null = the
// standard store header) and where it goes.
let phistPlacement = "header";

function phistEffectiveName() {
  if (!phistData) return null;
  if (phistData.serial_prefix)
    return phistData.serial_label_saved ? phistData.serial_label : null;
  return phistData.custom_label;
}

function updatePlacementBtn() {
  document.getElementById("phist-placement").textContent =
    phistPlacement === "sku" ? "Replaces: SKU line" : "Replaces: store name";
}

// Miniature sticker mirrors the agent's real layout, including the
// smaller font tiers long names trigger and the placement modes.
function updateLabelPreview() {
  if (!phistData) return;
  const p = phistData.product || {};
  const typed = document.getElementById("phist-label-input").value.trim();
  const asSku = typed && phistPlacement === "sku";
  const header = asSku || !typed ? "Telescopes Canada" : typed;
  const el = document.getElementById("phist-prev-header");
  el.textContent = header;
  el.className =
    "label-preview__header " +
    (asSku || !typed || header.length <= 26
      ? "label-preview__header--lg"
      : header.length <= 56
        ? "label-preview__header--md"
        : "label-preview__header--sm");
  document.getElementById("phist-prev-sku").textContent = asSku
    ? typed
    : p.sku || phistData.sku || "";
  document.getElementById("phist-prev-bc").textContent =
    p.barcode || p.sku || phistData.barcode || "";
  document.getElementById("phist-prev-bin").textContent =
    "BIN: " + (p.bin_location || "—");
}

document.getElementById("phist-placement").addEventListener("click", () => {
  phistPlacement = phistPlacement === "sku" ? "header" : "sku";
  updatePlacementBtn();
  updateLabelPreview();
});

document.getElementById("phist-label-clear").addEventListener("click", async () => {
  const input = document.getElementById("phist-label-input");
  input.value = "";
  updateLabelPreview();
  // If a name was saved, clearing the box also purges it server-side.
  if (phistData && !phistData.serial_prefix && phistData.custom_label) {
    document.getElementById("phist-label-save").click();
  }
});

document
  .getElementById("phist-label-input")
  .addEventListener("input", updateLabelPreview);

// Preferred label name save — serialized products write through their
// serial record (Scan Station auto-prints use it too); others go to the
// per-SKU label-name store. Blank clears back to the standard header.
document.getElementById("phist-label-save").addEventListener("click", async () => {
  if (!phistData) return;
  const name = document.getElementById("phist-label-input").value.trim();
  const msg = document.getElementById("phist-msg");
  try {
    if (phistData.serial_prefix) {
      if (!name) {
        msg.textContent =
          "Serialized products need a name — shorten it instead of clearing.";
        return;
      }
      await apiJson(
        `/api/serial-prefixes/${encodeURIComponent(phistData.serial_prefix)}/label`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label_name: name }),
        }
      );
      phistData.serial_label = name;
      phistData.serial_label_saved = true;
    } else {
      await apiJson(
        `/api/label-names/${encodeURIComponent(phistData.sku)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label_name: name,
            placement: phistPlacement,
            updated_by: operatorEl.value || null,
          }),
        }
      );
      phistData.custom_label = name || null;
      phistData.custom_placement = phistPlacement;
    }
    updateLabelPreview();
    msg.textContent = name
      ? "Name saved ✓ — new prints use it."
      : "Cleared ✓ — labels print the standard header.";
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

// Undoable events carry an `undo` descriptor from the server. Today that's
// barcode links (alias rows are live, so deleting one IS the undo — the
// scanned code simply stops resolving to that product).
async function undoHistoryEvent(e, btn) {
  if (!e || !e.undo) return;
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
