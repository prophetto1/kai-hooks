#!/usr/bin/env python
"""hook-telemetry (PostToolUse + PostToolUseFailure): append one row per tool firing to
`hook_events` in the DEDICATED hooks DB (shared.paths.hooksDb), via the shared hook_runtime.

STATUS is derived from the EVENT, not from scanning output text:
  - PostToolUseFailure (Claude's failure event) -> status=error
  - PostToolUse        -> status=ok, unless the response ENVELOPE structurally signals an
                          error (is_error/success:false/non-zero exit) — e.g. Codex non-zero
                          Bash. No free-text scan, so a successful grep that prints "error:"
                          is NOT misclassified.
This is the substrate loop-safety counts, so signal quality is load-bearing.

The runtime enforces enabled + failPolicy + match.tools and is fail-open: errors never block
a tool call.
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from hook_runtime import connect, detect_project, extract_target, hooks_db, run, safe_table  # noqa: E402

SCHEMA_VERSION = 1


def ddl_for(table):
    return f"""
CREATE TABLE IF NOT EXISTS {table} (
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
);
CREATE INDEX IF NOT EXISTS idx_{table}_session_ts ON {table}(session_id, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {table}(ts);
"""


def ensure_schema(con, table):
    """Create the table + indexes ONCE (gated by PRAGMA user_version), and drop the legacy
    single-column indexes the loop-safety query never used. Cheap no-op on every later call."""
    if con.execute("PRAGMA user_version").fetchone()[0] >= SCHEMA_VERSION:
        return
    con.executescript(ddl_for(table))
    for ix in (f"idx_{table}_event", f"idx_{table}_tool", f"idx_{table}_session"):
        con.execute(f"DROP INDEX IF EXISTS {ix}")
    con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def envelope_error(tool_response):
    """Detect a failure from STRUCTURED envelope fields only — never by scanning body text."""
    tr = tool_response
    if isinstance(tr, dict):
        for k in ("is_error", "isError", "iserror"):
            if tr.get(k) is True:
                return True
        if tr.get("success") is False:
            return True
        for k in ("exit_code", "exitCode", "returncode", "code"):
            v = tr.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v != 0:
                return True
        st = tr.get("status")
        if isinstance(st, str) and st.lower() in ("error", "failed", "failure"):
            return True
    return False


def handler(payload, config, hcfg):
    settings = hcfg.get("settings", {})
    table = safe_table(settings.get("table", "hook_events"), "hook_events")
    detail_max = int(settings.get("detailMaxChars", 500))
    retention_days = settings.get("retentionDays", 0)
    prune_every = int(settings.get("retentionPruneEvery", 500))

    event = payload.get("hook_event_name", "PostToolUse")
    tool_input = payload.get("tool_input", {})
    tool_response = payload.get("tool_response", payload.get("tool_result"))
    status = "error" if (event == "PostToolUseFailure" or envelope_error(tool_response)) else "ok"

    detail = ""
    if status == "error":
        src = tool_response
        if not src:  # PostToolUseFailure may carry the failure elsewhere
            src = payload.get("error") or payload.get("tool_error") or payload.get("message")
        if src:
            detail = (src if isinstance(src, str) else json.dumps(src))[:detail_max]

    now = time.time()
    row = (
        now,
        time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)),
        payload.get("session_id", ""),
        detect_project(payload.get("cwd", ""), config.get("shared", {}).get("projects", [])),
        "hook-telemetry",
        event,
        payload.get("tool_name", ""),
        extract_target(payload.get("tool_name", ""), tool_input),
        "",
        status,
        None,
        detail,
    )

    con = connect(hooks_db(config))
    try:
        ensure_schema(con, table)
        cur = con.execute(
            f"INSERT INTO {table} "
            "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
        if (isinstance(retention_days, (int, float)) and retention_days > 0
                and prune_every > 0 and cur.lastrowid and cur.lastrowid % prune_every == 0):
            con.execute(f"DELETE FROM {table} WHERE ts < ?", (now - retention_days * 86400,))
        con.commit()
    finally:
        con.close()


if __name__ == "__main__":
    run("hook-telemetry", handler)
