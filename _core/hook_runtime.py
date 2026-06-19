#!/usr/bin/env python
"""Shared runtime for E:/hooks Python hooks (telemetry, loop-safety, ...).

Centralizes the boilerplate every hook needs so behavior is uniform and config-driven:
  - load config.json (HOOKS_CONFIG_PATH override)
  - find a hook's own entry by id
  - resolve the dedicated hooks DB path (shared.paths.hooksDb)
  - ENFORCE `enabled` (disabled hook -> no-op) and `failPolicy` (open=allow, closed=deny on error)
  - parse the hook stdin JSON payload
  - detect the project from cwd vs shared.projects
  - open the hooks DB (WAL)

run(hook_id, handler): the entrypoint wrapper. handler(payload, config, hook_cfg) does the work;
the wrapper guarantees enabled-respect + fail-policy so individual hooks can't get it wrong.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys

CONFIG_PATH = os.environ.get("HOOKS_CONFIG_PATH", "E:/hooks/config.json")
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

MEMORY_MUTATION_BASE_TOOLS = (
    "memory_store",
    "memory_update",
    "memory_store_session",
    "memory_observe",
    "memory_harvest",
    "memory_ingest",
    "memory_resolve",
    "memory_cleanup",
    "memory_delete",
    "mistake_note_add",
)
MEMORY_MUTATION_MCP_PREFIXES = (
    "",
    "mcp__mcp_router__",
    "mcp__mcp-router__",
    "mcp__memory-sqlite__",
    "mcp__memory_sqlite__",
)
BUILTIN_TOOL_GROUPS: dict[str, dict[str, tuple[str, ...]]] = {
    "memoryMutation": {
        "tools": MEMORY_MUTATION_BASE_TOOLS,
        "mcpPrefixes": MEMORY_MUTATION_MCP_PREFIXES,
    },
}

# Exit codes: 0 = allow/ok, 2 = deny (PreToolUse gate). Telemetry/loop-safety are fail-open.
EXIT_ALLOW = 0
EXIT_DENY = 2


def load_config(path: str | None = None) -> dict:
    with open(path or CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def hook_cfg(config: dict, hook_id: str) -> dict:
    return next((h for h in config.get("hooks", []) if h.get("id") == hook_id), {})


def is_enabled(hcfg: dict) -> bool:
    return hcfg.get("enabled", True) is not False


def fail_policy(hcfg: dict) -> str:
    return hcfg.get("failPolicy", "open")


def hooks_db(config: dict) -> str:
    return config.get("shared", {}).get("paths", {}).get("hooksDb", "E:/hooks/_db/hooks.db")


def expand_tool_group(group: dict) -> frozenset[str]:
    tools = group.get("tools") or ()
    prefixes = group.get("mcpPrefixes") or ("",)
    return frozenset(f"{prefix}{tool}" for prefix in prefixes for tool in tools)


def resolve_match_tools(hcfg: dict, config: dict | None = None) -> frozenset[str]:
    """Resolve hooks[].match.tools or hooks[].match.toolGroup into concrete tool names."""
    match = hcfg.get("match") or {}
    explicit = match.get("tools")
    if explicit:
        return frozenset(explicit)
    group_name = match.get("toolGroup")
    if group_name:
        shared_groups = (config or {}).get("shared", {}).get("toolGroups") or {}
        group = shared_groups.get(group_name) or BUILTIN_TOOL_GROUPS.get(group_name)
        if group:
            return expand_tool_group(group)
    return frozenset({"*"})


def matches_tool(hcfg: dict, tool_name: str, config: dict | None = None) -> bool:
    """Honor config.json hooks[].match.tools or match.toolGroup. '*' = all tools."""
    tools = resolve_match_tools(hcfg, config)
    return "*" in tools or tool_name in tools


def safe_table(name: str, default: str) -> str:
    name = str(name or default)
    return name if IDENT_RE.match(name) else default


def read_stdin_json() -> dict:
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def detect_project(cwd: str, projects: list) -> str:
    c = (cwd or "").replace("\\", "/").lower()
    for p in projects:
        rp = (p.get("repoPath") or "").replace("\\", "/").lower()
        if rp and (c == rp or c.startswith(rp + "/")):
            return p.get("slug", "")
    segs = set(c.split("/"))
    for p in projects:
        for tok in [p.get("slug", "")] + (p.get("aliases") or []):
            if tok and tok.lower() in segs:  # full path-segment match, not loose substring
                return p.get("slug", "")
    return ""


# Field priority for collapsing a tool_input into one "target" string. SHARED by telemetry
# (what it stores) and loop-safety (what it fingerprints) so the two cannot drift apart.
TARGET_FIELDS = ("command", "file_path", "path", "pattern", "url", "query")


def extract_target(tool_name: str, tool_input, limit: int = 300) -> str:
    if isinstance(tool_input, dict):
        for k in TARGET_FIELDS:
            v = tool_input.get(k)
            if v:
                return str(v)[:limit]
        return ""
    return str(tool_input or "")[:limit]


def connect(db_path: str) -> sqlite3.Connection:
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=3.0)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=3000")
    return con


def connect_readonly(db_path: str) -> sqlite3.Connection:
    normalized = os.path.abspath(db_path).replace("\\", "/")
    con = sqlite3.connect(f"file:{normalized}?mode=ro", uri=True, timeout=3.0)
    con.execute("PRAGMA busy_timeout=3000")
    return con


def run(hook_id: str, handler) -> None:
    """Uniform entrypoint: enforce enabled + failPolicy; never let a hook bug escape.

    handler(payload, config, hook_cfg) returns None for allow, or the int EXIT_DENY to deny.
    On disabled -> exit 0 (no-op). On handler error -> failPolicy: open=exit 0, closed=exit 2.
    """
    try:
        config = load_config()
    except Exception as exc:  # config unreadable -> fail open, never block
        print(f"[{hook_id}] config load failed: {exc}", file=sys.stderr)
        sys.exit(EXIT_ALLOW)

    hcfg = hook_cfg(config, hook_id)
    if not is_enabled(hcfg):
        sys.exit(EXIT_ALLOW)  # disabled in config.json -> do nothing

    payload = read_stdin_json()
    tool_name = payload.get("tool_name", "")
    if tool_name and not matches_tool(hcfg, tool_name, config):
        sys.exit(EXIT_ALLOW)  # config.match.tools excludes this tool -> no-op

    try:
        result = handler(payload, config, hcfg)
        sys.exit(EXIT_DENY if result == EXIT_DENY else EXIT_ALLOW)
    except SystemExit:
        raise
    except Exception as exc:
        policy = fail_policy(hcfg)
        print(f"[{hook_id}] handler error ({policy}): {exc}", file=sys.stderr)
        sys.exit(EXIT_DENY if policy == "closed" else EXIT_ALLOW)
