"""Build the Azure zip-deploy package.

Written after PowerShell's Compress-Archive shipped a broken package: on
Windows PowerShell 5.1 it writes nested entries with BACKSLASH separators,
so Linux reads "app\\main.py" as one oddly-named file at the zip root, the
app/ package never exists, and gunicorn dies with ModuleNotFoundError.
That has downed prod twice.

zipfile with explicit forward-slash arcnames is the fix. The asserts at the
bottom make a repeat of that failure impossible to miss.

Usage:
    py dev/mkdeploy.py
    az webapp deploy -n telcan-rfid -g shopify-automation-rg --type zip \
        --src-path dev/deploy.zip
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy.zip")

# Exactly the layout of the last package that booted. dev/ is NOT deployed.
FILES = [
    ".env.example",
    ".github/workflows/azure-deploy.yml",
    ".gitignore",
    "README.md",
    "ROADMAP.md",
    "app/__init__.py",
    "app/auth.py",
    "app/config.py",
    "app/database.py",
    "app/main.py",
    "app/models.py",
    "app/shopify.py",
    "app/static/app.js",
    "app/static/styles.css",
    "app/static/tc-rfid-sweep.apk",
    "app/static/tc-rfid-sweep.apk.idsig",
    "app/templates/index.html",
    "inspect_db.py",
    "load_astronomik.py",
    "print_agent.py",
    "requirements.txt",
    "startup.txt",
    "test_shopify.py",
]

missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
if missing:
    raise SystemExit(f"missing source files: {missing}")

if os.path.exists(OUT):
    os.remove(OUT)

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for rel in FILES:
        # arcname is the POSIX path, never the OS one.
        z.write(os.path.join(ROOT, rel), arcname=rel)

with zipfile.ZipFile(OUT) as z:
    names = z.namelist()
    bad = [n for n in names if "\\" in n]
    assert not bad, f"BACKSLASH ENTRIES (would break the deploy): {bad}"
    assert "app/main.py" in names, "app/main.py missing -> cannot import app"
    assert "app/__init__.py" in names, "app/__init__.py missing -> no package"

print(f"OK  {OUT}")
print(f"    {len(names)} entries, all POSIX paths, app/ package intact")
print(f"    size {os.path.getsize(OUT):,} bytes")
