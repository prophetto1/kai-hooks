#!/usr/bin/env python
"""Tests for frontend-design-gate detection.

Encodes the audit findings as executable checks:
  - raw primitives that appear ONLY inside comments / string literals must NOT be
    flagged (false-positive fix), and
  - a real multi-line opening tag (`<button` with the name at end of line) MUST be
    flagged (false-negative fix),
plus the v1 invariants (committed backlog ignored, components/ui excluded,
inventory-gated, capitalized DS component not flagged).
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile

SCRIPT = "E:/hooks/frontend-design-gate/frontend-design-gate.py"
_spec = importlib.util.spec_from_file_location("fdg", SCRIPT)
fdg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fdg)


def _repo(files_committed=None, files_added=None, ui=("button", "input")):
    d = tempfile.mkdtemp(prefix="fdg-test-")

    def g(*a):
        subprocess.run(["git", "-C", d, *a], capture_output=True, text=True)

    def w(rel, body):
        fp = os.path.join(d, rel)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        with open(fp, "w", encoding="utf-8") as fh:
            fh.write(body)

    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    w("README.md", "root\n")  # guarantees a HEAD even when no ui/committed files
    for name in ui:
        w(f"apps/web/src/components/ui/{name}.tsx", f"export const X=(p)=> <{name} {{...p}}/>;\n")
    for rel, body in (files_committed or {}).items():
        w(rel, body)
    g("add", "-A")
    g("commit", "-qm", "init")
    for rel, body in (files_added or {}).items():
        w(rel, body)
    return d


def _elements(d):
    return sorted({v["element"] for v in fdg.find_violations(d)})


def main():
    checks = []

    def check(name, cond, info):
        checks.append((name, bool(cond), info))

    # FALSE-POSITIVE fixes -------------------------------------------------
    d = _repo(files_added={"apps/web/src/a.tsx": "// use <button> here later\n"})
    check("comment not flagged", fdg.find_violations(d) == [], _elements(d))

    d = _repo(files_added={"apps/web/src/b.tsx": 'const s = "<button>x</button>";\n'})
    check("string literal not flagged", fdg.find_violations(d) == [], _elements(d))

    d = _repo(files_added={"apps/web/src/c.tsx": "const a = (<div>{/* <input/> */}</div>);\n"})
    check("jsx comment not flagged", fdg.find_violations(d) == [], _elements(d))

    # FALSE-NEGATIVE fix --------------------------------------------------
    d = _repo(files_added={"apps/web/src/d.tsx": "export const A = () => (\n  <button\n    onClick={f}\n  >hi</button>\n);\n"})
    check("multiline open tag flagged", _elements(d) == ["button"], _elements(d))

    # invariants ----------------------------------------------------------
    d = _repo(files_added={"apps/web/src/e.tsx": "export const A = () => <input value={x} />;\n"})
    check("real single-line flagged", _elements(d) == ["input"], _elements(d))

    d = _repo(files_added={"apps/web/src/f.tsx": "export const A = () => <Button>x</Button>;\n"})
    check("capitalized component not flagged", fdg.find_violations(d) == [], _elements(d))

    d = _repo(files_committed={"apps/web/src/old.tsx": "export const O = () => <button>old</button>;\n"})
    check("committed backlog ignored", fdg.find_violations(d) == [], _elements(d))

    d = _repo(files_added={"apps/web/src/components/ui/new.tsx": "export const N = () => <button/>;\n"})
    check("components/ui excluded", fdg.find_violations(d) == [], _elements(d))

    d = _repo(files_added={"apps/web/src/g.tsx": "export const A = () => <button/>;\n"}, ui=())
    check("inventory-gated when no DS", fdg.find_violations(d) == [], _elements(d))

    failures = [{"check": n, "got": str(i)} for n, ok, i in checks if not ok]
    if failures:
        print(json.dumps({"failed": failures}, indent=2))
        return 1
    print(f"frontend-design-gate tests passed ({len(checks)} checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
