# Shopify RFID Inventory

A per-package RFID assignment app for Shopify. Scan a package barcode, the app
looks up the Shopify variant (with your `stock.bin` → `my_fields.bin_location`
fallback), then scan an RFID tag to bind that physical package to the variant.
Every warehouse terminal shares one Azure PostgreSQL database.

- **Frontend:** plain HTML/CSS/JS scan station (works with keyboard/HID scanners)
- **Backend:** FastAPI
- **DB:** Azure Database for PostgreSQL (SQLite works locally for quick tests)
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

```bash
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # then fill in your Shopify values
uvicorn app.main:app --reload
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

```bash
python test_shopify.py
```

---

## Deploy to Azure

You need two Azure resources: an **App Service** (the web app) and an **Azure
Database for PostgreSQL Flexible Server**. High-level order:

### 1. Create the PostgreSQL Flexible Server
- Note the admin username, password, server name, and database name.
- Under **Networking**, allow your App Service to reach it (enable "Allow public
  access from Azure services" for the simplest start, or configure a private
  endpoint/VNet for production).
- Your connection string looks like:
  `postgresql://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/DBNAME`
  (the app auto-upgrades `postgresql://` to the psycopg3 driver form).

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
| GET  | `/` | Scan station UI |
| GET  | `/health` | Status + env checks |
| GET  | `/api/products/by-barcode/{barcode}` | Shopify variant lookup |
| POST | `/api/rfid-assignments` | Bind a tag to a variant |
| GET  | `/api/rfid-assignments?q=` | List/search assignments |
| GET  | `/api/rfid-assignments/{rfid_id}` | One assignment |
| DELETE | `/api/rfid-assignments/{rfid_id}` | Unassign a tag |

---

## Notes on the per-package model

Each RFID tag is its own row, so several identical boxes of the same product
each get a distinct tag pointing at the same Shopify variant. A barcode scan only
identifies the *variant*, not which physical box — fine for locating and counting.
If you later want true package history (arrived / shipped / last rack seen), add a
`packages` table that `rfid_assignments` references; the current schema is shaped
so that's an additive change, not a rebuild.
