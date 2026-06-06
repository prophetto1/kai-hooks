#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile


SUGGEST = os.path.join(os.path.dirname(__file__), "suggest.py")


def suggest_config() -> dict:
    return {
        "ftsTable": "skills_fts",
        "joinTable": "skills",
        "candidatePool": 10,
        "max": 3,
        "scoring": {
            "scoreScale": {"min": 0, "max": 100, "baseline": 0},
            "missingSignalPolicy": "drop-candidate",
            "minFinalScore": 1,
            "relativeFloor": 0,
            "signals": {
                "fts": {
                    "weight": 0.5,
                    "fieldBoosts": {"name": 0.5, "description": 0.3, "content": 0.2},
                },
                "overlap": {"weight": 0.5, "minTerms": 1},
            },
        },
    }


def run_suggest(db_path: str, project: str = "all") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-B",
            SUGGEST,
            db_path,
            "memory",
            project,
            "memory",
            json.dumps(suggest_config(), ensure_ascii=True),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def create_skill_db(db_path: str) -> None:
    con = sqlite3.connect(db_path)
    try:
        con.execute(
            "CREATE TABLE skills("
            "id INTEGER PRIMARY KEY, name TEXT, description TEXT, content TEXT, scope TEXT, curated INTEGER)"
        )
        con.execute("CREATE VIRTUAL TABLE skills_fts USING fts5(name, description, content)")
        cur = con.execute(
            "INSERT INTO skills(name, description, content, scope, curated) VALUES(?, ?, ?, ?, ?)",
            ("memory-helper", "memory workflow helper", "memory recall and tagging support", "all", 1),
        )
        con.execute(
            "INSERT INTO skills_fts(rowid, name, description, content) VALUES(?, ?, ?, ?)",
            (cur.lastrowid, "memory-helper", "memory workflow helper", "memory recall and tagging support"),
        )
        cur = con.execute(
            "INSERT INTO skills(name, description, content, scope, curated) VALUES(?, ?, ?, ?, ?)",
            ("memory-helper-project", "memory workflow helper", "memory recall and tagging support", "kai-chattr", 1),
        )
        con.execute(
            "INSERT INTO skills_fts(rowid, name, description, content) VALUES(?, ?, ?, ?)",
            (cur.lastrowid, "memory-helper-project", "memory workflow helper", "memory recall and tagging support"),
        )
        cur = con.execute(
            "INSERT INTO skills(name, description, content, scope, curated) VALUES(?, ?, ?, ?, ?)",
            ("memory-helper-other", "memory workflow helper", "memory recall and tagging support", "blockdata", 1),
        )
        con.execute(
            "INSERT INTO skills_fts(rowid, name, description, content) VALUES(?, ?, ?, ?)",
            (cur.lastrowid, "memory-helper-other", "memory workflow helper", "memory recall and tagging support"),
        )
        con.commit()
    finally:
        con.close()


def test_suggest_reads_existing_db() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "skills.db")
        create_skill_db(db_path)
        result = run_suggest(db_path)
        if result.returncode != 0:
            raise AssertionError(f"suggest failed unexpectedly\nstdout={result.stdout}\nstderr={result.stderr}")
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        if not rows or rows[0]["name"] != "memory-helper":
            raise AssertionError(f"suggest did not return fixture skill: {result.stdout}")


def test_suggest_filters_and_prioritizes_project_scope_before_limit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "skills.db")
        create_skill_db(db_path)
        result = run_suggest(db_path, project="kai-chattr")
        if result.returncode != 0:
            raise AssertionError(f"suggest failed unexpectedly\nstdout={result.stdout}\nstderr={result.stderr}")
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        names = [row["name"] for row in rows]
        if "memory-helper-other" in names:
            raise AssertionError(f"suggest returned out-of-scope skill: {result.stdout}")
        if not rows or rows[0]["name"] != "memory-helper-project":
            raise AssertionError(f"suggest did not prioritize project-scoped skill: {result.stdout}")


def test_missing_db_is_not_created_by_suggest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "missing-skills.db")
        result = run_suggest(db_path)
        if os.path.exists(db_path):
            raise AssertionError(f"suggest created missing DB file: {db_path}\nstdout={result.stdout}\nstderr={result.stderr}")


def main() -> int:
    test_suggest_reads_existing_db()
    test_suggest_filters_and_prioritizes_project_scope_before_limit()
    test_missing_db_is_not_created_by_suggest()
    print("suggest read-only tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
