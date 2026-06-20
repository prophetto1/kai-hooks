#!/usr/bin/env python
"""Deterministic replay harness for memory-harvester admission quality."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

HOOK_DIR = Path(__file__).resolve().parent
ROOT = HOOK_DIR.parent
sys.path.insert(0, str(ROOT / "_core"))
sys.path.insert(0, str(ROOT / "memory-normalizer"))
sys.path.insert(0, str(HOOK_DIR))

from harvest_core import (  # noqa: E402
    ACTIVE_SQL,
    load_existing_memory_context,
    parse_transcript_lines,
    recent_exchanges,
    store_candidates,
)
from memory_retain import content_fingerprint  # noqa: E402


def create_memory_db(db_path: str) -> None:
    con = sqlite3.connect(db_path)
    try:
        con.executescript(
            """
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
                deleted_at REAL DEFAULT NULL,
                parent_id TEXT,
                version INTEGER DEFAULT 1,
                confidence REAL DEFAULT 1.0,
                last_accessed INTEGER,
                superseded_by TEXT
            );
            CREATE VIRTUAL TABLE memory_content_fts USING fts5(
                content,
                content='memories',
                content_rowid='id',
                tokenize='trigram'
            );
            """
        )
        con.commit()
    finally:
        con.close()


def base_config(db_path: str, state_dir: str) -> dict[str, Any]:
    return {
        "shared": {
            "paths": {"memoryDb": db_path, "hooksDir": str(ROOT)},
            "projects": [{"slug": "tfo", "repoPath": "E:/tfo", "aliases": []}],
            "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}, "retiredTags": ["global", "untagged"]},
            "stopwords": "the and or for with from into this that should",
        },
        "hooks": [{"id": "memory-harvester", "settings": {"stateDir": state_dir}}],
    }


def transcript_rows(user_text: str, assistant_text: str) -> str:
    rows = [
        {"type": "user", "message": {"role": "user", "content": user_text}},
        {"type": "assistant", "message": {"role": "assistant", "content": assistant_text}},
    ]
    return "\n".join(json.dumps(row, ensure_ascii=True) for row in rows) + "\n"


def insert_seed_memory(db_path: str, content: str, *, tags: str = "tfo,all", memory_type: str = "decision") -> int:
    con = sqlite3.connect(db_path)
    try:
        cur = con.execute(
            """
            INSERT INTO memories (
                content_hash, content, tags, memory_type, metadata,
                created_at, updated_at, created_at_iso, updated_at_iso, confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                content_fingerprint(content),
                content,
                tags,
                memory_type,
                "{}",
                1000.0,
                1000.0,
                "1970-01-01T00:16:40Z",
                "1970-01-01T00:16:40Z",
                0.9,
            ),
        )
        row_id = int(cur.lastrowid)
        con.execute("INSERT INTO memory_content_fts(rowid, content) VALUES (?, ?)", (row_id, content))
        con.commit()
        return row_id
    finally:
        con.close()


CASES: list[dict[str, Any]] = [
    {
        "name": "garbage_skip",
        "transcript": ("ok thanks", "Sounds good."),
        "operations": [{"operation": "skip", "reason": "too_generic", "content": ""}],
        "expected": {"stored": 0, "skipped": 1, "rejected": 0, "superseded": 0},
    },
    {
        "name": "durable_insert",
        "transcript": (
            "Remember the TFO memory model.",
            "Decision: TFO uses Codex Spark as the intended harvester and retainer model.",
        ),
        "operations": [
            {
                "operation": "insert",
                "content": "Decision: TFO uses Codex Spark as the intended harvester and retainer model.",
                "memory_type": "decision",
                "confidence": 0.95,
                "reason": "User stated durable TFO direction.",
            }
        ],
        "expected": {"stored": 1, "skipped": 0, "rejected": 0, "superseded": 0},
    },
    {
        "name": "duplicate_skip",
        "seed": ["Decision: TFO uses Codex Spark as the intended harvester and retainer model."],
        "transcript": (
            "TFO still uses Spark for memory harvest.",
            "Decision: TFO uses Codex Spark as the intended harvester and retainer model.",
        ),
        "operations": [
            {
                "operation": "insert",
                "content": "Decision: TFO uses Codex Spark as the intended harvester and retainer model.",
                "memory_type": "decision",
            }
        ],
        "expected": {"stored": 0, "skipped": 1, "rejected": 0, "superseded": 0},
    },
    {
        "name": "correction_supersede",
        "seed": ["Decision: Hindsight is primary memory recall."],
        "transcript": (
            "Correction: SQLite/vector is primary until Hindsight backfill is complete.",
            "Decision: SQLite/vector remains primary until Hindsight backfill is complete.",
        ),
        "operations": [
            {
                "operation": "supersede",
                "content": "Decision: SQLite/vector remains primary until Hindsight backfill is complete.",
                "memory_type": "decision",
                "supersedes_ref": 0,
                "reason": "User corrected prior provider direction.",
                "evidence": "SQLite/vector is primary until Hindsight backfill is complete.",
            }
        ],
        "expected": {"stored": 1, "skipped": 0, "rejected": 0, "superseded": 1},
    },
]


def resolve_operations(operations: list[dict[str, Any]], seed_ids: list[int]) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for operation in operations:
        row = dict(operation)
        if "supersedes_ref" in row:
            row["supersedes_id"] = seed_ids[int(row.pop("supersedes_ref"))]
        resolved.append(row)
    return resolved


def run_case(case: dict[str, Any]) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        create_memory_db(db_path)
        config = base_config(db_path, state_dir)
        settings = {
            "existingMemoryContext": {"enabled": True, "max": 8, "snippetChars": 500, "minTerms": 1},
        }
        seed_ids = [insert_seed_memory(db_path, content) for content in case.get("seed", [])]
        raw = transcript_rows(*case["transcript"])
        exchanges = recent_exchanges(parse_transcript_lines(raw), 4)
        existing = load_existing_memory_context(exchanges, config=config, settings=settings, project="tfo")
        operations = resolve_operations(case["operations"], seed_ids)
        stored, skipped, rejected, _ = store_candidates(
            operations,
            config=config,
            cwd="E:/tfo",
            session_id=f"eval-{case['name']}",
            extraction_meta={"extractionMode": "eval-fixture", "llmModel": "fixture"},
        )
        con = sqlite3.connect(db_path)
        try:
            superseded = con.execute("SELECT COUNT(*) FROM memories WHERE superseded_by IS NOT NULL AND superseded_by != ''").fetchone()[0]
            active = con.execute(f"SELECT COUNT(*) FROM memories WHERE {ACTIVE_SQL}").fetchone()[0]
        finally:
            con.close()

    actual = {
        "stored": len(stored),
        "skipped": len(skipped),
        "rejected": len(rejected),
        "superseded": int(superseded),
    }
    expected = case["expected"]
    return {
        "name": case["name"],
        "passed": actual == expected,
        "expected": expected,
        "actual": actual,
        "activeRows": int(active),
        "existingContextCount": len(existing),
        "skipReasons": [row.get("reason") for row in skipped],
        "rejectReasons": [row.get("reason") for row in rejected],
    }


def run_all() -> dict[str, Any]:
    results = [run_case(case) for case in CASES]
    passed = sum(1 for result in results if result["passed"])
    return {
        "ok": passed == len(results),
        "cases": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay deterministic memory-harvester admission-quality cases.")
    parser.add_argument("--json", action="store_true", help="emit JSON report")
    args = parser.parse_args()
    report = run_all()
    if args.json:
        print(json.dumps(report, ensure_ascii=True, indent=2))
    else:
        for result in report["results"]:
            status = "PASS" if result["passed"] else "FAIL"
            print(f"{status} {result['name']}: actual={result['actual']} expected={result['expected']}")
        print(f"passed={report['passed']} failed={report['failed']} cases={report['cases']}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
