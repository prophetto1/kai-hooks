#!/usr/bin/env python
"""Read-only smoke checks for the local hook memory runtime."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "lib"
sys.path.insert(0, str(LIB))

from memory_retain import MemoryQualityError, build_retain_payload, normalize_tags  # noqa: E402

CONFIG_PATH = os.environ.get("HOOKS_CONFIG_PATH", "E:/hooks/config.json")


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def read_only_connection(path: str) -> sqlite3.Connection:
    normalized = Path(path).as_posix()
    return sqlite3.connect(f"file:{normalized}?mode=ro", uri=True)


def table_names(con: sqlite3.Connection) -> set[str]:
    rows = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {row[0] for row in rows}


def table_columns(con: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in con.execute(f"PRAGMA table_info({table})").fetchall()]


def active_filter() -> str:
    return "deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')"


def memory_db_check(config: dict) -> dict:
    db = config["shared"]["paths"]["memoryDb"]
    required_columns = {
        "content_hash",
        "content",
        "tags",
        "memory_type",
        "metadata",
        "created_at",
        "updated_at",
        "created_at_iso",
        "updated_at_iso",
        "deleted_at",
        "superseded_by",
    }
    with read_only_connection(db) as con:
        names = table_names(con)
        missing_tables = sorted({"memories", "memory_content_fts"} - names)
        columns = set(table_columns(con, "memories")) if "memories" in names else set()
        missing_columns = sorted(required_columns - columns)
        active_count = con.execute(f"SELECT COUNT(*) FROM memories WHERE {active_filter()}").fetchone()[0]
        untagged_count = con.execute(
            f"SELECT COUNT(*) FROM memories WHERE {active_filter()} AND COALESCE(tags, '') = 'untagged'"
        ).fetchone()[0]
        missing_type_count = con.execute(
            f"SELECT COUNT(*) FROM memories WHERE {active_filter()} AND COALESCE(memory_type, '') = ''"
        ).fetchone()[0]
    return {
        "db": db,
        "missingTables": missing_tables,
        "missingColumns": missing_columns,
        "activeCount": active_count,
        "untaggedCount": untagged_count,
        "missingTypeCount": missing_type_count,
    }


def hooks_db_check(config: dict) -> dict:
    db = config["shared"]["paths"]["hooksDb"]
    required_columns = {
        "id",
        "ts",
        "ts_iso",
        "session_id",
        "project",
        "hook_id",
        "event",
        "tool_name",
        "target",
        "decision",
        "status",
        "duration_ms",
        "detail",
    }
    with read_only_connection(db) as con:
        names = table_names(con)
        columns = set(table_columns(con, "hook_events")) if "hook_events" in names else set()
        row_count = con.execute("SELECT COUNT(*) FROM hook_events").fetchone()[0] if "hook_events" in names else 0
        by_status = dict(con.execute(
            "SELECT COALESCE(status, ''), COUNT(*) FROM hook_events GROUP BY COALESCE(status, '')"
        ).fetchall()) if "hook_events" in names else {}
    return {
        "db": db,
        "missingTables": sorted({"hook_events"} - names),
        "missingColumns": sorted(required_columns - columns),
        "rowCount": row_count,
        "statusCounts": by_status,
    }


def recall_config(config: dict) -> dict:
    memory_settings = next(h for h in config["hooks"] if h["id"] == "inject-protocol")["settings"]["sources"]["memory"]
    filter_sql = {
        "not-deleted": "m.deleted_at IS NULL",
        "not-superseded": "(m.superseded_by IS NULL OR m.superseded_by='')",
    }
    return {
        "ftsTable": memory_settings["ftsTable"],
        "joinTable": memory_settings["joinTable"],
        "filtersSql": [filter_sql[item["id"]] for item in memory_settings.get("filters", [])],
        "max": memory_settings["max"],
        "snippetChars": min(int(memory_settings["snippetChars"]), 300),
        "candidatePool": memory_settings["candidatePool"],
        "scoring": memory_settings["scoring"],
        "crossProjectTag": config["shared"]["memoryTags"]["crossProjectTag"],
    }


def recall_check(config: dict) -> dict:
    query = '"memory" OR "hook"'
    script = ROOT / "inject-protocol" / "recall.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            config["shared"]["paths"]["memoryDb"],
            query,
            "",
            json.dumps(recall_config(config)),
        ],
        text=True,
        capture_output=True,
        timeout=8,
        check=False,
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    parsed = []
    for line in lines:
        try:
            parsed.append(json.loads(line))
        except Exception:
            parsed.append({"text": line})
    return {
        "exitCode": result.returncode,
        "stderr": result.stderr.strip(),
        "rowCount": len(parsed),
        "sample": parsed[:2],
    }


def normalizer_check(config: dict) -> dict:
    project_content = "Decision: Kai Chattr devdocs content lives under apps/devdocs/content. Why: docs navigation depends on that source tree."
    first = build_retain_payload(project_content, config=config, cwd="E:/kai-chattr", source_tool="memory_store", now=1700000000)
    second = build_retain_payload(project_content, config=config, cwd="E:/kai-chattr", source_tool="memory_store", now=1700000001)
    hook_content = "Decision: E:/hooks memory-normalizer updates memory metadata after successful memory_store calls. Why: hook-system memories need cross-project recall."
    hook_payload = build_retain_payload(hook_content, config=config, cwd="E:/kai-chattr", source_tool="memory_store", now=1700000000)
    stable_keys = ["content", "memory_type", "tags", "content_fingerprint", "update_mode"]
    unstable = [key for key in stable_keys if first[key] != second[key]]
    rewrites = normalize_tags(["global", "memory"], config)
    rejected_low_quality = False
    try:
        build_retain_payload("ok", config=config)
    except MemoryQualityError:
        rejected_low_quality = True
    return {
        "unstableNonTimestampKeys": unstable,
        "globalRewrite": rewrites,
        "rejectedLowQuality": rejected_low_quality,
        "sample": {
            "memoryType": first["memory_type"],
            "tags": first["tags"],
            "fingerprint": first["content_fingerprint"],
        },
        "hookSystemSample": {
            "memoryType": hook_payload["memory_type"],
            "tags": hook_payload["tags"],
        },
    }


def main() -> int:
    config = load_config()
    report = {
        "memoryDb": memory_db_check(config),
        "hooksDb": hooks_db_check(config),
        "recall": recall_check(config),
        "normalizer": normalizer_check(config),
    }
    errors: list[str] = []
    if report["memoryDb"]["missingTables"] or report["memoryDb"]["missingColumns"]:
        errors.append(f"memory DB shape mismatch: {report['memoryDb']}")
    if report["hooksDb"]["missingTables"] or report["hooksDb"]["missingColumns"]:
        errors.append(f"hooks DB shape mismatch: {report['hooksDb']}")
    if report["recall"]["exitCode"] != 0:
        errors.append(f"recall failed: {report['recall']['stderr']}")
    if report["recall"]["rowCount"] < 1:
        errors.append("recall returned no rows for baseline query")
    if report["normalizer"]["unstableNonTimestampKeys"]:
        errors.append(f"normalizer non-timestamp fields drifted: {report['normalizer']['unstableNonTimestampKeys']}")
    if report["normalizer"]["globalRewrite"] != ["all", "memory"]:
        errors.append(f"global rewrite failed: {report['normalizer']['globalRewrite']}")
    if "kai-chattr" not in report["normalizer"]["sample"]["tags"]:
        errors.append(f"project tag was not derived from config: {report['normalizer']['sample']['tags']}")
    if "all" not in report["normalizer"]["hookSystemSample"]["tags"] or "kai-chattr" in report["normalizer"]["hookSystemSample"]["tags"]:
        errors.append(f"hook-system memory did not use cross-project scope: {report['normalizer']['hookSystemSample']['tags']}")
    if not report["normalizer"]["rejectedLowQuality"]:
        errors.append("low-quality content was accepted")

    report["errors"] = errors
    print(json.dumps(report, indent=2, ensure_ascii=True, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
