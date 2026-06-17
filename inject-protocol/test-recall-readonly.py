#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time


RECALL = os.path.join(os.path.dirname(__file__), "recall.py")


def recall_config() -> dict:
    return {
        "ftsTable": "memory_content_fts",
        "joinTable": "memories",
        "filtersSql": ["m.deleted_at IS NULL"],
        "candidatePool": 10,
        "max": 3,
        "snippetChars": 160,
        "crossProjectTag": "all",
        "scoring": {
            "scoreScale": {"min": 0, "max": 100, "baseline": 0},
            "missingSignalPolicy": "drop-candidate",
            "minFinalScore": 1,
            "relativeFloor": 0,
            "signals": {
                "fts": {"weight": 0.5},
                "recency": {"weight": 0.25, "halfLifeDays": 30},
                "confidence": {"weight": 0.25},
            },
        },
    }


def test_missing_db_is_not_created_by_recall() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "memory.db")
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                RECALL,
                db_path,
                "memory",
                "",
                json.dumps(recall_config(), ensure_ascii=True),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        if os.path.exists(db_path):
            raise AssertionError(f"recall created missing DB file: {db_path}\nstdout={result.stdout}\nstderr={result.stderr}")


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
                confidence REAL,
                deleted_at REAL DEFAULT NULL
            );
            CREATE VIRTUAL TABLE memory_content_fts USING fts5(
                content,
                content='memories',
                content_rowid='id',
                tokenize='trigram'
            );
            """
        )
        content = (
            "JWC Global platform memory anchor: jwc-global AI runtime pydantic providers. "
            "Builds Chat uses full-stack-ai-agent-template as a conversation donor. "
            "CareerOps uses JobSpy as the scanner."
        )
        cur = con.execute(
            """
            INSERT INTO memories (content_hash, content, tags, memory_type, metadata, created_at, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("jwc-memory-anchor", content, "jwc-global,all", "decision", "{}", time.time(), 1.0),
        )
        con.execute("INSERT INTO memory_content_fts(rowid, content) VALUES (?, ?)", (cur.lastrowid, content))
        con.commit()
    finally:
        con.close()


def test_hyphenated_query_terms_are_safe_for_fts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "memory.db")
        create_memory_db(db_path)
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                RECALL,
                db_path,
                "jwc-global full-stack-ai-agent-template CareerOps JobSpy",
                "jwc-global",
                json.dumps(recall_config(), ensure_ascii=True),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise AssertionError(f"recall failed on hyphenated terms:\nstdout={result.stdout}\nstderr={result.stderr}")
        if "JWC Global platform memory anchor" not in result.stdout:
            raise AssertionError(f"recall did not return expected memory:\nstdout={result.stdout}\nstderr={result.stderr}")


def main() -> int:
    test_missing_db_is_not_created_by_recall()
    test_hyphenated_query_terms_are_safe_for_fts()
    print("recall read-only tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
