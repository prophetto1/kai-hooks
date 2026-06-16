#!/usr/bin/env python
"""thinking-gate (PreToolUse): require planning checkpoints before matched tool use.

The gate reads the hook_events telemetry substrate and allows matched tools when a
recent successful configured planning tool grants enough remaining uses. The
planning tool itself is always allowed so the gate cannot deadlock the required
action.
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_core"))
from hook_runtime import connect, hooks_db, run, safe_table  # noqa: E402

CANONICAL_THINKING_TOOL = "mcp__mcp-router__sequentialthinking"

DEFAULT_THINKING_TOOLS = [
    "MCP:sequentialthinking",
    "CallMcpTool",
    "mcp__mcp_router__sequentialthinking",
    CANONICAL_THINKING_TOOL,
    "mcp__sequential-thinking__sequentialthinking",
    "mcp__sequentialthinking__sequentialthinking",
    "mcp__plugin_sequential-thinking_sequential-thinking__sequentialthinking",
    "mcp__plugin_sequentialthinking_sequentialthinking__sequentialthinking",
    "mcp__mcp_router.sequentialthinking",
]


def configured_thinking_tools(settings: dict) -> list[str]:
    raw = settings.get("thinkingTools")
    if not isinstance(raw, list) or not raw:
        return DEFAULT_THINKING_TOOLS
    return list(dict.fromkeys(str(item) for item in raw if str(item)))


def _normalized_st_text(value) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _looks_like_sequentialthinking(value) -> bool:
    return "sequentialthinking" in _normalized_st_text(value)


def call_mcp_tool_name(tool_input) -> str:
    if not isinstance(tool_input, dict):
        return ""
    for key in ("toolName", "tool", "name"):
        value = tool_input.get(key)
        if value:
            return str(value)
    return ""


def normalize_thinking_tool_name(tool_name: str, tool_input=None) -> str:
    if tool_name == "MCP:sequentialthinking":
        return CANONICAL_THINKING_TOOL
    if tool_name == "CallMcpTool" and _looks_like_sequentialthinking(call_mcp_tool_name(tool_input)):
        return CANONICAL_THINKING_TOOL
    return tool_name


def is_thinking_tool_call(tool_name: str, tool_input, thinking_tools: list[str]) -> bool:
    if tool_name == "CallMcpTool":
        return _looks_like_sequentialthinking(call_mcp_tool_name(tool_input))
    normalized = normalize_thinking_tool_name(tool_name, tool_input)
    return tool_name in thinking_tools or normalized in thinking_tools


def grant_lookup_thinking_tools(thinking_tools: list[str]) -> list[str]:
    names = []
    for name in thinking_tools:
        if name == "CallMcpTool":
            continue
        names.append(normalize_thinking_tool_name(name))
        names.append(name)
    names.append(CANONICAL_THINKING_TOOL)
    names.append("MCP:sequentialthinking")
    return list(dict.fromkeys(name for name in names if name))


def bootstrap_allowed(settings: dict, tool_name: str, tool_input) -> bool:
    tools = settings.get("bootstrapTools")
    if not isinstance(tools, dict):
        return False
    allowed_terms = tools.get(tool_name)
    if not isinstance(allowed_terms, list) or not allowed_terms:
        return False
    text = ""
    if isinstance(tool_input, dict):
        for key in ("query", "q", "pattern", "tool", "name", "toolName", "server"):
            value = tool_input.get(key)
            if value:
                text += f" {value}"
    else:
        text = str(tool_input or "")
    lowered = text.lower()
    return any(str(term).lower() in lowered for term in allowed_terms if str(term))


def positive_int(value, default: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        return default
    return parsed if parsed > 0 else default


def grant_policy(settings: dict) -> dict:
    raw = settings.get("grantPolicy")
    return raw if isinstance(raw, dict) else {}


def max_tool_uses(settings: dict) -> int:
    return positive_int(grant_policy(settings).get("maxToolUses"), 1)


def ttl_seconds(settings: dict) -> int:
    policy = grant_policy(settings)
    return positive_int(policy.get("ttlSeconds", settings.get("ttlSeconds", 300)), 300)


def table_exists(con, table: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone() is not None


def table_sql(con, table: str) -> str:
    row = con.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return str(row[0] or "") if row else ""


def migrate_unique_consumption_table(con, table: str) -> None:
    sql = table_sql(con, table).lower()
    if "thinking_event_id integer not null unique" not in sql:
        return
    tmp = f"{table}_v2"
    con.execute(f"DROP TABLE IF EXISTS {tmp}")
    con.execute(f"""
CREATE TABLE {tmp} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  session_id TEXT NOT NULL,
  thinking_event_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL
)
""")
    con.execute(
        f"INSERT INTO {tmp} (id, ts, session_id, thinking_event_id, tool_name) "
        f"SELECT id, ts, session_id, thinking_event_id, tool_name FROM {table}"
    )
    con.execute(f"DROP TABLE {table}")
    con.execute(f"ALTER TABLE {tmp} RENAME TO {table}")


def ensure_consumption_schema(con, table: str) -> None:
    if table_exists(con, table):
        migrate_unique_consumption_table(con, table)
    con.execute(f"""
CREATE TABLE IF NOT EXISTS {table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  session_id TEXT NOT NULL,
  thinking_event_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL
)
""")
    con.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_session_ts ON {table}(session_id, ts DESC, id DESC)")
    con.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_thinking_event ON {table}(session_id, thinking_event_id, ts DESC)")


def latest_successful_thinking_event(con, table: str, session_id: str, cutoff: float, thinking_tools: list[str]):
    if not table_exists(con, table):
        return None
    grant_tools = grant_lookup_thinking_tools(thinking_tools)
    placeholders = ",".join("?" for _ in grant_tools)
    return con.execute(
        f"SELECT id, tool_name, status, ts FROM {table} "
        f"WHERE session_id=? AND ts>=? AND status='ok' AND tool_name IN ({placeholders}) "
        "ORDER BY ts DESC, id DESC LIMIT 1",
        (session_id, cutoff, *grant_tools),
    ).fetchone()


def consumption_count(con, table: str, session_id: str, thinking_event_id: int) -> int:
    row = con.execute(
        f"SELECT COUNT(*) FROM {table} WHERE session_id=? AND thinking_event_id=?",
        (session_id, thinking_event_id),
    ).fetchone()
    return int(row[0] if row else 0)


def consume_bounded_grant(
    con,
    events_table: str,
    consumption_table: str,
    session_id: str,
    tool_name: str,
    thinking_tools: list[str],
    ttl_seconds: int,
    max_uses: int,
) -> bool:
    con.execute("BEGIN IMMEDIATE")
    ensure_consumption_schema(con, consumption_table)
    row = latest_successful_thinking_event(con, events_table, session_id, time.time() - ttl_seconds, thinking_tools)
    if not row:
        return False
    event_id, _event_tool_name, _status, _ts = row
    if consumption_count(con, consumption_table, session_id, int(event_id)) >= max_uses:
        return False
    con.execute(
        f"INSERT INTO {consumption_table} (ts, session_id, thinking_event_id, tool_name) "
        "VALUES (?, ?, ?, ?)",
        (time.time(), session_id, int(event_id), tool_name),
    )
    return True


def primary_thinking_tool(thinking_tools: list[str]) -> str:
    """The sequential-thinking tool to name in the deny message: prefer the
    mcp-router spelling (the active one), else the first configured tool."""
    for name in thinking_tools:
        if "mcp-router" in name:
            return name
    return thinking_tools[0] if thinking_tools else "mcp__mcp-router__sequentialthinking"


def emit_deny(tool_name: str, ttl_seconds: int, max_uses: int, thinking_tools: list[str]) -> None:
    checkpoint_tool = primary_thinking_tool(thinking_tools)
    cursor_hint = ""
    if "MCP:sequentialthinking" in thinking_tools or "CallMcpTool" in thinking_tools:
        cursor_hint = " Cursor: call `MCP:sequentialthinking` or `CallMcpTool` with `toolName=sequentialthinking`."
    reason = (
        f"thinking-gate: '{tool_name}' blocked — no active planning grant. "
        f"Call `{checkpoint_tool}` once (grants {max_uses} tool use(s)/{ttl_seconds}s); "
        f"if it's not loaded, load it via ToolSearch first (exempt).{cursor_hint}"
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
        "systemMessage": reason,
    }))


def configured_read_only_tools(settings: dict) -> set[str]:
    raw = settings.get("readOnlyTools")
    if not isinstance(raw, list) or not raw:
        return {
            "Read", "Grep", "Glob", "SemanticSearch", "WebSearch", "WebFetch",
            "AskQuestion", "Await", "FetchMcpResource", "ListMcpResources", "SwitchMode",
        }
    return {str(item) for item in raw if str(item)}


def handler(payload, config, hcfg):
    session_id = payload.get("session_id", "")
    tool_name = payload.get("tool_name", "")
    if not session_id or not tool_name:
        return

    settings = hcfg.get("settings", {})
    if tool_name in configured_read_only_tools(settings):
        return
    thinking_tools = configured_thinking_tools(settings)
    tool_input = payload.get("tool_input", {})
    if is_thinking_tool_call(tool_name, tool_input, thinking_tools):
        return
    if bootstrap_allowed(settings, tool_name, tool_input):
        return

    table = safe_table(settings.get("table", "hook_events"), "hook_events")
    consumption_table = safe_table(settings.get("consumptionTable", "thinking_gate_consumptions"), "thinking_gate_consumptions")
    ttl = ttl_seconds(settings)
    max_uses = max_tool_uses(settings)

    con = connect(hooks_db(config))
    try:
        allowed = consume_bounded_grant(con, table, consumption_table, session_id, tool_name, thinking_tools, ttl, max_uses)
        con.commit()
    finally:
        con.close()

    if not allowed:
        emit_deny(tool_name, ttl, max_uses, thinking_tools)


if __name__ == "__main__":
    run("thinking-gate", handler)
