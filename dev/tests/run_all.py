"""Run every suite in this folder, one subprocess each (they monkeypatch
app modules and set env, so they must not share an interpreter).

    py dev/tests/run_all.py
"""
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
suites = sorted(
    p for p in glob.glob(os.path.join(HERE, "test_*.py"))
)
failed = []
for path in suites:
    name = os.path.basename(path)
    r = subprocess.run([sys.executable, path], capture_output=True)
    ok = r.returncode == 0
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failed.append(name)
        tail = (r.stdout or b"").decode("utf-8", "replace").splitlines()
        for line in tail[-15:]:
            print("      " + line)

print()
print(f"{len(suites) - len(failed)}/{len(suites)} suites passed"
      + (f" — FAILED: {', '.join(failed)}" if failed else ""))
sys.exit(1 if failed else 0)
