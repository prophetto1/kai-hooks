#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "normalize-memory-tags.py"


def write_config(temp_dir: str, db_path: str) -> str:
    config = {
        "shared": {
            "paths": {"memoryDb": db_path},
            "projects": [{"slug": "kai", "kind": "rebuild"}],
            "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}},
        },
        "scripts": [{"id": "tag-normalizer", "settings": {}}],
    }
    config_path = os.path.join(temp_dir, "config.json")
    with open(config_path, "w", encoding="utf-8") as fh:
        json.dump(config, fh)
    return config_path


def run_normalizer(config_path: str, *extra_args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-B", str(SCRIPT), "--config", config_path, *extra_args],
        check=False,
        capture_output=True,
        text=True,
    )


def create_memory_db(db_path: str) -> None:
    con = sqlite3.connect(db_path)
    try:
        con.execute(
            "CREATE TABLE memories("
            "content_hash TEXT PRIMARY KEY, tags TEXT, content TEXT, deleted_at REAL, "
            "superseded_by TEXT, updated_at REAL, created_at REAL)"
        )
        con.execute(
            "INSERT INTO memories(content_hash, tags, content, deleted_at, superseded_by, updated_at, created_at) "
            "VALUES(?, ?, ?, NULL, '', ?, ?)",
            ("a" * 64, "global", "Decision: normalize this fixture.", 1.0, 1.0),
        )
        con.commit()
    finally:
        con.close()


def read_tags(db_path: str) -> str:
    con = sqlite3.connect(db_path)
    try:
        return con.execute("SELECT tags FROM memories WHERE content_hash = ?", ("a" * 64,)).fetchone()[0]
    finally:
        con.close()


def test_dry_run_does_not_create_missing_db() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "missing-memory.db")
        config_path = write_config(tmp, db_path)
        result = run_normalizer(config_path, "--summary-only")
        if os.path.exists(db_path):
            raise AssertionError(
                f"normalize-memory-tags created missing DB file in dry-run: {db_path}\n"
                f"stdout={result.stdout}\nstderr={result.stderr}"
            )


def test_apply_still_updates_existing_db() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "memory.db")
        create_memory_db(db_path)
        config_path = write_config(tmp, db_path)
        result = run_normalizer(config_path, "--apply", "--summary-only")
        if result.returncode != 0:
            raise AssertionError(f"apply failed unexpectedly\nstdout={result.stdout}\nstderr={result.stderr}")
        tags = read_tags(db_path)
        if tags != "all,kai":
            raise AssertionError(f"expected tags to be updated to all,kai, got {tags!r}")


def main() -> int:
    test_dry_run_does_not_create_missing_db()
    test_apply_still_updates_existing_db()
    print("normalize-memory-tags read-only tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
