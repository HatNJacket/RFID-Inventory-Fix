"""Zebra RFID print agent — runs ONLY on the laptop connected to the printer.

Polls the app for queued label jobs, drives the Zebra (prints the barcode
label AND encodes the EPC into the sticker's RFID chip in one pass), then
reports success/failure back. On success the server records the tag<->product
assignment automatically.

Every other device just uses the web app in a browser; this script is the
one piece that must live next to the printer.

Usage (PowerShell on the printer laptop):

    # Printer shared on the network (has its own IP):
    py print_agent.py --app https://YOUR-APP.azurewebsites.net --printer-host 192.168.1.50

    # Printer plugged in over USB (uses the installed Windows driver name):
    py print_agent.py --app https://YOUR-APP.azurewebsites.net --printer-name "ZDesigner ZD621R-203dpi ZPL"
    (USB mode needs:  py -m pip install pywin32)

    # See the ZPL without touching a printer (testing):
    py print_agent.py --app http://127.0.0.1:8000 --dry-run --once

Options: --poll N (seconds between checks, default 3), --once (single pass),
--agent-key KEY (must match the app's PRINT_AGENT_KEY env var, if set).

--no-rfid: for printers WITHOUT an RFID encoder (e.g. the ZD220t). Prints
the barcode label only — no EPC is written to the sticker and no assignment
is auto-created; after applying the label, link the tag with the normal
two-scan flow (scan barcode, scan tag). Omit this flag only on R-series
printers (ZD621R etc.) that can actually encode.
"""
import argparse
import os
import socket
import sys
import time

import requests

# ---------------------------------------------------------------------------
# Label geometry. Defaults match the warehouse RFID stickers (measured
# 2.125 x 1.25 inch) at the ZD220's 203 dpi; override with --label-width /
# --label-height (inches) for other media. ^PW/^LL tell the printer the
# exact canvas so nothing lands off the sticker; ^FB word-wraps the title.
LABEL_WIDTH_IN = 2.125
LABEL_HEIGHT_IN = 1.25
DPI = 203

# Fine alignment, dialed in against this printer's calibration by test
# prints (2026-07-21). Tune with --shift-down / --shift-right if the media
# or printer changes.
SHIFT_DOWN_DOTS = 31   # ^LT: + moves the whole image down (max 120)
SHIFT_RIGHT_DOTS = 2   # ^LH x: + moves the whole image right

# Layout (all centered): header / SKU / barcode / BIN. The header is the
# store name normally, but Astronomik items swap it for the full product +
# variant name (their labels identify serialized filters, so the name is
# what the picker needs to see).
LABEL_ZPL = """^XA
{rfid_setup}^PW{pw}
^LL{ll}
^LH{sr},0
^LT{sd}
{header}^CF0,30
^FO0,52^FB{pw},1,0,C^FD{sku}^FS
{barcode_line}^CF0,30
^FO0,{bin_y}^FB{pw},1,0,C^FDBIN: {bin}^FS
^XZ
"""

HEADER_STORE = "^CF0,34\n^FO0,10^FB{pw},1,0,C^FDTelescopes Canada^FS\n"
# Two wrapped, centered lines of the product name in place of the store name.
HEADER_PRODUCT = "^CF0,20\n^FO0,4^FB{pw},2,0,C^FD{name}^FS\n"

# Mode A (automatic) makes the printer pick the densest Code 128 encoding,
# which is what _code128_width_dots models — required for true centering.
# The printer's own interpretation line shrinks with the module width, so
# it's disabled; a separate normal-sized centered caption is printed below.
BARCODE_LINE = (
    "^FO{bx},88^BY{module},3,72^BCN,72,N,N,N,A^FD{barcode}^FS\n"
    "^CF0,20\n"
    "^FO0,164^FB{pw},1,0,C^FD{barcode}^FS\n"
)

# Prepended only for RFID-encoding printers: auto tag setup + write the EPC.
RFID_ZPL = "^RS8\n^RFW,H^FD{epc}^FS\n"

# Alignment test: a border box + corner ticks, no job needed. If the box
# edges don't sit just inside the sticker edges, the size flags (or the
# printer's media calibration) are off.
TEST_ZPL = """^XA
^PW{pw}
^LL{ll}
^LH{sr},0
^LT{sd}
^FO2,2^GB{bw},{bh},2^FS
^CF0,24
^FO20,{mid}^FDTEST {win} x {hin} in ({pw} x {ll} dots)^FS
^XZ
"""

def label_dots(width_in: float, height_in: float) -> tuple[int, int]:
    return int(width_in * DPI), int(height_in * DPI)


def _code128_width_dots(data: str, module: int = 2) -> int:
    """Printed width of a Code 128 barcode (mode A auto-encoding), so it
    can be centered. Digit pairs pack into subset-C symbols; odd-length
    numbers spend one extra symbol switching subsets for the last digit."""
    n = len(data)
    if n and data.isdigit():
        symbols = n // 2 if n % 2 == 0 else (n - 1) // 2 + 2
    else:
        symbols = n
    return (11 * (symbols + 2) + 13) * module  # start+data+check, then stop


def build_test_zpl(width_in: float, height_in: float,
                   shift_down: int = SHIFT_DOWN_DOTS,
                   shift_right: int = SHIFT_RIGHT_DOTS) -> str:
    pw, ll = label_dots(width_in, height_in)
    return TEST_ZPL.format(
        pw=pw, ll=ll, bw=pw - 4, bh=ll - 4, mid=ll // 2 - 12,
        win=width_in, hin=height_in, sd=shift_down, sr=shift_right,
    )


def build_zpl(job: dict, encode_rfid: bool,
              width_in: float = LABEL_WIDTH_IN,
              height_in: float = LABEL_HEIGHT_IN,
              shift_down: int = SHIFT_DOWN_DOTS,
              shift_right: int = SHIFT_RIGHT_DOTS) -> str:
    def clean(value, fallback="-"):
        # ZPL control characters would break the label format.
        text = str(value or fallback)
        return text.replace("^", " ").replace("~", " ").strip()

    pw, ll = label_dots(width_in, height_in)

    title = clean(job.get("product_title"), fallback="")
    label = clean(job.get("label_name"), fallback="")
    if label:
        # Operator-preferred name (e.g. what the physical Astronomik label
        # says). Short names get a bigger face.
        size = 28 if len(label) <= 26 else 20
        header = f"^CF0,{size}\n^FO0,6^FB{pw},2,0,C^FD{label[:84]}^FS\n"
    elif "astronomik" in title.lower():
        name = title
        if job.get("variant_title"):
            name += f" ({clean(job['variant_title'])})"
        header = HEADER_PRODUCT.format(pw=pw, name=name[:84])
    else:
        header = HEADER_STORE.format(pw=pw)

    barcode = clean(job.get("barcode"), fallback="")
    if not barcode:
        # No barcode on file: encode the SKU instead — the app's scan field
        # accepts SKUs, so scanning this label still resolves the product.
        barcode = clean(job.get("sku"), fallback="")
    barcode_line = ""
    if barcode:
        # Prefer 2-dot modules; long codes (like alphanumeric SKUs) drop to
        # 1-dot so they still fit with quiet zones inside the label width.
        module = 2
        width = _code128_width_dots(barcode, module)
        if width > pw - 24:
            module = 1
            width = _code128_width_dots(barcode, module)
        bx = max(2, (pw - width) // 2)
        barcode_line = BARCODE_LINE.format(
            bx=bx, barcode=barcode, module=module, pw=pw
        )
    return LABEL_ZPL.format(
        rfid_setup=RFID_ZPL.format(epc=job["epc"]) if encode_rfid else "",
        pw=pw,
        ll=ll,
        sd=shift_down,
        sr=shift_right,
        header=header,
        bin_y=ll - 45,
        sku=clean(job.get("sku")),
        barcode_line=barcode_line,
        bin=clean(job.get("bin_location")),
    )


# ------------------------------------------------------------ printer I/O ---
def send_network(zpl: str, host: str, port: int) -> None:
    """Raw ZPL over TCP 9100 — every network-capable Zebra supports this."""
    with socket.create_connection((host, port), timeout=10) as conn:
        conn.sendall(zpl.encode("utf-8"))


def send_windows(zpl: str, printer_name: str) -> None:
    """Raw ZPL through the installed Windows driver (USB printers)."""
    try:
        import win32print
    except ImportError:
        sys.exit("USB mode needs pywin32:  py -m pip install pywin32")
    handle = win32print.OpenPrinter(printer_name)
    try:
        win32print.StartDocPrinter(handle, 1, ("RFID label", None, "RAW"))
        win32print.StartPagePrinter(handle)
        win32print.WritePrinter(handle, zpl.encode("utf-8"))
        win32print.EndPagePrinter(handle)
        win32print.EndDocPrinter(handle)
    finally:
        win32print.ClosePrinter(handle)


# --------------------------------------------------------------- app I/O ----
class AppClient:
    def __init__(self, base_url: str, agent_key: str | None):
        self.base = base_url.rstrip("/")
        self.headers = {"X-Agent-Key": agent_key} if agent_key else {}

    def claim(self, limit: int = 5) -> list[dict]:
        r = requests.post(
            f"{self.base}/api/print-jobs/claim",
            params={"limit": limit},
            headers=self.headers,
            timeout=30,
        )
        r.raise_for_status()
        return r.json()["jobs"]

    def complete(self, job_id: int, create_assignment: bool) -> None:
        requests.post(
            f"{self.base}/api/print-jobs/{job_id}/complete",
            params={"create_assignment": str(create_assignment).lower()},
            headers=self.headers,
            timeout=30,
        ).raise_for_status()

    def fail(self, job_id: int, error: str) -> None:
        requests.post(
            f"{self.base}/api/print-jobs/{job_id}/fail",
            json={"error": error[:500]},
            headers=self.headers,
            timeout=30,
        ).raise_for_status()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--app",
        help="App base URL (defaults to PRINT_AGENT_APP_URL or APP_URL)",
    )
    parser.add_argument("--printer-host", help="Printer IP (network mode)")
    parser.add_argument("--printer-port", type=int, default=9100)
    parser.add_argument("--printer-name", help="Windows printer name (USB)")
    parser.add_argument("--agent-key", help="Matches app PRINT_AGENT_KEY")
    parser.add_argument("--poll", type=float, default=3.0)
    parser.add_argument("--once", action="store_true", help="Single pass")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print ZPL to the terminal instead of a printer (still marks "
             "jobs done — use for wiring tests, not real stock)",
    )
    parser.add_argument(
        "--no-rfid", action="store_true",
        help="Printer has no RFID encoder (e.g. ZD220t): print the barcode "
             "label only; link tags afterwards with the two-scan flow",
    )
    parser.add_argument("--label-width", type=float, default=LABEL_WIDTH_IN,
                        help="Sticker width in inches (default %(default)s)")
    parser.add_argument("--label-height", type=float, default=LABEL_HEIGHT_IN,
                        help="Sticker height in inches (default %(default)s)")
    parser.add_argument(
        "--test-label", action="store_true",
        help="Print one alignment box (no job needed) and exit",
    )
    parser.add_argument("--shift-down", type=int, default=SHIFT_DOWN_DOTS,
                        help="Move the whole image down N dots (203/inch; "
                             "default %(default)s)")
    parser.add_argument("--shift-right", type=int, default=SHIFT_RIGHT_DOTS,
                        help="Move the whole image right N dots "
                             "(default %(default)s)")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.app:
        args.app = os.getenv("PRINT_AGENT_APP_URL") or os.getenv("APP_URL")
    if not args.app:
        parser.error("need --app, PRINT_AGENT_APP_URL, or APP_URL")

    if not args.dry_run and not (args.printer_host or args.printer_name):
        parser.error("need --printer-host, --printer-name, or --dry-run")

    def print_label(zpl: str) -> None:
        if args.dry_run:
            print(zpl)
        elif args.printer_host:
            send_network(zpl, args.printer_host, args.printer_port)
        else:
            send_windows(zpl, args.printer_name)

    if args.test_label:
        zpl = build_test_zpl(args.label_width, args.label_height,
                             args.shift_down, args.shift_right)
        print_label(zpl)
        print("Alignment test sent. The box should sit just inside the "
              "sticker edges; if not, adjust --label-width/--label-height "
              "or recalibrate the printer.")
        return

    encode_rfid = not args.no_rfid
    client = AppClient(args.app, args.agent_key)
    print(f"Print agent watching {args.app} "
          f"({'DRY RUN' if args.dry_run else 'live'}, "
          f"{'RFID encode' if encode_rfid else 'barcode-only'}). "
          f"Ctrl+C to stop.")

    while True:
        try:
            jobs = client.claim()
        except requests.RequestException as error:
            print(f"! can't reach app: {error}")
            jobs = []

        for job in jobs:
            label = f"job {job['id']} ({job.get('sku') or job.get('barcode')})"
            try:
                print_label(build_zpl(
                    job, encode_rfid, args.label_width, args.label_height,
                    args.shift_down, args.shift_right,
                ))
                client.complete(job["id"], create_assignment=encode_rfid)
                print(f"  printed {label}" + (
                    f" -> EPC {job['epc']}" if encode_rfid
                    else " (barcode only — scan tag to link)"
                ))
            except Exception as error:  # printer or network trouble
                print(f"! failed {label}: {error}")
                try:
                    client.fail(job["id"], str(error))
                except requests.RequestException:
                    pass

        if args.once:
            break
        time.sleep(args.poll)


if __name__ == "__main__":
    main()
