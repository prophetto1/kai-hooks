#!/usr/bin/env python
"""One-off live test: LLM harvest via local Codex proxy (temp DB only)."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_core"))
sys.path.insert(0, str(ROOT / "memory-normalizer"))
sys.path.insert(0, str(HOOK_DIR := Path(__file__).resolve().parent))

from hook_runtime import detect_project, load_config  # noqa: E402
from harvest_core import harvest_session  # noqa: E402


def create_db(db_path: str) -> None:
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


def main() -> int:
    cfg = load_config()
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        create_db(db_path)
        test_config = json.loads(json.dumps(cfg))
        test_config.setdefault("shared", {}).setdefault("paths", {})["memoryDb"] = db_path.replace("\\", "/")
        hook = next(item for item in test_config["hooks"] if item["id"] == "memory-harvester")
        settings = dict(hook.get("settings") or {})
        settings["stateDir"] = state_dir.replace("\\", "/")
        settings["runAfterNewExchanges"] = 1
        settings.setdefault("extraction", {})["mode"] = "llm"
        settings["extraction"].setdefault("fallbackMode", "none")
        payload = {
            "session_id": "live-llm-test",
            "cwd": "E:/kai-chattr",
            "transcript_path": str(HOOK_DIR / "fixtures" / "sample-transcript.jsonl"),
        }
        result = harvest_session(
            payload,
            test_config,
            settings,
            cwd=payload["cwd"],
            project=detect_project(payload["cwd"], test_config.get("shared", {}).get("projects", [])),
        )
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result.get("extractionMode") == "llm" and result.get("stored", 0) >= 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())
