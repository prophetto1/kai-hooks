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
SCRIPT = HOOKS / "browser-verify-gate" / "browser-verify-gate.py"

NAVIGATE_TOOL = "mcp__plugin_playwright_playwright__browser_navigate"
SNAPSHOT_TOOL = "mcp__plugin_playwright_playwright__browser_snapshot"
EDIT_TOOL = "apply_patch"


def base_config(root: Path) -> dict:
    config = json.loads((HOOKS / "config.json").read_text(encoding="utf-8"))
    config["shared"]["paths"]["hooksDb"] = str(root / "hooks.db").replace("\\", "/")
    hooks = [h for h in config["hooks"] if h.get("id") != "browser-verify-gate"]
    hooks.append({
        "id": "browser-verify-gate",
        "name": "Browser Verification Gate",
        "description": "test fixture",
        "category": "gate",
        "event": "Stop",
        "match": {"tools": ["*"]},
        "script": {"path": "browser-verify-gate/browser-verify-gate.py", "runtime": "python"},
        "scope": {"projects": ["*"], "paths": ["**"]},
        "enabled": True,
        "failPolicy": "open",
        "settings": {
            "table": "hook_events",
            "minToolUses": 15,
            "maxRepeatedBlocks": 2,
            "requireSnapshot": True,
            "navigatePatterns": ["browser_navigate", "navigate_page"],
            "inspectPatterns": ["browser_snapshot", "take_snapshot", "browser_take_screenshot", "take_screenshot"],
            "relevantToolPatterns": [],
            "relevantTargetPatterns": ["apps/web/", "pnpm run build", "npm run build", "playwright", "ui-snapshot"],
            "stateDir": str(root / "state").replace("\\", "/"),
        },
    })
    config["hooks"] = hooks
    return config


def init_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute("""
CREATE TABLE hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  ts_iso TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  hook_id TEXT,
  event TEXT,
  tool_name TEXT,
  target TEXT,
  decision TEXT,
  status TEXT,
  duration_ms INTEGER,
  detail TEXT
)
""")
    con.commit()
    con.close()


def add_rows(path: Path, *, session_id: str, count: int, tool_name: str = "Bash", target: str = "", hook_id: str = "hook-telemetry") -> None:
    con = sqlite3.connect(path)
    now = time.time()
    for index in range(count):
        con.execute(
            "INSERT INTO hook_events (ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (now + index, "2026-06-05T00:00:00Z", session_id, "", hook_id, "PostToolUse", tool_name, target, "", "ok", None, ""),
        )
    con.commit()
    con.close()


def invoke(config_path: Path, *, session_id: str, stop_active: bool = False) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    payload = {"hook_event_name": "Stop", "session_id": session_id, "cwd": str(HOOKS), "stop_hook_active": stop_active}
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=HOOKS,
        env=env,
    )


def decision(proc: subprocess.CompletedProcess) -> str:
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout.strip()
    if not out:
        return "allow"
    data = json.loads(out)
    return "block" if data.get("decision") == "block" else "allow"


def main() -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="browser-verify-test-") as td:
        root = Path(td)
        db = root / "hooks.db"
        cfg = root / "config.json"
        init_db(db)
        cfg.write_text(json.dumps(base_config(root)), encoding="utf-8")

        # 1) Small turn (<= minToolUses): allow.
        add_rows(db, session_id="small", count=10)
        checks.append(("small turn allows", decision(invoke(cfg, session_id="small")) == "allow"))

        # 2) Large read-only turn with no browser-relevant signal: allow.
        add_rows(db, session_id="readonly", count=20)
        checks.append(("large read-only turn allows", decision(invoke(cfg, session_id="readonly")) == "allow"))

        # 3) Large hooks-only patch turn: allow.
        add_rows(db, session_id="hookspatch", count=20)
        add_rows(
            db,
            session_id="hookspatch",
            count=1,
            tool_name=EDIT_TOOL,
            target="*** Begin Patch\n*** Update File: E:/hooks/config.json\n+ apps/web/ playwright ui-snapshot\n",
        )
        checks.append(("large hooks-only patch allows", decision(invoke(cfg, session_id="hookspatch")) == "allow"))

        # 4) Large browser-relevant turn, no browser verification: block.
        add_rows(db, session_id="large", count=20)
        add_rows(db, session_id="large", count=1, tool_name=EDIT_TOOL, target="*** Update File: apps/web/src/routes/settings.tsx")
        checks.append(("large turn without browser blocks", decision(invoke(cfg, session_id="large")) == "block"))

        # 5) Large browser-relevant turn with navigate + snapshot: allow.
        add_rows(db, session_id="verified", count=20)
        add_rows(db, session_id="verified", count=1, tool_name=EDIT_TOOL, target="*** Update File: apps/web/src/routes/settings.tsx")
        add_rows(db, session_id="verified", count=1, tool_name=NAVIGATE_TOOL)
        add_rows(db, session_id="verified", count=1, tool_name=SNAPSHOT_TOOL)
        checks.append(("large turn with navigate+snapshot allows", decision(invoke(cfg, session_id="verified")) == "allow"))

        # 6) Large browser-relevant turn navigated but not inspected (requireSnapshot=true): block.
        add_rows(db, session_id="navonly", count=20)
        add_rows(db, session_id="navonly", count=1, tool_name=EDIT_TOOL, target="*** Update File: apps/web/src/routes/settings.tsx")
        add_rows(db, session_id="navonly", count=1, tool_name=NAVIGATE_TOOL)
        checks.append(("navigate without snapshot blocks", decision(invoke(cfg, session_id="navonly")) == "block"))

        # 7) Loop-safety: after maxRepeatedBlocks consecutive blocks, release (allow).
        add_rows(db, session_id="loop", count=20)
        add_rows(db, session_id="loop", count=1, tool_name=EDIT_TOOL, target="*** Update File: apps/web/src/routes/settings.tsx")
        first = decision(invoke(cfg, session_id="loop", stop_active=False))
        second = decision(invoke(cfg, session_id="loop", stop_active=True))
        third = decision(invoke(cfg, session_id="loop", stop_active=True))
        checks.append(("loop blocks then releases", (first, second, third) == ("block", "block", "allow")))

        # 8) Missing telemetry table -> allow (fail-open, no noise).
        empty_db_cfg = root / "empty-config.json"
        empty_cfg = base_config(root)
        empty_cfg["shared"]["paths"]["hooksDb"] = str(root / "absent.db").replace("\\", "/")
        empty_db_cfg.write_text(json.dumps(empty_cfg), encoding="utf-8")
        miss = invoke(empty_db_cfg, session_id="x")
        checks.append(("missing telemetry db allows cleanly", decision(miss) == "allow" and "Traceback" not in miss.stderr))

    failures = [name for name, ok in checks if not ok]
    if failures:
        print(json.dumps({"failures": failures}, indent=2))
        return 1
    print("browser-verify-gate tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
