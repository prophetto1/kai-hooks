#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOOKS = Path("E:/hooks")
SCRIPT = HOOKS / "loop-safety" / "loop-guard.py"


def base_config(db_path: Path, *, soft_max: int | None = None, hard_max: int | None = None) -> dict:
    config = json.loads((HOOKS / "config.json").read_text(encoding="utf-8"))
    config["shared"]["paths"]["hooksDb"] = str(db_path).replace("\\", "/")
    loop = next(hook for hook in config["hooks"] if hook.get("id") == "loop-safety")
    loop["enabled"] = True
    if soft_max is not None:
        loop["settings"]["softMax"] = soft_max
    if hard_max is not None:
        loop["settings"]["hardMax"] = hard_max
    return config


def write_config(path: Path, db_path: Path, *, soft_max: int | None = None, hard_max: int | None = None) -> None:
    path.write_text(json.dumps(base_config(db_path, soft_max=soft_max, hard_max=hard_max)), encoding="utf-8")


def init_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute("""
CREATE TABLE hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  ts_iso TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  target TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  detail TEXT NOT NULL
)
""")
    con.commit()
    con.close()


def add_event(path: Path, *, session_id: str, tool_name: str, target: str, status: str, detail: str, age_seconds: float) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO hook_events "
        "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (time.time() - age_seconds, "2026-06-04T00:00:00Z", session_id, "", "hook-telemetry", "PostToolUse",
         tool_name, target, "", status, 0, detail),
    )
    con.commit()
    con.close()


def seed_failures(path: Path, *, n: int, tool_name: str, target: str, detail: str, session_id: str = "s1") -> None:
    """Insert n consecutive same-op, same-error failures (newest last)."""
    for index in range(n):
        add_event(path, session_id=session_id, tool_name=tool_name, target=target,
                  status="error", detail=detail, age_seconds=100 - index)


def invoke(config_path: Path, *, tool_name: str, tool_input: dict, session_id: str = "s1") -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    payload = {"session_id": session_id, "tool_name": tool_name, "tool_input": tool_input, "cwd": str(HOOKS)}
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        cwd=HOOKS,
    )


def classify(proc: subprocess.CompletedProcess) -> str:
    """allow = silent pass, soft = change-approach nudge, deny = hard block. Always exit 0 (fail-open)."""
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout.strip()
    if not out:
        return "allow"
    data = json.loads(out)
    hso = data.get("hookSpecificOutput", {})
    if hso.get("permissionDecision") == "deny":
        return "deny"
    if hso.get("additionalContext"):
        return "soft"
    return "allow"


def main() -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="loop-guard-test-") as td:
        root = Path(td)

        # No failure history -> allow silently.
        clean_db = root / "clean.db"
        clean_cfg = root / "clean.json"
        init_db(clean_db)
        write_config(clean_cfg, clean_db)
        checks.append(("no history allows", classify(invoke(clean_cfg, tool_name="Bash", tool_input={"command": "git commit -m x"})) == "allow"))

        # Missing hook_events table -> fail open CLEANLY, with no exception surfaced on stderr.
        missing_cfg = root / "missing.json"
        write_config(missing_cfg, root / "missing-hooks.db")
        missing_proc = invoke(missing_cfg, tool_name="Bash", tool_input={"command": "git commit -m x"})
        checks.append(("missing table allows", classify(missing_proc) == "allow"))
        stderr_lower = missing_proc.stderr.lower()
        checks.append(("missing table handled without error", "no such table" not in stderr_lower and "handler error" not in stderr_lower))

        # softMax consecutive same-op, same-error failures -> soft warning.
        soft_db = root / "soft.db"
        soft_cfg = root / "soft.json"
        init_db(soft_db)
        write_config(soft_cfg, soft_db)
        seed_failures(soft_db, n=3, tool_name="Bash", target="git commit -m wip", detail="nothing to commit")
        checks.append(("softMax warns", classify(invoke(soft_cfg, tool_name="Bash", tool_input={"command": "git commit -m again"})) == "soft"))

        # hardMax consecutive failures -> deny.
        hard_db = root / "hard.db"
        hard_cfg = root / "hard.json"
        init_db(hard_db)
        write_config(hard_cfg, hard_db)
        seed_failures(hard_db, n=5, tool_name="Bash", target="git commit -m wip", detail="nothing to commit")
        checks.append(("hardMax denies", classify(invoke(hard_cfg, tool_name="Bash", tool_input={"command": "git commit -m again"})) == "deny"))

        # A success after failures resets the chain.
        reset_db = root / "reset.db"
        reset_cfg = root / "reset.json"
        init_db(reset_db)
        write_config(reset_cfg, reset_db)
        seed_failures(reset_db, n=5, tool_name="Bash", target="git commit -m wip", detail="nothing to commit")
        add_event(reset_db, session_id="s1", tool_name="Bash", target="git commit -m wip", status="ok", detail="", age_seconds=1)
        checks.append(("success resets chain", classify(invoke(reset_cfg, tool_name="Bash", tool_input={"command": "git commit -m again"})) == "allow"))

        # A different error fingerprint breaks the chain (only the newest run counts).
        fp_db = root / "fingerprint.db"
        fp_cfg = root / "fingerprint.json"
        init_db(fp_db)
        write_config(fp_cfg, fp_db)
        for index in range(3):  # older run, different error
            add_event(fp_db, session_id="s1", tool_name="Bash", target="git commit -m wip", status="error", detail="alpha failure", age_seconds=100 - index)
        for index in range(2):  # newest run, only 2 -> below softMax
            add_event(fp_db, session_id="s1", tool_name="Bash", target="git commit -m wip", status="error", detail="beta failure", age_seconds=10 - index)
        checks.append(("different error breaks chain", classify(invoke(fp_cfg, tool_name="Bash", tool_input={"command": "git commit -m again"})) == "allow"))

        # Subcommand grouping: git commit failures must not block git push.
        sub_db = root / "subcommand.db"
        sub_cfg = root / "subcommand.json"
        init_db(sub_db)
        write_config(sub_cfg, sub_db)
        seed_failures(sub_db, n=5, tool_name="Bash", target="git commit -m wip", detail="nothing to commit")
        checks.append(("same subcommand denies", classify(invoke(sub_cfg, tool_name="Bash", tool_input={"command": "git commit -m again"})) == "deny"))
        checks.append(("different subcommand allows", classify(invoke(sub_cfg, tool_name="Bash", tool_input={"command": "git push origin main"})) == "allow"))

        # Edit family groups by file path.
        edit_db = root / "edit.db"
        edit_cfg = root / "edit.json"
        init_db(edit_db)
        write_config(edit_cfg, edit_db)
        seed_failures(edit_db, n=5, tool_name="Edit", target="E:/proj/a.txt", detail="string not found")
        checks.append(("same edit target denies", classify(invoke(edit_cfg, tool_name="Edit", tool_input={"file_path": "E:/proj/a.txt"})) == "deny"))
        checks.append(("different edit target allows", classify(invoke(edit_cfg, tool_name="Edit", tool_input={"file_path": "E:/proj/b.txt"})) == "allow"))

        # Different session is isolated.
        sess_db = root / "session.db"
        sess_cfg = root / "session.json"
        init_db(sess_db)
        write_config(sess_cfg, sess_db)
        seed_failures(sess_db, n=5, tool_name="Bash", target="git commit -m wip", detail="nothing to commit", session_id="s1")
        checks.append(("other session isolated", classify(invoke(sess_cfg, tool_name="Bash", tool_input={"command": "git commit -m again"}, session_id="s2")) == "allow"))

    failures = [name for name, ok in checks if not ok]
    if failures:
        print(json.dumps({"failures": failures}, indent=2))
        return 1
    print("loop guard tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
