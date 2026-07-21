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
  reset: document.getElementById("reset"),
  recentList: document.getElementById("recent-list"),
  search: document.getElementById("search"),
};

// Printing UI shows on the printer station (?printer=1 in the URL) or for
// everyone when the server flag ALLOW_REMOTE_PRINT is on.
const printingEnabled =
  document.body.dataset.remotePrint === "on" ||
  new URLSearchParams(location.search).has("printer");

// Current product awaiting an RFID tag. Null when we're on step 1.
let pendingProduct = null;

function setResult(message, kind) {
  el.result.textContent = message;
  el.result.className = "result" + (kind ? ` result--${kind}` : "");
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
    const res = await fetch(
      `/api/products/by-barcode/${encodeURIComponent(barcode)}`
    );
    if (res.status === 404) {
      setResult("No product found for that barcode.", "err");
      el.barcode.select();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Lookup failed.", "err");
      return;
    }
    pendingProduct = await res.json();
    showProduct(pendingProduct);
    setResult("Product found. Scan the RFID tag.", "ok");
    activate("rfid");
  } catch (err) {
    setResult("Network error during lookup.", "err");
  }
});

function showProduct(p) {
  el.pTitle.textContent = p.product_title || "—";
  el.pVariant.textContent = p.variant_title || "—";
  el.pSku.textContent = p.sku || "—";
  el.pBarcode.textContent = p.barcode || "—";
  el.pBin.textContent = p.bin_location || "—";
  el.pSource.textContent =
    p.source === "telcan" ? "TELCAN" : p.source === "shopify" ? "Shopify" : "—";
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
    const res = await fetch(`/api/products/tags?${params}`);
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
          <span class="recent__epc">${escapeHtml(a.rfid_id)}</span>
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
el.printBtn.addEventListener("click", async () => {
  if (!pendingProduct) return;
  const quantity = Math.max(1, Math.min(100, Number(el.printQty.value) || 1));
  el.printBtn.disabled = true;
  el.printStatus.textContent = "Queueing…";
  try {
    const res = await fetch("/api/print-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity, ...pendingProduct }),
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
  }
});

// Poll the queued jobs until they all finish (or we give up watching —
// the agent keeps printing regardless).
async function watchPrintJobs(ids) {
  const started = Date.now();
  const idsParam = ids.join(",");
  while (Date.now() - started < 120000) {
    try {
      const res = await fetch(`/api/print-jobs?ids=${idsParam}`);
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
        if (!waiting) {
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

  setResult("Saving assignment…", "busy");
  try {
    const res = await fetch("/api/rfid-assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rfid_id: rfid, ...pendingProduct }),
    });
    if (res.status === 409) {
      setResult(`Tag ${rfid} is already assigned.`, "err");
      el.rfid.select();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setResult(body.detail || "Save failed.", "err");
      return;
    }
    const saved = await res.json();
    setResult(`Assigned ${saved.rfid_id} → ${saved.product_title}`, "ok");
    prependRecent(saved);
    // Brief pause so the operator sees confirmation, then reset for next box.
    setTimeout(resetStation, 700);
  } catch (err) {
    setResult("Network error while saving.", "err");
  }
});

// --- Recent list -----------------------------------------------------------
function recentRow(a) {
  const li = document.createElement("li");
  li.dataset.rfid = a.rfid_id;
  li.innerHTML = `
    <span class="recent__epc">${escapeHtml(a.rfid_id)}</span>
    <span class="recent__prod">${escapeHtml(a.product_title || "")}</span>
    <span class="recent__meta">${escapeHtml(a.bin_location || "")}</span>
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
    const url = query
      ? `/api/rfid-assignments?q=${encodeURIComponent(query)}`
      : "/api/rfid-assignments";
    const res = await fetch(url);
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
  const res = await fetch(`/api/rfid-assignments/${encodeURIComponent(rfid)}`, {
    method: "DELETE",
  });
  if (res.ok) li.remove();
}

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRecent(el.search.value.trim()), 200);
});

// --- Global controls -------------------------------------------------------
el.reset.addEventListener("click", resetStation);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") resetStation();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Boot
resetStation();
loadRecent();
