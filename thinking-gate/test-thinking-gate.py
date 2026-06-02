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
SCRIPT = HOOKS / "thinking-gate" / "thinking-gate.py"
THINKING_TOOL = "mcp__mcp_router__sequentialthinking"
GATED_TOOL = "Write"


def base_config(db_path: Path) -> dict:
    config = json.loads((HOOKS / "config.json").read_text(encoding="utf-8"))
    config["shared"]["paths"]["hooksDb"] = str(db_path).replace("\\", "/")
    config["hooks"] = [
        hook for hook in config["hooks"]
        if hook.get("id") not in {"thinking-gate", "loop-safety"}
    ]
    config["hooks"].append({
        "id": "thinking-gate",
        "name": "Sequential Thinking Gate",
        "description": "Test fixture.",
        "category": "gate",
        "event": "PreToolUse",
        "match": {"tools": ["*"]},
        "script": {"path": "thinking-gate/thinking-gate.py", "runtime": "python"},
        "scope": {"projects": ["*"], "paths": ["**"]},
        "enabled": True,
        "failPolicy": "open",
        "settings": {
            "table": "hook_events",
            "consumptionTable": "thinking_gate_consumptions",
            "grantPolicy": {
                "mode": "bounded_tool_count",
                "maxToolUses": 2,
            },
            "thinkingTools": [THINKING_TOOL],
            "bootstrapTools": {
                "ToolSearch": ["sequentialthinking", "sequential thinking"],
            },
            "ttlSeconds": 120,
        },
    })
    return config


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


def init_old_unique_consumption_table(path: Path, table: str = "thinking_gate_consumptions") -> None:
    con = sqlite3.connect(path)
    con.execute(f"""
CREATE TABLE {table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  session_id TEXT NOT NULL,
  thinking_event_id INTEGER NOT NULL UNIQUE,
  tool_name TEXT NOT NULL
)
""")
    con.commit()
    con.close()


def add_event(path: Path, *, session_id: str, tool_name: str, status: str, age_seconds: int) -> None:
    now = time.time()
    ts = now - age_seconds
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO hook_events "
        "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            ts,
            "2026-06-02T00:00:00Z",
            session_id,
            "",
            "hook-telemetry",
            "PostToolUse",
            tool_name,
            "",
            "",
            status,
            0,
            "",
        ),
    )
    con.commit()
    con.close()


def invoke(
    config_path: Path,
    *,
    session_id: str = "s1",
    tool_name: str = GATED_TOOL,
    tool_input: dict | None = None,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    payload = {
        "session_id": session_id,
        "tool_name": tool_name,
        "tool_input": tool_input if tool_input is not None else {"file_path": "x.txt", "content": "test"},
        "cwd": str(HOOKS),
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        cwd=HOOKS,
    )


def decision(proc: subprocess.CompletedProcess) -> str:
    assert proc.returncode == 0, proc.stderr
    if not proc.stdout.strip():
        return "allow"
    data = json.loads(proc.stdout)
    return data.get("hookSpecificOutput", {}).get("permissionDecision", "allow")


def write_config(path: Path, db_path: Path, *, max_uses: int = 2) -> None:
    config = base_config(db_path)
    config["hooks"][-1]["settings"]["grantPolicy"]["maxToolUses"] = max_uses
    path.write_text(json.dumps(config), encoding="utf-8")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="thinking-gate-test-") as td:
        root = Path(td)
        db_path = root / "hooks.db"
        config_path = root / "config.json"
        init_db(db_path)
        write_config(config_path, db_path)

        checks = []

        checks.append(("allows thinking tool itself", decision(invoke(config_path, tool_name=THINKING_TOOL)) == "allow"))
        checks.append((
            "allows bootstrap ToolSearch for thinking lookup",
            decision(invoke(
                config_path,
                tool_name="ToolSearch",
                tool_input={"query": "sequentialthinking"},
            )) == "allow",
        ))
        checks.append((
            "denies non-bootstrap ToolSearch without thinking",
            decision(invoke(
                config_path,
                tool_name="ToolSearch",
                tool_input={"query": "browser automation"},
            )) == "deny",
        ))
        checks.append(("denies write without thinking", decision(invoke(config_path)) == "deny"))
        checks.append(("denies read without thinking", decision(invoke(config_path, tool_name="Read")) == "deny"))
        checks.append((
            "denies shell inspection without thinking",
            decision(invoke(
                config_path,
                tool_name="Bash",
                tool_input={"command": "rg thinking-gate E:/hooks/thinking-gate"},
            )) == "deny",
        ))
        checks.append(("denies unknown tool without thinking", decision(invoke(config_path, tool_name="mcp__example__file_write")) == "deny"))

        add_event(db_path, session_id="s1", tool_name=THINKING_TOOL, status="ok", age_seconds=5)
        checks.append(("allows first matched tool after fresh thinking", decision(invoke(config_path, tool_name="Read")) == "allow"))
        checks.append(("allows second matched tool after same thinking", decision(invoke(config_path, tool_name="Bash", tool_input={"command": "rg x"})) == "allow"))
        checks.append(("denies third matched tool after grant exhausted", decision(invoke(config_path, tool_name="Write")) == "deny"))

        later_non_thinking_db = root / "later-non-thinking.db"
        later_non_thinking_config = root / "later-non-thinking-config.json"
        init_db(later_non_thinking_db)
        write_config(later_non_thinking_config, later_non_thinking_db)
        add_event(later_non_thinking_db, session_id="s1", tool_name=THINKING_TOOL, status="ok", age_seconds=5)
        add_event(later_non_thinking_db, session_id="s1", tool_name=GATED_TOOL, status="ok", age_seconds=1)
        checks.append(("allows after later non-thinking event while grant remains", decision(invoke(later_non_thinking_config)) == "allow"))

        max_one_db = root / "max-one.db"
        max_one_config = root / "max-one-config.json"
        init_db(max_one_db)
        write_config(max_one_config, max_one_db, max_uses=1)
        add_event(max_one_db, session_id="s1", tool_name=THINKING_TOOL, status="ok", age_seconds=5)
        checks.append(("maxToolUses=1 allows first matched tool", decision(invoke(max_one_config)) == "allow"))
        checks.append(("maxToolUses=1 denies second matched tool", decision(invoke(max_one_config)) == "deny"))

        max_five_db = root / "max-five.db"
        max_five_config = root / "max-five-config.json"
        init_db(max_five_db)
        write_config(max_five_config, max_five_db, max_uses=5)
        add_event(max_five_db, session_id="s1", tool_name=THINKING_TOOL, status="ok", age_seconds=5)
        for index in range(5):
            checks.append((f"maxToolUses=5 allows matched tool {index + 1}", decision(invoke(max_five_config, tool_name=f"Tool{index}")) == "allow"))
        checks.append(("maxToolUses=5 denies sixth matched tool", decision(invoke(max_five_config, tool_name="Tool5")) == "deny"))

        failed_db = root / "failed.db"
        failed_config = root / "failed-config.json"
        init_db(failed_db)
        write_config(failed_config, failed_db)
        add_event(failed_db, session_id="s1", tool_name=THINKING_TOOL, status="error", age_seconds=5)
        checks.append(("denies failed thinking event", decision(invoke(failed_config)) == "deny"))

        empty_db_config = root / "empty-db-config.json"
        write_config(empty_db_config, root / "empty-hooks.db")
        checks.append(("denies when hook_events table is missing", decision(invoke(empty_db_config)) == "deny"))

        init_db(root / "stale.db")
        stale_config_path = root / "stale-config.json"
        write_config(stale_config_path, root / "stale.db")
        add_event(root / "stale.db", session_id="s1", tool_name=THINKING_TOOL, status="ok", age_seconds=500)
        checks.append(("denies stale thinking", decision(invoke(stale_config_path)) == "deny"))

        init_db(root / "other-session.db")
        other_config_path = root / "other-session-config.json"
        write_config(other_config_path, root / "other-session.db")
        add_event(root / "other-session.db", session_id="other", tool_name=THINKING_TOOL, status="ok", age_seconds=5)
        checks.append(("denies different session", decision(invoke(other_config_path)) == "deny"))

        unique_db = root / "unique.db"
        unique_config = root / "unique-config.json"
        init_db(unique_db)
        init_old_unique_consumption_table(unique_db)
        write_config(unique_config, unique_db)
        add_event(unique_db, session_id="s1", tool_name=THINKING_TOOL, status="ok", age_seconds=5)
        checks.append(("migrates old unique table and allows first use", decision(invoke(unique_config)) == "allow"))
        checks.append(("migrated table allows second use of same grant", decision(invoke(unique_config, tool_name="Edit")) == "allow"))

        failures = [name for name, ok in checks if not ok]
        if failures:
            print(json.dumps({"failures": failures}, indent=2))
            return 1

    print("thinking gate tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
