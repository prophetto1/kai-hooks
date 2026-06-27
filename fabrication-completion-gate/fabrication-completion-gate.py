#!/usr/bin/env python
"""fabrication-completion-gate (Stop): block completion when the CURRENT change ADDS
lines that match the configured no-fabrication detectors.

Detectors live in config.json under this hook's settings.rules, so the prohibited set
(mocks, fake/demo/sample product state, fallback-to-local/default product IDs,
safe-default workspace/project/store/provider, backend-bypassing browser fallback,
placeholder rows implying live state, route-interception-as-verification, etc.) is
UPDATABLE without a code change.

Only newly-ADDED diff lines are checked (git diff vs HEAD + untracked files) - never the
pre-existing backlog, so it cannot block completion over code you did not touch. Reads
git only (no telemetry, so it is immune to WAL read-visibility lag). Loop-safe (releases
after maxRepeatedBlocks) and fail-open (any error, a non-repo Stop, or an empty ruleset
allows). Scope (which repos) is handled by config.json scope.projects via hook_runtime;
within a repo, test/vendored paths are excluded and `integrity:allow <id> <reason>`
exempts an audited line.

Run modes:
  (hook)        echo '<stop payload>' | python fabrication-completion-gate.py
  --repo PATH   python fabrication-completion-gate.py --repo E:/kai-chattr   # print findings, no gating
  --self-test   python fabrication-completion-gate.py --self-test            # prove behavior in a temp repo
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_core"))
from hook_runtime import run  # noqa: E402

HOOK_ID = "fabrication-completion-gate"
DEFAULT_STATE_SUBDIR = ".state/fabrication-completion-gate"
DEFAULT_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"]
ALLOW_MARK = "integrity:allow"
# Test doubles are allowed; vendored/reference code is not ours. Always excluded.
DEFAULT_PATH_EXCLUDES = [
    "**/*.test.*", "**/*.spec.*", "**/*.stories.*",
    "**/tests/**", "**/__tests__/**", "**/__mocks__/**", "**/e2e/**",
    "**/vendor/**", "**/_extract_ref/**", "**/references/**", "**/___references*/**",
    "**/.storybook/**", "**/storybook/**",
]


def _git(repo, *args):
    try:
        p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=5)
        return p.stdout if p.returncode == 0 else None
    except Exception:
        return None


def _repo_root(cwd):
    out = _git(cwd, "rev-parse", "--show-toplevel")
    return out.strip().replace("\\", "/") if out else None


def _pathspec(extensions):
    return [f"*.{str(e).lstrip('.')}" for e in (extensions or DEFAULT_EXTENSIONS)]


def _added_lines(repo, extensions):
    """[(path, lineno, text)] for lines ADDED vs HEAD plus whole untracked file contents."""
    added = []
    spec = _pathspec(extensions)
    diff = _git(repo, "diff", "--unified=0", "HEAD", "--", *spec) or ""
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
    others = _git(repo, "ls-files", "--others", "--exclude-standard", "--", *spec) or ""
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


def _matches_any(path, globs):
    return any(fnmatch.fnmatch(path, g) for g in (globs or []))


def _compile_rules(rules):
    compiled = []
    for r in rules or []:
        pat = r.get("regex")
        if not pat:
            continue
        flags = re.IGNORECASE if "i" in (r.get("flags") or "") else 0
        try:
            rx = re.compile(pat, flags)
        except re.error:
            continue  # a malformed rule must never crash the gate (fail-open)
        compiled.append({
            "id": r.get("id", "rule"),
            "title": r.get("title", r.get("id", "rule")),
            "rx": rx,
            "include": r.get("pathInclude"),
            "exclude": r.get("pathExclude"),
            "message": r.get("message", ""),
        })
    return compiled


def find_violations(repo, rules, extensions=None, path_excludes=None):
    compiled = _compile_rules(rules)
    if not compiled:
        return []  # no ruleset -> inert (fail-open)
    excludes = list(path_excludes or []) + DEFAULT_PATH_EXCLUDES
    out = []
    for path, lineno, text in _added_lines(repo, extensions):
        norm = path.replace("\\", "/")
        if _matches_any(norm, excludes):
            continue
        if ALLOW_MARK in text:
            continue  # audited inline exception: integrity:allow <id> <reason>
        for rule in compiled:
            if rule["include"] and not _matches_any(norm, rule["include"]):
                continue
            if rule["exclude"] and _matches_any(norm, rule["exclude"]):
                continue
            if rule["rx"].search(text):
                out.append({
                    "file": norm, "line": lineno, "rule": rule["id"],
                    "title": rule["title"], "message": rule["message"],
                })
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
    rules = settings.get("rules", [])
    extensions = settings.get("extensions")
    path_excludes = settings.get("pathExcludes")
    max_repeated = int(settings.get("maxRepeatedBlocks", 3))

    repo = _repo_root(payload.get("cwd") or os.getcwd())
    if not repo:
        return  # not a git repo -> allow

    violations = find_violations(repo, rules, extensions, path_excludes)
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
                f"fabrication-completion-gate: {len(violations)} no-fabrication issue(s) still present after "
                f"{block_count} block(s) — allowing completion. Remove the fabricated/default/mock state, fix the "
                f"real backend/state, or add an audited `integrity:allow <id> <reason>` with justification."
            ),
        }))
        return

    _write_state(state_file, {"blockCount": block_count + 1})
    shown = violations[:15]
    detail = "\n".join(
        f"  {v['file']}:{v['line']}  [{v['rule']}] {v['title']}" + (f" — {v['message']}" if v["message"] else "")
        for v in shown
    )
    more = f"\n  ...and {len(violations) - len(shown)} more" if len(violations) > len(shown) else ""
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"fabrication-completion-gate: this change adds {len(violations)} line(s) matching the no-fabrication "
            f"policy. Fix the real backend/API/state or fail honestly — do not ship mocked/default/fabricated "
            f"product state. If a hit is a legitimate exception, annotate the line with "
            f"`integrity:allow <id> <reason>`:\n{detail}{more}"
        ),
    }))


def _load_rules_from_config():
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return []
    for hook in cfg.get("hooks", []):
        if hook.get("id") == HOOK_ID:
            return hook.get("settings", {}).get("rules", [])
    return []


def _standalone(repo):
    repo = repo.replace("\\", "/")
    rules = _load_rules_from_config()
    print(json.dumps({
        "repo": repo,
        "rule_count": len(rules),
        "violations": find_violations(repo, rules),
    }, indent=2))


def _self_test():
    import tempfile

    d = tempfile.mkdtemp(prefix="fcg-")

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
    w("apps/web/src/old.ts", "export const LEGACY = 'local' // backlog\n")  # committed -> ignored
    g("add", "-A")
    g("commit", "-qm", "init")
    w("apps/web/src/routes/new.ts", "export const DEFAULT_WORKSPACE_PUBLIC_ID = 'local'\n")  # added -> flag
    w("apps/web/src/routes/ok.ts", "const w = real // integrity:allow INT-001 reviewed real value\n")  # allow-marked
    w("services/api/app/repo.py", "    except Exception:\n        return default_config()\n")  # added -> flag
    w("apps/web/src/x.test.ts", "export const DEFAULT_PROJECT_ID = 'local'\n")  # test -> ignored

    rules = [
        {"id": "INT-001", "title": "default product id",
         "regex": r"DEFAULT_[A-Z_]*(WORKSPACE|PROJECT|STORE|PROVIDER|USER|OWNER)[A-Z_]*\s*=\s*['\"]"},
        {"id": "INT-002", "title": "except returns default",
         "regex": r"except\s+\w*Exception\w*\s*:"},
    ]
    v = find_violations(d, rules)
    files = {x["file"] for x in v}
    rule_hits = sorted({x["rule"] for x in v})
    checks = {
        "flags added default-id in product code": any(f.endswith("routes/new.ts") for f in files),
        "ignores committed backlog (old.ts)": not any(f.endswith("/old.ts") for f in files),
        "ignores test files (x.test.ts)": not any(".test." in f for f in files),
        "respects integrity:allow (ok.ts)": not any(f.endswith("routes/ok.ts") for f in files),
        "flags except-return-default (py)": any(f.endswith("repo.py") for f in files),
        "both rules fired": rule_hits == ["INT-001", "INT-002"],
        "empty ruleset is inert": find_violations(d, []) == [],
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
