#!/usr/bin/env python
"""frontend-design-gate (Stop): block completion when the CURRENT change ADDS raw HTML
primitives (<button>/<input>/<select>/<textarea>) in app code while the repo's design
system already provides that component as components/ui/<name>.tsx.

Only newly-ADDED diff lines are checked (git diff vs HEAD + untracked files) — never the
pre-existing backlog, so it cannot block a completion over code you did not touch. Reads
git only (no telemetry, so it is immune to the WAL read-visibility lag). Loop-safe
(releases after maxRepeatedBlocks) and fail-open (any error or non-repo Stop allows).

Run modes:
  (hook)        echo '<stop payload>' | python frontend-design-gate.py
  --repo PATH   python frontend-design-gate.py --repo E:/kai-chattr   # print findings, no gating
  --self-test   python frontend-design-gate.py --self-test            # prove behavior in a temp repo
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_core"))
from hook_runtime import run  # noqa: E402

HOOK_ID = "frontend-design-gate"
# raw HTML element -> design-system primitive filename (without .tsx) that should replace it
DEFAULT_PRIMITIVES = {"button": "button", "input": "input", "select": "select", "textarea": "textarea"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage"}
DEFAULT_STATE_SUBDIR = ".state/frontend-design-gate"


def _git(repo, *args):
    try:
        p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=5)
        return p.stdout if p.returncode == 0 else None
    except Exception:
        return None


def _repo_root(cwd):
    out = _git(cwd, "rev-parse", "--show-toplevel")
    return out.strip().replace("\\", "/") if out else None


def _ds_inventory(repo, primitives):
    """Set of element names whose components/ui/<file>.tsx exists somewhere in the repo."""
    have = set()
    for dp, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if dp.replace("\\", "/").endswith("/components/ui"):
            for elem, fname in primitives.items():
                if f"{fname}.tsx" in files:
                    have.add(elem)
    return have


def _added_lines(repo):
    """[(path, lineno, text)] for lines ADDED vs HEAD plus whole-file contents of untracked files."""
    added = []
    diff = _git(repo, "diff", "--unified=0", "HEAD", "--", "*.tsx", "*.jsx") or ""
    path, newno = None, 0
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            path, newno = line[6:].strip(), 0
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            newno = int(m.group(1)) if m else 0
        elif line.startswith("+") and not line.startswith("+++"):
            if path:
                added.append((path, newno, line[1:]))
            newno += 1
        elif line.startswith(" "):
            newno += 1
    others = _git(repo, "ls-files", "--others", "--exclude-standard", "--", "*.tsx", "*.jsx") or ""
    for rel in others.splitlines():
        rel = rel.strip()
        if not rel:
            continue
        try:
            with open(os.path.join(repo, rel), encoding="utf-8", errors="ignore") as fh:
                for i, text in enumerate(fh, 1):
                    added.append((rel, i, text.rstrip("\n")))
        except Exception:
            pass
    return added


def _code_only(line):
    """Blank string literals and // and /* */ comments so the raw-element regex only
    sees JSX code. Operates per line (the diff yields isolated added lines, so block
    comments / template literals spanning multiple lines cannot be tracked) — this
    removes the common in-string / in-comment false positives, not every conceivable one."""
    out = []
    i, n, quote = 0, len(line), None
    while i < n:
        ch = line[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "\"'`":
            quote = ch
            i += 1
            continue
        if ch == "/" and i + 1 < n and line[i + 1] == "/":
            break  # line comment: drop the rest of the line
        if ch == "/" and i + 1 < n and line[i + 1] == "*":
            end = line.find("*/", i + 2)
            if end == -1:
                break  # unterminated block comment on this line: drop the rest
            i = end + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def find_violations(repo, primitives=DEFAULT_PRIMITIVES):
    have = _ds_inventory(repo, primitives)
    if not have:
        return []
    # The element name must be followed by a non-identifier char, so `<button` at the
    # end of a line (multi-line open tag) matches while `<buttonish`, `<Button`, and the
    # closing `</button` do not.
    raw_re = re.compile(r"<(%s)(?![A-Za-z0-9-])" % "|".join(sorted(have)))
    out = []
    for path, lineno, text in _added_lines(repo):
        norm = path.replace("\\", "/")
        if "/components/ui/" in norm or norm.endswith((".test.tsx", ".spec.tsx", ".stories.tsx")):
            continue
        for m in raw_re.finditer(_code_only(text)):
            out.append({"file": norm, "line": lineno, "element": m.group(1)})
    return out


def _state_dir(config, settings):
    raw = settings.get("stateDir") or DEFAULT_STATE_SUBDIR
    path = Path(raw)
    if path.is_absolute():
        return path
    hooks_dir = (config or {}).get("shared", {}).get("paths", {}).get("hooksDir", "E:/hooks")
    return Path(hooks_dir) / raw


def _state_path(state_dir, repo, session_id):
    key = hashlib.sha256((session_id or repo or "").encode("utf-8")).hexdigest()[:16]
    return Path(state_dir) / f"{key}.json"


def _read_state(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_state(p, value):
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(value), encoding="utf-8")
    except Exception:
        pass  # state failure must never make a passing Stop fail


def handler(payload, config, hcfg):
    settings = hcfg.get("settings", {})
    primitives = settings.get("primitives", DEFAULT_PRIMITIVES)
    max_repeated = int(settings.get("maxRepeatedBlocks", 2))

    repo = _repo_root(payload.get("cwd") or os.getcwd())
    if not repo:
        return  # not a git repo -> allow

    violations = find_violations(repo, primitives)
    state_file = _state_path(_state_dir(config, settings), repo, payload.get("session_id", ""))

    if not violations:
        _write_state(state_file, {"blockCount": 0})
        return

    block_count = int(_read_state(state_file).get("blockCount", 0))
    if block_count >= max_repeated:
        _write_state(state_file, {"blockCount": 0})
        print(json.dumps({
            "continue": True,
            "systemMessage": (
                f"frontend-design-gate: {len(violations)} raw-primitive issue(s) still present after "
                f"{block_count} block(s) — allowing completion. Replace with the components/ui component or "
                f"report why a raw element is required."
            ),
        }))
        return

    _write_state(state_file, {"blockCount": block_count + 1})
    shown = violations[:15]
    detail = "\n".join(
        f"  {v['file']}:{v['line']}  <{v['element']}>  ->  components/ui/{primitives.get(v['element'], v['element'])}"
        for v in shown
    )
    more = f"\n  ...and {len(violations) - len(shown)} more" if len(violations) > len(shown) else ""
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"frontend-design-gate: this change adds {len(violations)} raw HTML primitive(s) where the design "
            f"system already provides a component. Use the components/ui equivalent instead:\n{detail}{more}"
        ),
    }))


def _standalone(repo):
    repo = repo.replace("\\", "/")
    print(json.dumps({
        "repo": repo,
        "ds_have": sorted(_ds_inventory(repo, DEFAULT_PRIMITIVES)),
        "violations": find_violations(repo),
    }, indent=2))


def _self_test():
    import tempfile

    d = tempfile.mkdtemp(prefix="fdg-")

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
    w("apps/web/src/components/ui/button.tsx", "export const Button=(p)=> <button {...p}/>;\n")
    w("apps/web/src/routes/old.tsx", "export const Old=()=> <button>backlog</button>;\n")  # committed -> ignored
    g("add", "-A")
    g("commit", "-qm", "init")
    w("apps/web/src/routes/new.tsx", "export const New=()=> (<div><button>x</button><input/></div>);\n")  # added
    w("apps/web/src/components/ui/thing.tsx", "export const T=()=> <button/>;\n")  # added but in ui -> excluded

    v = find_violations(d)
    files = {x["file"] for x in v}
    elems = sorted({x["element"] for x in v})
    checks = {
        "flags added raw <button> outside ui": any(f.endswith("routes/new.tsx") for f in files),
        "ignores committed backlog (old.tsx)": not any("routes/old.tsx" in f for f in files),
        "excludes components/ui (thing.tsx)": not any("/components/ui/" in f for f in files),
        "inventory-gates: <input> not flagged (no input.tsx)": "input" not in elems,
        "did flag the button element": "button" in elems,
    }
    ok = all(checks.values())
    print(json.dumps({"pass": ok, "checks": checks, "violations": v}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(_self_test())
    if "--repo" in sys.argv:
        _standalone(sys.argv[sys.argv.index("--repo") + 1])
    else:
        run(HOOK_ID, handler)
