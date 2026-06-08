#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS = Path("E:/hooks")
SCRIPT = HOOKS / "hook-telemetry" / "log-event.py"


def base_config(db_path: Path, *, enabled: bool = True) -> dict:
    config = json.loads((HOOKS / "config.json").read_text(encoding="utf-8"))
    config["shared"]["paths"]["hooksDb"] = str(db_path).replace("\\", "/")
    hook = next(h for h in config["hooks"] if h["id"] == "hook-telemetry")
    hook["enabled"] = enabled
    return config


def write_config(path: Path, db_path: Path, *, enabled: bool = True) -> None:
    path.write_text(json.dumps(base_config(db_path, enabled=enabled)), encoding="utf-8")


def invoke(config_path: Path, payload: dict) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=HOOKS,
        env=env,
    )


def rows(db_path: Path):
    if not db_path.exists():
        return []
    con = sqlite3.connect(db_path)
    try:
        try:
            return con.execute("SELECT tool_name, event, status, detail FROM hook_events ORDER BY id").fetchall()
        except sqlite3.OperationalError:
            return []
    finally:
        con.close()


def post(tool_name: str, **response) -> dict:
    return {
        "hook_event_name": "PostToolUse",
        "session_id": "telemetry-test",
        "cwd": "E:/hooks",
        "tool_name": tool_name,
        "tool_input": {"command": "x"},
        "tool_response": response,
    }


def main() -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="telemetry-log-test-") as td:
        root = Path(td)

        # Status classification is derived structurally from the response envelope.
        db = root / "hooks.db"
        cfg = root / "config.json"
        write_config(cfg, db)
        for payload in (
            post("Bash", exit_code=0),
            post("Bash", exit_code=1),
            post("Edit", success=False),
            post("Write", is_error=True),
            post("Read", status="failed"),
        ):
            proc = invoke(cfg, payload)
            assert proc.returncode == 0, proc.stderr
        recorded = [(tn, st) for tn, ev, st, detail in rows(db)]
        checks.append(("structural status classification", recorded == [
            ("Bash", "ok"), ("Bash", "error"), ("Edit", "error"), ("Write", "error"), ("Read", "error"),
        ], recorded))

        # PostToolUseFailure event -> error, even with no response envelope.
        db2 = root / "hooks2.db"
        cfg2 = root / "config2.json"
        write_config(cfg2, db2)
        invoke(cfg2, {
            "hook_event_name": "PostToolUseFailure",
            "session_id": "t",
            "cwd": "E:/hooks",
            "tool_name": "Bash",
            "tool_input": {"command": "x"},
            "error": "boom",
        })
        r2 = rows(db2)
        checks.append(("PostToolUseFailure is error", len(r2) == 1 and r2[0][2] == "error", r2))

        # No free-text scan: a successful tool whose output contains "error:" stays ok.
        db3 = root / "hooks3.db"
        cfg3 = root / "config3.json"
        write_config(cfg3, db3)
        invoke(cfg3, post("Bash", exit_code=0, stdout="error: this is fine"))
        r3 = rows(db3)
        checks.append(("no text-scan misclassification", len(r3) == 1 and r3[0][2] == "ok", r3))

        # Disabled hook records nothing.
        db4 = root / "hooks4.db"
        cfg4 = root / "config4.json"
        write_config(cfg4, db4, enabled=False)
        invoke(cfg4, post("Bash", exit_code=0))
        checks.append(("disabled writes nothing", rows(db4) == [], rows(db4)))

        # Error detail is captured and truncated to detailMaxChars (500 in config).
        db5 = root / "hooks5.db"
        cfg5 = root / "config5.json"
        write_config(cfg5, db5)
        invoke(cfg5, post("Bash", exit_code=1, message="z" * 5000))
        r5 = rows(db5)
        detail_len = len(r5[0][3]) if r5 else 0
        checks.append(("error detail captured + truncated", 0 < detail_len <= 500, detail_len))

    failures = [{"check": name, "info": str(info)} for name, ok, info in checks if not ok]
    if failures:
        print(json.dumps({"failures": failures}, indent=2))
        return 1
    print("telemetry log-event tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
