# Shopify RFID Inventory

A per-package RFID assignment app for Shopify. Scan a package barcode, the app
looks up the Shopify variant (with your `stock.bin` → `my_fields.bin_location`
fallback), then scan an RFID tag to bind that physical package to the variant.
Every warehouse terminal shares one Azure SQL database.

- **Frontend:** plain HTML/CSS/JS scan station (works with keyboard/HID scanners)
- **Backend:** FastAPI
- **DB:** Azure SQL Database via pymssql (SQLite works locally for quick tests).
  pymssql needs no system ODBC driver — important because Azure's Linux Python
  images stopped shipping the Microsoft ODBC driver.
- **Shopify:** GraphQL Admin API, client-credentials token flow
- **Host:** Azure App Service (Linux), deployed from GitHub

---

## Project layout

```
shopify-rfid/
├── app/
│   ├── config.py       env loading + Shopify env checks
│   ├── shopify.py      token flow + barcode lookup (your logic, no printing)
│   ├── database.py     SQLAlchemy engine/session (lazy; app boots without a DB)
│   ├── models.py       rfid_assignments table (one row = one physical tag)
│   ├── main.py         FastAPI pages + JSON API
│   ├── templates/index.html
│   └── static/{styles.css, app.js}
├── test_shopify.py     diagnostic CLI — "does Shopify still work?" (not run on Azure)
├── requirements.txt
├── .env.example        copy to .env for local dev
├── startup.txt         the Azure startup command (paste into portal)
└── .github/workflows/azure-deploy.yml
```

---

## Run locally

No virtual environment on this machine — packages install into global Python,
and the launcher is `py` (not `python`):

```powershell
py -m pip install -r requirements.txt

copy .env.example .env          # then fill in your Shopify values
py -m uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000

Without `DATABASE_URL` set, barcode lookups work but assignments return a clear
"Database not configured" message. That's expected for a quick Shopify test.
To test the full assign/list/unassign loop locally, point `DATABASE_URL` at a
throwaway SQLite file:

```
DATABASE_URL=sqlite:///./local.db
```

Check Shopify credentials from the command line any time:

```powershell
py test_shopify.py
```

---

## Deploy to Azure

You need two Azure resources: an **App Service** (the web app) and an **Azure
SQL Database**. High-level order:

### 1. Create the Azure SQL database (on the existing `telcansql` server)
- Portal → SQL databases → **Create** → pick the existing server `telcansql`,
  name the new database (e.g. `rfid`). Use the cheapest tier that fits
  (Basic, or the serverless free offer). A separate database keeps the RFID app
  fully isolated from TELCAN even though they share the server.
- Under the **server's** Networking settings, make sure
  "Allow Azure services and resources to access this server" is enabled so the
  App Service can reach it.
- Your connection string for `DATABASE_URL`:
  `mssql://USERNAME:PASSWORD@telcansql.database.windows.net:1433/rfid`
  using the server's SQL admin login (the app routes `mssql://` to the pymssql
  driver automatically). If login fails with a user error, try the older
  `USERNAME@telcansql` form as the username.

### 2. Create the App Service (Linux, Python 3.12)

### 3. Configure the App Service
Under **Settings → Configuration**:

- **Startup Command** (General settings) — paste the line from `startup.txt`:
  ```
  gunicorn app.main:app --workers 2 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
  ```
  Set it here in the portal, **not** in the GitHub workflow — publish-profile
  deployments reject a startup-command input in the YAML.

- **Application settings** (environment variables) — add:
  ```
  SHOPIFY_STORE
  SHOPIFY_CLIENT_ID
  SHOPIFY_CLIENT_SECRET
  DATABASE_URL
  SCM_DO_BUILD_DURING_DEPLOYMENT = true
  ```
  That last one makes Azure install `requirements.txt` during deployment. Without
  it you'll hit `ModuleNotFoundError: No module named 'uvicorn'` at startup.

### 4. Wire up GitHub deployment
Two options:

- **Portal (easiest):** App Service → **Deployment Center** → GitHub → pick your
  repo/branch. Azure writes a workflow file for you.
- **Use the included workflow:** edit `.github/workflows/azure-deploy.yml`, set
  `AZURE_WEBAPP_NAME`, then in GitHub add a repo secret
  `AZURE_WEBAPP_PUBLISH_PROFILE` (download the publish profile from the App
  Service overview → **Get publish profile**).

Every push to `main` then builds and deploys. Tables are created automatically on
first startup (move to Alembic migrations once the schema starts evolving).

### 5. Point Shopify at the app
Your app URL will be `https://<your-app>.azurewebsites.net`. Use that as the
application URL in your Shopify app config. For now the app runs standalone;
embedding it in Shopify admin (App Home + session-token verification) is the
next phase — don't expose the write endpoints publicly before adding that.

---

## API reference

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/` | Scan station UI (add `?printer=1` on the printer laptop) |
| GET  | `/health` | Status + env checks |
| GET  | `/api/products/by-barcode/{barcode}` | Variant lookup (TELCAN first, Shopify fallback) |
| GET  | `/api/products/tags?sku=&barcode=` | All RFID tags on file for a product |
| POST | `/api/rfid-assignments` | Bind a tag to a variant |
| GET  | `/api/rfid-assignments?q=` | List/search assignments |
| GET  | `/api/rfid-assignments/{rfid_id}` | One assignment |
| DELETE | `/api/rfid-assignments/{rfid_id}` | Unassign a tag |
| POST | `/api/print-jobs` | Queue N labels for a product (one EPC each) |
| GET  | `/api/print-jobs?status=&ids=` | List/watch print jobs |
| POST | `/api/print-jobs/claim` | Agent: take pending jobs (X-Agent-Key) |
| POST | `/api/print-jobs/{id}/complete` | Agent: printed OK → auto-assignment |
| POST | `/api/print-jobs/{id}/fail` | Agent: report a printer error |
| POST | `/api/print-jobs/{id}/cancel` | Cancel a still-pending job |

---

## Barcode lookup sources

`BARCODE_LOOKUP` env var controls where scans are answered from:

- `auto` (default) — the TELCAN catalog mirror (`Shopify_Variants` /
  `Shopify_Products` / `Shopify_Inventory.Bin_Name`) first; falls back to the
  Shopify API for barcodes TELCAN hasn't synced yet.
- `db` — TELCAN only. `api` — Shopify API only (the original behavior).

The product card shows which source answered. TELCAN results carry surrogate
ids (`telcan:<Variant_ID>`), so tag lists are anchored on SKU/barcode — fields
both sources agree on.

---

## RFID label printing (Zebra)

Flow: scan a barcode → set a quantity → **Print & encode RFID labels**. The
server queues one job per label, each with a freshly generated 96-bit EPC.
`print_agent.py` — run only on the laptop connected to the Zebra — claims
jobs, prints the barcode label and encodes the EPC into the sticker in one
pass, and reports back; the server then records the tag↔product assignment
automatically. Printed labels never need a manual tag scan.

**Printer capability matters.** Only Zebra "R" models (ZD621R, ZT411R, …)
have an RFID encoder. The warehouse ZD220t (ZD22042-T01G00EZ) is a plain
thermal-transfer barcode printer — it prints on RFID sticker media but cannot
write the chip, so run the agent with `--no-rfid`: labels print barcode-only,
no assignment is auto-created, and after applying the sticker you link its
factory-encoded tag with the normal two-scan flow (scan barcode, scan tag).
Drop the flag if an R-series printer arrives later — nothing else changes.

On the printer laptop (ZD220t is USB, so use the Windows driver name shown in
Settings → Printers; needs `py -m pip install pywin32`):

```powershell
# ZD220t over USB, barcode-only
py print_agent.py --app https://YOUR-APP.azurewebsites.net --printer-name "ZDesigner ZD220-203dpi ZPL" --no-rfid

# a network R-series printer, full print + encode
py print_agent.py --app https://YOUR-APP.azurewebsites.net --printer-host 192.168.1.50

# test without a printer — shows the ZPL it would send
py print_agent.py --app http://127.0.0.1:8000 --dry-run --once
```

Who sees the Print button:

- Default: only pages opened as `/?printer=1` (bookmark that on the printer
  laptop).
- Set `ALLOW_REMOTE_PRINT=true` in App Service settings to show it on every
  device (iPad included) — jobs queue centrally and the agent prints them, so
  no other change is needed.

Optionally set `PRINT_AGENT_KEY` (App Service) + `--agent-key` (agent) so only
your agent can claim jobs. The label layout is the `LABEL_ZPL` template at the
top of `print_agent.py` — plain ZPL, adjust to your sticker size (preview at
labelary.com).

---

## Notes on the per-package model

Each RFID tag is its own row, so several identical boxes of the same product
each get a distinct tag pointing at the same Shopify variant. A barcode scan only
identifies the *variant*, not which physical box — fine for locating and counting.
If you later want true package history (arrived / shipped / last rack seen), add a
`packages` table that `rfid_assignments` references; the current schema is shaped
so that's an additive change, not a rebuild.
