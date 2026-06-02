#!/usr/bin/env python
"""PostToolUse memory_store normalizer.

Observes successful memory_store calls, finds the row that was just written, and
repairs metadata fields with the canonical retain normalizer. It never rewrites
memory content, vector rows, or FTS rows.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOOK_DIR = Path(__file__).resolve().parent
ROOT = HOOK_DIR.parent
LIB = ROOT / "_core"
sys.path.insert(0, str(LIB))
sys.path.insert(0, str(HOOK_DIR))

from hook_runtime import connect, detect_project, hooks_db, run, safe_table  # noqa: E402
from memory_retain import build_retain_payload, normalize_tags, tags_to_string  # noqa: E402

HOOK_ID = "memory-normalizer"
DEFAULT_TOOLS = {
    "memory_store",
    "mcp__mcp_router__memory_store",
    "mcp__mcp-router__memory_store",
    "mcp__memory-sqlite__memory_store",
    "mcp__memory_sqlite__memory_store",
}
HASH_RE = re.compile(r"\b(?:hash|content_hash)\s*[:=]\s*([0-9a-f]{32,64})\b", re.IGNORECASE)


def utc_iso(ts: float | None = None) -> str:
    stamp = time.time() if ts is None else ts
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def memory_db(config: dict[str, Any]) -> str:
    return config.get("shared", {}).get("paths", {}).get("memoryDb", "E:/memory/memory-sqlite.db")


def ensure_audit_schema(con: sqlite3.Connection, table: str) -> None:
    con.executescript(f"""
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
""")


def audit(config: dict[str, Any], hcfg: dict[str, Any], payload: dict[str, Any], result: dict[str, Any], started: float) -> None:
    settings = hcfg.get("settings", {})
    table = safe_table(settings.get("auditTable", settings.get("table", "hook_events")), "hook_events")
    detail_max = int(settings.get("detailMaxChars", 500))
    now = time.time()
    detail = json.dumps(result, ensure_ascii=True, sort_keys=True)[:detail_max]
    tool_input = payload.get("tool_input", {})
    target = ""
    if isinstance(tool_input, dict):
        target = str(tool_input.get("content_hash") or tool_input.get("content") or "")[:300]
    row = (
        now,
        utc_iso(now),
        payload.get("session_id", ""),
        detect_project(payload.get("cwd", ""), config.get("shared", {}).get("projects", [])),
        HOOK_ID,
        payload.get("hook_event_name", "PostToolUse"),
        payload.get("tool_name", ""),
        target,
        result.get("decision", ""),
        result.get("status", "ok"),
        int((now - started) * 1000),
        detail,
    )

    con = connect(hooks_db(config))
    try:
        ensure_audit_schema(con, table)
        con.execute(
            f"INSERT INTO {table} "
            "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
        con.commit()
    finally:
        con.close()


def flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        parts = []
        for key in ("text", "content", "message", "result", "output"):
            if key in value:
                parts.append(flatten_text(value[key]))
        if not parts:
            parts = [flatten_text(item) for item in value.values()]
        return " ".join(part for part in parts if part)
    if isinstance(value, (list, tuple)):
        return " ".join(flatten_text(item) for item in value if item is not None)
    return str(value)


def response_hash(payload: dict[str, Any]) -> str:
    for key in ("content_hash", "hash"):
        tool_input = payload.get("tool_input")
        if isinstance(tool_input, dict) and tool_input.get(key):
            return str(tool_input[key])
    text = flatten_text(payload.get("tool_response", payload.get("tool_result")))
    match = HASH_RE.search(text)
    return match.group(1) if match else ""


def content_from_payload(payload: dict[str, Any]) -> str:
    tool_input = payload.get("tool_input", {})
    if isinstance(tool_input, dict):
        for key in ("content", "memory", "text"):
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return ""


def tool_was_successful(payload: dict[str, Any]) -> bool:
    if payload.get("hook_event_name", "PostToolUse") != "PostToolUse":
        return False
    response = payload.get("tool_response", payload.get("tool_result"))
    if isinstance(response, dict):
        if response.get("is_error") is True or response.get("isError") is True:
            return False
        if response.get("success") is False:
            return False
        for key in ("exit_code", "exitCode", "returncode", "code"):
            value = response.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value != 0:
                return False
    return True


def parse_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if not raw:
        return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {"legacy_metadata": raw}
    return {"legacy_metadata": str(raw)}


def find_memory_row(
    con: sqlite3.Connection,
    content_hash: str,
    raw_content: str,
    normalized_content: str,
) -> sqlite3.Row | None:
    con.row_factory = sqlite3.Row
    if content_hash:
        row = con.execute(
            "SELECT * FROM memories WHERE content_hash = ? AND deleted_at IS NULL "
            "ORDER BY id DESC LIMIT 1",
            (content_hash,),
        ).fetchone()
        if row:
            return row
    for content in (raw_content, normalized_content):
        if content:
            row = con.execute(
                "SELECT * FROM memories WHERE content = ? AND deleted_at IS NULL "
                "ORDER BY COALESCE(created_at, 0) DESC, id DESC LIMIT 1",
                (content,),
            ).fetchone()
            if row:
                return row
    return None


def update_memory_row(
    con: sqlite3.Connection,
    row: sqlite3.Row,
    retain: dict[str, Any],
    *,
    config: dict[str, Any],
    payload: dict[str, Any],
    normalized_at: float,
) -> dict[str, Any]:
    existing_metadata = parse_metadata(row["metadata"])
    existing_tags = normalize_tags(row["tags"], config)
    new_tags = normalize_tags([*existing_tags, *retain["tags"]], config)
    normalizer_core = {
        "version": "v1",
        "source_tool": payload.get("tool_name", ""),
        "content_fingerprint": retain["content_fingerprint"],
        "classifier_source": retain["metadata"].get("classifier_source"),
        "classifier_confidence": retain["metadata"].get("classifier_confidence"),
    }
    existing_normalizer = existing_metadata.get("memory_normalizer", {})
    if not isinstance(existing_normalizer, dict):
        existing_normalizer = {}

    desired_tags = tags_to_string(new_tags, config)
    metadata_needs_update = any(existing_normalizer.get(key) != value for key, value in normalizer_core.items())
    changed_columns = []
    if str(row["tags"] if row["tags"] is not None else "") != desired_tags:
        changed_columns.append("tags")
    if str(row["memory_type"] if row["memory_type"] is not None else "") != retain["memory_type"]:
        changed_columns.append("memory_type")
    if metadata_needs_update or changed_columns:
        changed_columns.append("metadata")

    if not changed_columns:
        return {
            "decision": "skip",
            "status": "ok",
            "memoryId": row["id"],
            "contentHash": row["content_hash"],
            "changedColumns": [],
            "tags": new_tags,
            "memoryType": retain["memory_type"],
        }

    new_metadata = dict(existing_metadata)
    new_metadata["memory_normalizer"] = {
        **normalizer_core,
        "normalized_at": normalized_at,
        "normalized_at_iso": utc_iso(normalized_at),
    }
    updates = {
        "tags": desired_tags,
        "memory_type": retain["memory_type"],
        "metadata": json.dumps(new_metadata, ensure_ascii=True, sort_keys=True),
        "updated_at": normalized_at,
        "updated_at_iso": utc_iso(normalized_at),
    }
    con.execute(
        "UPDATE memories SET tags = ?, memory_type = ?, metadata = ?, updated_at = ?, updated_at_iso = ? WHERE id = ?",
        (
            updates["tags"],
            updates["memory_type"],
            updates["metadata"],
            updates["updated_at"],
            updates["updated_at_iso"],
            row["id"],
        ),
    )
    return {
        "decision": "updated",
        "status": "ok",
        "memoryId": row["id"],
        "contentHash": row["content_hash"],
        "changedColumns": sorted(set([*changed_columns, "updated_at", "updated_at_iso"])),
        "tags": new_tags,
        "memoryType": retain["memory_type"],
    }


def normalize_store(payload: dict[str, Any], config: dict[str, Any], hcfg: dict[str, Any]) -> dict[str, Any]:
    settings = hcfg.get("settings", {})
    tools = set(settings.get("sourceTools") or (hcfg.get("match") or {}).get("tools") or DEFAULT_TOOLS)
    tool_name = payload.get("tool_name", "")
    if tool_name and "*" not in tools and tool_name not in tools:
        return {"decision": "skip", "status": "ok", "reason": "tool not configured", "toolName": tool_name}
    if not tool_was_successful(payload):
        return {"decision": "skip", "status": "ok", "reason": "tool call was not successful"}

    content = content_from_payload(payload)
    if not content:
        return {"decision": "skip", "status": "ok", "reason": "tool input did not include content"}

    retain = build_retain_payload(
        content,
        config=config,
        cwd=payload.get("cwd", ""),
        source_tool=tool_name,
        session_id=payload.get("session_id", ""),
    )
    content_hash = response_hash(payload)
    con = connect(memory_db(config))
    try:
        row = find_memory_row(con, content_hash, content, retain["content"])
        if not row:
            return {
                "decision": "skip",
                "status": "ok",
                "reason": "memory row not found",
                "contentHash": content_hash,
            }
        result = update_memory_row(con, row, retain, config=config, payload=payload, normalized_at=time.time())
        con.commit()
        return result
    finally:
        con.close()


def handler(payload: dict[str, Any], config: dict[str, Any], hcfg: dict[str, Any]) -> None:
    started = time.time()
    try:
        result = normalize_store(payload, config, hcfg)
        audit(config, hcfg, payload, result, started)
    except Exception as exc:
        result = {"decision": "fail", "status": "error", "error": str(exc)}
        try:
            audit(config, hcfg, payload, result, started)
        finally:
            raise


def self_test() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        memory_path = os.path.join(temp_dir, "memory.db")
        hooks_path = os.path.join(temp_dir, "hooks.db")
        con = sqlite3.connect(memory_path)
        try:
            con.execute("""
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  memory_type TEXT,
  metadata TEXT,
  created_at REAL,
  updated_at REAL,
  created_at_iso TEXT,
  updated_at_iso TEXT,
  deleted_at REAL,
  parent_id INTEGER,
  version INTEGER,
  confidence REAL,
  last_accessed REAL,
  superseded_by TEXT
)
""")
            content = "Decision: E:/hooks memory-normalizer derives memory metadata after successful memory_store calls. Why: systematic hook tagging is required."
            whitespace_content = (
                "Decision:   E:/hooks memory-normalizer    locates rows without a returned hash.\n\n"
                "Why: fallback row correlation should survive content cleanup."
            )
            con.execute(
                "INSERT INTO memories (content_hash, content, tags, memory_type, metadata, created_at, confidence) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("abc123def456abc123def456abc123def456abc123def456abc123def456abc1", content, "untagged,fixture-retired", "", "{}", time.time(), 0.8),
            )
            con.execute(
                "INSERT INTO memories (content_hash, content, tags, memory_type, metadata, created_at, confidence) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("def456abc123def456abc123def456abc123def456abc123def456abc123def4", whitespace_content, "fixture-retired", "", "{}", time.time(), 0.8),
            )
            con.commit()
        finally:
            con.close()

        config = {
            "shared": {
                "paths": {"memoryDb": memory_path, "hooksDb": hooks_path},
                "projects": [
                    {"slug": "kai-chattr", "kind": "rebuild", "repoPath": "E:/kai-chattr", "aliases": []}
                ],
                "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}, "retiredTags": ["global", "fixture-retired"]},
                "stopwords": "",
            }
        }
        hcfg = {
            "settings": {"table": "hook_events", "detailMaxChars": 1000},
            "match": {"tools": ["mcp__mcp_router__memory_store"]},
        }
        payload = {
            "hook_event_name": "PostToolUse",
            "tool_name": "mcp__mcp_router__memory_store",
            "tool_input": {"content": content},
            "tool_response": {"text": "Stored memory. Hash: abc123def456abc123def456abc123def456abc123def456abc123def456abc1"},
            "cwd": "E:/kai-chattr",
            "session_id": "self-test",
        }
        started = time.time()
        result = normalize_store(payload, config, hcfg)
        audit(config, hcfg, payload, result, started)
        second_result = normalize_store(payload, config, hcfg)
        fallback_payload = {
            "hook_event_name": "PostToolUse",
            "tool_name": "mcp__mcp_router__memory_store",
            "tool_input": {"content": whitespace_content},
            "tool_response": {"text": "Stored memory."},
            "cwd": "E:/kai-chattr",
            "session_id": "self-test",
        }
        fallback_result = normalize_store(fallback_payload, config, hcfg)

        con = sqlite3.connect(memory_path)
        try:
            row = con.execute("SELECT tags, memory_type, metadata FROM memories WHERE content_hash LIKE 'abc123%'").fetchone()
            fallback_row = con.execute("SELECT tags, memory_type, metadata FROM memories WHERE content_hash LIKE 'def456%'").fetchone()
        finally:
            con.close()
        hooks_con = sqlite3.connect(hooks_path)
        try:
            audit_count = hooks_con.execute("SELECT COUNT(*) FROM hook_events WHERE hook_id = ?", (HOOK_ID,)).fetchone()[0]
        finally:
            hooks_con.close()

        tags = row[0].split(",") if row and row[0] else []
        report = {
            "result": result,
            "secondResult": second_result,
            "fallbackResult": fallback_result,
            "row": {"tags": tags, "memory_type": row[1]},
            "fallbackRow": {
                "tags": fallback_row[0].split(",") if fallback_row and fallback_row[0] else [],
                "memory_type": fallback_row[1] if fallback_row else "",
            },
            "auditCount": audit_count,
        }
        errors = []
        if result["decision"] != "updated":
            errors.append("normalizer did not update the fixture row")
        if second_result["decision"] != "skip":
            errors.append(f"second normalization was not idempotent: {second_result}")
        if fallback_result["decision"] != "updated":
            errors.append(f"fallback row was not normalized without response hash: {fallback_result}")
        if "decision" not in tags or "all" not in tags or "kai-chattr" in tags or "fixture-retired" in tags or "untagged" not in tags:
            errors.append(f"fixture row missing expected config-isolation tags: {tags}")
        fallback_tags = report["fallbackRow"]["tags"]
        if "fixture-retired" in fallback_tags or "decision" not in fallback_tags:
            errors.append(f"fallback row missing expected tags: {fallback_tags}")
        if row[1] != "decision":
            errors.append(f"fixture row memory_type mismatch: {row[1]}")
        if audit_count != 1:
            errors.append(f"expected one audit row, found {audit_count}")
        report["errors"] = errors
        print(json.dumps(report, indent=2, ensure_ascii=True, sort_keys=True))
        return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize successful memory_store writes.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    run(HOOK_ID, handler)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
