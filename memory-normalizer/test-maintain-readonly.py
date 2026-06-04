#!/usr/bin/env python
from __future__ import annotations

import json
import os
import importlib.util
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "maintain-existing-memories.py"


def load_maintenance_module():
    spec = importlib.util.spec_from_file_location("memory_maintenance", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def keeper_score_fixture_rows() -> list[sqlite3.Row]:
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    try:
        con.execute(
            "CREATE TABLE memories("
            "id INTEGER PRIMARY KEY, tags TEXT, metadata TEXT, memory_type TEXT, "
            "confidence REAL, last_accessed REAL, updated_at REAL, created_at REAL)"
        )
        metadata = json.dumps({"memory_normalizer": {"version": "v1"}})
        rows = [
            (1, "decision,global,hooks,memory", metadata, "decision", 0.9, 100.0, 100.0, 100.0),
            (2, "decision,all,hooks,memory", metadata, "decision", 0.9, 100.0, 100.0, 100.0),
        ]
        con.executemany(
            "INSERT INTO memories(id, tags, metadata, memory_type, confidence, last_accessed, updated_at, created_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        return con.execute("SELECT * FROM memories ORDER BY id").fetchall()
    finally:
        con.close()


def write_config(temp_dir: str, db_path: str) -> str:
    config = {
        "shared": {
            "paths": {"memoryDb": db_path},
            "projects": [{"slug": "kai", "kind": "rebuild"}],
            "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}},
            "stopwords": "",
        }
    }
    config_path = os.path.join(temp_dir, "config.json")
    with open(config_path, "w", encoding="utf-8") as fh:
        json.dump(config, fh)
    return config_path


def test_dry_run_does_not_create_missing_db() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "missing-memory.db")
        config_path = write_config(tmp, db_path)
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--config", config_path, "--json"],
            check=False,
            capture_output=True,
            text=True,
        )

        if os.path.exists(db_path):
            raise AssertionError(
                f"maintain-existing-memories created missing DB file in dry-run: {db_path}\n"
                f"stdout={result.stdout}\nstderr={result.stderr}"
            )


def test_keeper_score_prefers_clean_active_tags_over_raw_retired_tags() -> None:
    maintenance = load_maintenance_module()
    config = {
        "shared": {
            "memoryTags": {
                "legacyRewrite": {"global": "all"},
                "retiredTags": ["global", "untagged"],
            }
        }
    }
    rows = keeper_score_fixture_rows()
    keeper = max(rows, key=lambda row: maintenance.keeper_score(row, config))
    if keeper["id"] != 2:
        scores = {row["id"]: maintenance.keeper_score(row, config) for row in rows}
        raise AssertionError(f"expected clean active-tag row id=2 to win, got id={keeper['id']} scores={scores}")


def main() -> int:
    test_dry_run_does_not_create_missing_db()
    test_keeper_score_prefers_clean_active_tags_over_raw_retired_tags()
    print("maintain-existing-memories tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
