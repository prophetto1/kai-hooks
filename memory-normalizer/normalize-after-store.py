#!/usr/bin/env python
"""PostToolUse memory mutation normalizer.

Observes successful memory MCP mutations, finds affected rows, and repairs
metadata fields with the canonical retain normalizer. It never rewrites memory
content, vector rows, or FTS rows.
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
MEMORY_MUTATION_TOOLS = (
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
MCP_TOOL_PREFIXES = ("", "mcp__mcp_router__", "mcp__mcp-router__", "mcp__memory-sqlite__", "mcp__memory_sqlite__")
DEFAULT_TOOLS = {f"{prefix}{tool}" for prefix in MCP_TOOL_PREFIXES for tool in MEMORY_MUTATION_TOOLS}
AUDIT_ONLY_TOOLS = {"memory_delete"}
HASH_KEYS = {"content_hash", "contentHash", "hash", "memory_hash", "memoryHash"}
HASH_LIST_KEYS = {"content_hashes", "contentHashes", "hashes", "memory_hashes", "memoryHashes"}
ID_KEYS = {"memory_id", "memoryId"}
ID_LIST_KEYS = {"memory_ids", "memoryIds"}
CONTENT_KEYS = {"content", "memory", "text"}
HASH_RE = re.compile(r"\b(?:hash|content_hash)\s*[:=]\s*([0-9a-f]{32,64})\b", re.IGNORECASE)
RAW_HASH_RE = re.compile(r"\b[0-9a-f]{32,64}\b", re.IGNORECASE)


def utc_iso(ts: float | None = None) -> str:
    stamp = time.time() if ts is None else ts
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def memory_db(config: dict[str, Any]) -> str:
    return config.get("shared", {}).get("paths", {}).get("memoryDb", "E:/_memory/memory-sqlite.db")


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


def memory_tool_suffix(tool_name: str) -> str:
    for suffix in MEMORY_MUTATION_TOOLS:
        if tool_name == suffix or tool_name.endswith(f"__{suffix}"):
            return suffix
    return ""


def collect_hashes(value: Any, out: set[str]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in HASH_KEYS:
                for match in RAW_HASH_RE.findall(flatten_text(item)):
                    out.add(match.lower())
            elif key in HASH_LIST_KEYS:
                collect_hashes(item, out)
            elif isinstance(item, (dict, list, tuple)):
                collect_hashes(item, out)
    elif isinstance(value, (list, tuple)):
        for item in value:
            collect_hashes(item, out)


def add_id(value: Any, out: set[int]) -> None:
    try:
        out.add(int(value))
    except Exception:
        pass


def collect_id_values(value: Any, out: set[int]) -> None:
    if isinstance(value, (list, tuple)):
        for item in value:
            add_id(item, out)
    else:
        add_id(value, out)


def collect_ids(value: Any, out: set[int]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ID_KEYS:
                add_id(item, out)
            elif key in ID_LIST_KEYS:
                collect_id_values(item, out)
            elif isinstance(item, (dict, list, tuple)):
                collect_ids(item, out)
    elif isinstance(value, (list, tuple)):
        for item in value:
            if isinstance(item, (dict, list, tuple)):
                collect_ids(item, out)


def candidate_hashes(payload: dict[str, Any]) -> list[str]:
    hashes: set[str] = set()
    collect_hashes(payload.get("tool_input"), hashes)
    response = payload.get("tool_response", payload.get("tool_result"))
    collect_hashes(response, hashes)
    response_text = flatten_text(response)
    for match in HASH_RE.findall(response_text):
        hashes.add(match.lower())
    raw_response_matches = RAW_HASH_RE.findall(response_text.strip())
    if len(raw_response_matches) == 1 and response_text.strip().lower() == raw_response_matches[0].lower():
        hashes.add(raw_response_matches[0].lower())
    return sorted(hashes)


def candidate_ids(payload: dict[str, Any]) -> list[int]:
    ids: set[int] = set()
    collect_ids(payload.get("tool_input"), ids)
    collect_ids(payload.get("tool_response", payload.get("tool_result")), ids)
    return sorted(value for value in ids if value > 0)


def collect_content_candidates(value: Any, out: list[str], seen: set[str]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in CONTENT_KEYS and isinstance(item, str) and item.strip() and item not in seen:
                out.append(item)
                seen.add(item)
            elif isinstance(item, (dict, list, tuple)):
                collect_content_candidates(item, out, seen)
    elif isinstance(value, (list, tuple)):
        for item in value:
            collect_content_candidates(item, out, seen)


def content_candidates_from_payload(payload: dict[str, Any]) -> list[str]:
    tool_input = payload.get("tool_input", {})
    candidates: list[str] = []
    seen: set[str] = set()
    if isinstance(tool_input, dict):
        collect_content_candidates(tool_input, candidates, seen)
    return candidates


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


def find_memory_rows(
    con: sqlite3.Connection,
    *,
    content_hashes: list[str],
    memory_ids: list[int],
    raw_contents: list[str],
    config: dict[str, Any],
) -> list[sqlite3.Row]:
    con.row_factory = sqlite3.Row
    rows: list[sqlite3.Row] = []
    seen: set[int] = set()

    def add(row: sqlite3.Row | None) -> None:
        if row and row["id"] not in seen:
            rows.append(row)
            seen.add(row["id"])

    for memory_id in memory_ids:
        add(
            con.execute(
                "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL "
                "ORDER BY id DESC LIMIT 1",
                (memory_id,),
            ).fetchone()
        )

    for content_hash in content_hashes:
        content_hash = content_hash.lower()
        exact = con.execute(
            "SELECT * FROM memories WHERE content_hash = ? AND deleted_at IS NULL "
            "ORDER BY id DESC LIMIT 1",
            (content_hash,),
        ).fetchone()
        if exact:
            add(exact)
            continue
        if 32 <= len(content_hash) < 64:
            prefix_rows = con.execute(
                "SELECT * FROM memories WHERE content_hash LIKE ? AND deleted_at IS NULL "
                "ORDER BY id DESC LIMIT 2",
                (content_hash + "%",),
            ).fetchall()
            if len(prefix_rows) == 1:
                add(prefix_rows[0])

    normalized_contents: list[str] = []
    for content in raw_contents:
        if not content:
            continue
        try:
            normalized_contents.append(build_retain_payload(content, config=config)["content"])
        except Exception:
            normalized_contents.append(content)

    for content in [*raw_contents, *normalized_contents]:
        if not content:
            continue
        add(
            con.execute(
                "SELECT * FROM memories WHERE content = ? AND deleted_at IS NULL "
                "ORDER BY COALESCE(created_at, 0) DESC, id DESC LIMIT 1",
                (content,),
            ).fetchone()
        )

    return rows


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


def normalize_rows(
    con: sqlite3.Connection,
    rows: list[sqlite3.Row],
    *,
    config: dict[str, Any],
    payload: dict[str, Any],
) -> dict[str, Any]:
    results = []
    for row in rows:
        retain = build_retain_payload(
            row["content"],
            config=config,
            cwd=payload.get("cwd", ""),
            source_tool=payload.get("tool_name", ""),
            session_id=payload.get("session_id", ""),
        )
        results.append(update_memory_row(con, row, retain, config=config, payload=payload, normalized_at=time.time()))

    if not results:
        return {"decision": "skip", "status": "ok", "reason": "no active memory rows resolved"}
    if len(results) == 1:
        result = dict(results[0])
        result["rowCount"] = 1
        result["updatedCount"] = 1 if result["decision"] == "updated" else 0
        return result

    updated = sum(1 for result in results if result["decision"] == "updated")
    return {
        "decision": "updated" if updated else "skip",
        "status": "ok",
        "rowCount": len(results),
        "updatedCount": updated,
        "rows": results,
    }


def normalize_store(payload: dict[str, Any], config: dict[str, Any], hcfg: dict[str, Any]) -> dict[str, Any]:
    settings = hcfg.get("settings", {})
    tools = set(settings.get("sourceTools") or (hcfg.get("match") or {}).get("tools") or DEFAULT_TOOLS)
    tool_name = payload.get("tool_name", "")
    if tool_name and "*" not in tools and tool_name not in tools:
        return {"decision": "skip", "status": "ok", "reason": "tool not configured", "toolName": tool_name}
    if not tool_was_successful(payload):
        return {"decision": "skip", "status": "ok", "reason": "tool call was not successful"}

    tool_suffix = memory_tool_suffix(tool_name)
    if tool_suffix in AUDIT_ONLY_TOOLS:
        return {"decision": "audit", "status": "ok", "reason": f"{tool_suffix} observed; surviving rows are not normalized"}

    content_hashes = candidate_hashes(payload)
    memory_ids = candidate_ids(payload)
    raw_contents = content_candidates_from_payload(payload)
    con = connect(memory_db(config))
    try:
        rows = find_memory_rows(
            con,
            content_hashes=content_hashes,
            memory_ids=memory_ids,
            raw_contents=raw_contents,
            config=config,
        )
        if not rows:
            return {
                "decision": "skip",
                "status": "ok",
                "reason": "memory rows not found",
                "contentHashes": content_hashes,
                "memoryIds": memory_ids,
            }
        result = normalize_rows(con, rows, config=config, payload=payload)
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
            fixtures = {
                "store": (
                    "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
                    "Decision: E:/hooks memory-normalizer derives memory metadata after successful memory_store calls. Why: systematic hook tagging is required.",
                    "untagged,fixture-retired",
                ),
                "fallback": (
                    "def456abc123def456abc123def456abc123def456abc123def456abc123def4",
                    "Decision:   E:/hooks memory-normalizer    locates rows without a returned hash.\n\n"
                    "Why: fallback row correlation should survive content cleanup.",
                    "fixture-retired",
                ),
                "update": (
                    "1111111111111111111111111111111111111111111111111111111111111111",
                    "Decision: Memory updates must be normalized after metadata-only MCP updates. Why: update paths can otherwise preserve stale tags.",
                    "global,untagged",
                ),
                "session": (
                    "2222222222222222222222222222222222222222222222222222222222222222",
                    "Decision: Memory store session rows must be normalized when MCP persists a session. Why: session writes are memory mutations.",
                    "",
                ),
                "observe": (
                    "3333333333333333333333333333333333333333333333333333333333333333",
                    "Learning: memory_observe can persist extracted memories and must be normalized. Why: extracted rows otherwise bypass metadata repair.",
                    "",
                ),
                "mistake": (
                    "4444444444444444444444444444444444444444444444444444444444444444",
                    "Pattern: Memory mistake notes must be normalized.\nContext: mistake_note_add MCP write path\nWrong: ignore mistake-note writes\nRight: normalize affected row by returned hash",
                    "",
                ),
                "raw_response": (
                    "5555555555555555555555555555555555555555555555555555555555555555",
                    "Decision: Raw memory mutation hash responses must resolve rows. Why: MCP tools can return only the stored hash.",
                    "",
                ),
                "nested": (
                    "6666666666666666666666666666666666666666666666666666666666666666",
                    "Decision: Nested memory content payloads must resolve rows. Why: tool adapters can wrap content in nested objects.",
                    "",
                ),
                "prefix": (
                    "77777777777777777777777777777777123456789abcdef0123456789abcdef",
                    "Decision: Unambiguous memory hash prefixes must resolve rows. Why: tool responses can truncate hashes while staying unique.",
                    "",
                ),
                "structured": (
                    "8888888888888888888888888888888888888888888888888888888888888888",
                    "Decision: Structured memory hash lists must resolve rows. Why: batch mutation tools can return hashes in nested arrays.",
                    "",
                ),
                "hash_list": (
                    "9999999999999999999999999999999999999999999999999999999999999999",
                    "Decision: Direct memory hash list fields must resolve rows. Why: batch tools can return plain hash arrays.",
                    "",
                ),
            }
            for content_hash, fixture_content, tags in fixtures.values():
                con.execute(
                    "INSERT INTO memories (content_hash, content, tags, memory_type, metadata, created_at, confidence) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (content_hash, fixture_content, tags, "", "{}", time.time(), 0.8),
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
                "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}, "retiredTags": ["global", "untagged", "fixture-retired"]},
                "stopwords": "",
            }
        }
        hcfg = {
            "settings": {"table": "hook_events", "detailMaxChars": 1000},
            "match": {
                "tools": [
                    "mcp__mcp_router__memory_store",
                    "mcp__mcp_router__memory_update",
                    "mcp__mcp_router__memory_store_session",
                    "mcp__mcp_router__memory_observe",
                    "mcp__mcp_router__memory_harvest",
                    "mcp__mcp_router__mistake_note_add",
                    "mcp__mcp_router__memory_delete",
                ]
            },
        }
        payload = {
            "hook_event_name": "PostToolUse",
            "tool_name": "mcp__mcp_router__memory_store",
            "tool_input": {"content": fixtures["store"][1]},
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
            "tool_input": {"content": fixtures["fallback"][1]},
            "tool_response": {"text": "Stored memory."},
            "cwd": "E:/kai-chattr",
            "session_id": "self-test",
        }
        fallback_result = normalize_store(fallback_payload, config, hcfg)
        update_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_update",
                "tool_input": {"content_hash": fixtures["update"][0], "updates": {"metadata": {"priority": "high"}}},
                "tool_response": {"text": f"Updated memory content_hash: {fixtures['update'][0]}"},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        session_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_store_session",
                "tool_input": {"turns": [{"role": "user", "content": "store this durable session fact"}]},
                "tool_response": {"text": f"Stored session child hash: {fixtures['session'][0]}"},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        observe_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_observe",
                "tool_input": {"content": fixtures["observe"][1], "store_source": True},
                "tool_response": {"text": f"Observed and stored hash: {fixtures['observe'][0]}"},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        mistake_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__mistake_note_add",
                "tool_input": {
                    "context_signature": "memory-normalizer self-test",
                    "error_pattern": "ignored mistake-note writes",
                    "incorrect_action": "only normalize memory_store",
                    "correct_action": "normalize mistake_note_add returned row",
                },
                "tool_response": {"text": f"Mistake note stored. Hash: {fixtures['mistake'][0]}"},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        delete_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_delete",
                "tool_input": {"content_hash": fixtures["store"][0]},
                "tool_response": {"text": "Deleted memory."},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        raw_response_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_store_session",
                "tool_input": {"turns": [{"role": "user", "content": "store a raw response hash"}]},
                "tool_response": fixtures["raw_response"][0],
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        nested_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_store",
                "tool_input": {"payload": {"memory": {"content": fixtures["nested"][1]}}},
                "tool_response": {"text": "Stored memory."},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        prefix_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_update",
                "tool_input": {"content_hash": fixtures["prefix"][0][:32], "updates": {"metadata": {"priority": "prefix"}}},
                "tool_response": {"text": "Updated memory by prefix."},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        structured_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_harvest",
                "tool_input": {"source": "self-test"},
                "tool_response": {"items": [{"hash": fixtures["structured"][0]}]},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )
        hash_list_result = normalize_store(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__mcp_router__memory_harvest",
                "tool_input": {"source": "self-test"},
                "tool_response": {"hashes": [fixtures["hash_list"][0]]},
                "cwd": "E:/kai-chattr",
                "session_id": "self-test",
            },
            config,
            hcfg,
        )

        con = sqlite3.connect(memory_path)
        try:
            row = con.execute("SELECT tags, memory_type, metadata FROM memories WHERE content_hash LIKE 'abc123%'").fetchone()
            fallback_row = con.execute("SELECT tags, memory_type, metadata FROM memories WHERE content_hash LIKE 'def456%'").fetchone()
            checked_rows = {
                name: con.execute("SELECT tags, memory_type, metadata FROM memories WHERE content_hash = ?", (values[0],)).fetchone()
                for name, values in fixtures.items()
            }
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
            "updateResult": update_result,
            "sessionResult": session_result,
            "observeResult": observe_result,
            "mistakeResult": mistake_result,
            "deleteResult": delete_result,
            "rawResponseResult": raw_response_result,
            "nestedResult": nested_result,
            "prefixResult": prefix_result,
            "structuredResult": structured_result,
            "hashListResult": hash_list_result,
            "row": {"tags": tags, "memory_type": row[1]},
            "fallbackRow": {
                "tags": fallback_row[0].split(",") if fallback_row and fallback_row[0] else [],
                "memory_type": fallback_row[1] if fallback_row else "",
            },
            "checkedRows": {
                name: {
                    "tags": checked_rows[name][0].split(",") if checked_rows[name] and checked_rows[name][0] else [],
                    "memory_type": checked_rows[name][1] if checked_rows[name] else "",
                    "normalized": "memory_normalizer" in (checked_rows[name][2] if checked_rows[name] else ""),
                }
                for name in checked_rows
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
        if "decision" not in tags or "all" not in tags or "kai-chattr" in tags or "fixture-retired" in tags or "untagged" in tags:
            errors.append(f"fixture row missing expected config-isolation tags: {tags}")
        fallback_tags = report["fallbackRow"]["tags"]
        if "fixture-retired" in fallback_tags or "decision" not in fallback_tags:
            errors.append(f"fallback row missing expected tags: {fallback_tags}")
        for name in ("update", "session", "observe", "mistake"):
            tool_result = report[f"{name}Result"]
            if tool_result["decision"] != "updated":
                errors.append(f"{name} mutation was not normalized: {tool_result}")
            if not report["checkedRows"][name]["normalized"]:
                errors.append(f"{name} row missing memory_normalizer metadata: {report['checkedRows'][name]}")
        for name, result_key in (
            ("raw_response", "rawResponseResult"),
            ("nested", "nestedResult"),
            ("prefix", "prefixResult"),
            ("structured", "structuredResult"),
            ("hash_list", "hashListResult"),
        ):
            tool_result = report[result_key]
            if tool_result["decision"] != "updated":
                errors.append(f"{name} row resolution was not normalized: {tool_result}")
            if not report["checkedRows"][name]["normalized"]:
                errors.append(f"{name} row missing memory_normalizer metadata: {report['checkedRows'][name]}")
        if report["checkedRows"]["update"]["tags"] and ("untagged" in report["checkedRows"]["update"]["tags"] or "global" in report["checkedRows"]["update"]["tags"]):
            errors.append(f"update row kept retired tags: {report['checkedRows']['update']['tags']}")
        if delete_result["decision"] != "audit":
            errors.append(f"delete mutation should be audited without normalization: {delete_result}")
        if row[1] != "decision":
            errors.append(f"fixture row memory_type mismatch: {row[1]}")
        if audit_count != 1:
            errors.append(f"expected one audit row, found {audit_count}")
        report["errors"] = errors
        print(json.dumps(report, indent=2, ensure_ascii=True, sort_keys=True))
        return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize successful memory mutation writes.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    run(HOOK_ID, handler)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
