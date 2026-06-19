#!/usr/bin/env python
"""Stop hook: harvest durable facts from the session transcript into SQLite memory."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent
ROOT = HOOK_DIR.parent
LIB = ROOT / "_core"
NORMALIZER = ROOT / "memory-normalizer"
sys.path.insert(0, str(LIB))
sys.path.insert(0, str(NORMALIZER))
sys.path.insert(0, str(HOOK_DIR))

from hook_runtime import detect_project, hook_cfg, is_enabled, load_config, read_stdin_json  # noqa: E402
from harvest_core import harvest_session  # noqa: E402

HOOK_ID = "memory-harvester"


def write_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))


def self_test(config: dict) -> int:
    import sqlite3
    import tempfile

    def _create_db(db_path: str) -> None:
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

    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db").replace("\\", "/")
        state_dir = os.path.join(temp_dir, "state").replace("\\", "/")
        _create_db(db_path)
        test_config = json.loads(json.dumps(config))
        test_config.setdefault("shared", {}).setdefault("paths", {})["memoryDb"] = db_path
        sample = {
            "session_id": "harvest-self-test",
            "cwd": "E:/kai-chattr",
            "hook_event_name": "Stop",
            "transcript_path": str(HOOK_DIR / "fixtures" / "sample-transcript.jsonl"),
        }
        hcfg = hook_cfg(test_config, HOOK_ID)
        settings = dict(hcfg.get("settings", {}))
        settings["stateDir"] = state_dir
        settings["runAfterNewExchanges"] = 1
        extraction = dict(settings.get("extraction") or {})
        extraction["mode"] = "heuristic"
        settings["extraction"] = extraction
        result = harvest_session(
            sample,
            test_config,
            settings,
            cwd=sample["cwd"],
            project=detect_project(sample["cwd"], test_config.get("shared", {}).get("projects", [])),
        )
    write_json(
        {
            "continue": True,
            "id": HOOK_ID,
            "configLoaded": True,
            "harvest": result,
            "systemMessage": f"memory-harvester self-test: {result.get('decision')} stored={result.get('stored', 0)}",
        }
    )
    return 0


def main() -> int:
    try:
        config = load_config()
    except Exception as exc:
        write_json({"continue": True, "systemMessage": f"memory-harvester skipped: config load failed: {exc}"})
        return 0

    if "--self-test" in sys.argv:
        return self_test(config)

    hcfg = hook_cfg(config, HOOK_ID)
    if not is_enabled(hcfg):
        write_json({"continue": True, "systemMessage": "memory-harvester disabled"})
        return 0

    payload = read_stdin_json()
    cwd = str(payload.get("cwd") or os.getcwd())
    project = detect_project(cwd, config.get("shared", {}).get("projects", []))
    settings = hcfg.get("settings") or {}

    try:
        result = harvest_session(payload, config, settings, cwd=cwd, project=project)
    except Exception as exc:
        write_json({"continue": True, "systemMessage": f"memory-harvester failed open: {exc}"})
        return 0

    message = None
    if result.get("stored"):
        hindsight = result.get("hindsight") or {}
        hindsight_note = ""
        if hindsight.get("enabled"):
            hindsight_note = f" Hindsight synced {hindsight.get('synced', 0)}."
        message = f"memory-harvester stored {result['stored']} durable fact(s) for {project or 'session'}.{hindsight_note}"
    write_json({"continue": True, "harvest": result, "systemMessage": message})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
