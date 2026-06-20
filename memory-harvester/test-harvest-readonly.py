#!/usr/bin/env python
"""Read-only tests for memory-harvester."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent
ROOT = HOOK_DIR.parent
sys.path.insert(0, str(ROOT / "_core"))
sys.path.insert(0, str(ROOT / "memory-normalizer"))
sys.path.insert(0, str(HOOK_DIR))

from harvest_core import (  # noqa: E402
    ACTIVE_SQL,
    candidates_from_exchange,
    count_transcript_exchanges,
    exchange_count,
    harvest_session,
    load_existing_memory_context,
    recent_exchanges,
    parse_transcript_lines,
    read_text_tail,
    store_candidates,
)


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


def base_config(db_path: str, state_dir: str) -> dict:
    return {
        "shared": {
            "paths": {"memoryDb": db_path, "hooksDir": str(ROOT)},
            "projects": [{"slug": "kai-chattr", "repoPath": "E:/kai-chattr", "aliases": []}],
            "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}, "retiredTags": ["global", "untagged"]},
            "stopwords": "the and or",
        },
        "hooks": [{"id": "memory-harvester", "settings": {"stateDir": state_dir, "extraction": {"mode": "heuristic", "heuristic": {"maxSentencesPerExchange": 2, "minAssistantChars": 80}}}}],
    }


def write_transcript(path: str, count: int, *, assistant_padding_chars: int = 0) -> None:
    rows = []
    assistant_padding = " ".join(["Padding context for long transcript cadence tests."] * assistant_padding_chars)
    for index in range(1, count + 1):
        rows.append(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": f"Remember cadence decision {index}: keep harvester interval testing deterministic.",
                },
            }
        )
        rows.append(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": (
                        f"Decision: cadence memory {index} must remain deterministic in tests. "
                        "Why: Stop fires after every response, but harvesting should run only on the configured interval. "
                        f"{assistant_padding}"
                    ),
                },
            }
        )
    Path(path).write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def insert_raw_memory(
    db_path: str,
    content: str,
    *,
    tags: str = "kai-chattr,all",
    memory_type: str = "decision",
    deleted_at: float | None = None,
    superseded_by: str | None = None,
) -> int:
    con = sqlite3.connect(db_path)
    try:
        cur = con.execute(
            """
            INSERT INTO memories (
                content_hash, content, tags, memory_type, metadata,
                created_at, updated_at, created_at_iso, updated_at_iso,
                confidence, deleted_at, superseded_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"raw-{abs(hash((content, tags, deleted_at, superseded_by)))}",
                content,
                tags,
                memory_type,
                "{}",
                1000.0,
                1000.0,
                "1970-01-01T00:16:40Z",
                "1970-01-01T00:16:40Z",
                0.9,
                deleted_at,
                superseded_by,
            ),
        )
        row_id = int(cur.lastrowid)
        con.execute("INSERT INTO memory_content_fts(rowid, content) VALUES (?, ?)", (row_id, content))
        con.commit()
        return row_id
    finally:
        con.close()


def test_parse_and_exchange() -> None:
    raw = read_text_tail(str(HOOK_DIR / "fixtures" / "sample-transcript.jsonl"), 65536)
    messages = parse_transcript_lines(raw)
    exchanges = recent_exchanges(messages, 4)
    assert len(exchanges) == 2
    assert exchange_count(messages) == 2
    assert count_transcript_exchanges(str(HOOK_DIR / "fixtures" / "sample-transcript.jsonl")) == 2
    # Exchanges are newest-first; the durable decision is the older pair.
    user_text, assistant_text = exchanges[-1]
    candidates = candidates_from_exchange(user_text, assistant_text, project="kai-chattr", settings={})
    assert candidates
    assert any("typography" in item.lower() for item in candidates)


def test_harvest_writes_once() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        create_memory_db(db_path)
        config = base_config(db_path, state_dir)
        settings = {"stateDir": state_dir, "reviewLastExchanges": 4, "maxCandidatesPerStop": 6, "extraction": {"mode": "heuristic", "heuristic": {"maxSentencesPerExchange": 2, "minAssistantChars": 80}}}
        transcript = str(HOOK_DIR / "fixtures" / "sample-transcript.jsonl")
        payload = {
            "session_id": "readonly-test",
            "transcript_path": transcript,
            "cwd": "E:/kai-chattr",
        }
        first = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        second = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        assert first["stored"] >= 1
        assert second["reason"] == "already_harvested"
        con = sqlite3.connect(db_path)
        try:
            active = con.execute(f"SELECT COUNT(*) FROM memories WHERE {ACTIVE_SQL}").fetchone()[0]
            fts = con.execute("SELECT COUNT(*) FROM memory_content_fts").fetchone()[0]
        finally:
            con.close()
        assert active >= 1
        assert fts >= 1


def test_existing_memory_context_returns_active_scoped_rows() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        create_memory_db(db_path)
        active_id = insert_raw_memory(
            db_path,
            "Decision: Hindsight is not primary until SQLite backfill is complete.",
            tags="kai-chattr,all",
        )
        insert_raw_memory(
            db_path,
            "Decision: Deleted memories should not be shown.",
            tags="kai-chattr,all",
            deleted_at=123.0,
        )
        insert_raw_memory(
            db_path,
            "Decision: Superseded memories should not be shown.",
            tags="kai-chattr,all",
            superseded_by="999",
        )
        insert_raw_memory(
            db_path,
            "Decision: Other project memories should not be shown.",
            tags="blockdata",
        )
        config = base_config(db_path, state_dir)
        settings = {
            "existingMemoryContext": {
                "enabled": True,
                "max": 4,
                "snippetChars": 160,
                "minTerms": 1,
            }
        }

        rows = load_existing_memory_context(
            [("memory correction", "SQLite backfill means Hindsight is not primary yet.")],
            config=config,
            settings=settings,
            project="kai-chattr",
        )

        assert [row["id"] for row in rows] == [active_id]
        assert rows[0]["content"].startswith("Decision: Hindsight")
        assert rows[0]["memory_type"] == "decision"


def test_store_candidates_applies_skip_and_supersede_operations() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        create_memory_db(db_path)
        old_id = insert_raw_memory(
            db_path,
            "Decision: Hindsight is primary memory recall.",
            tags="kai-chattr,all",
        )
        config = base_config(db_path, state_dir)
        stored_rows, skipped_rows, rejected_rows, _ = store_candidates(
            [
                {"operation": "skip", "reason": "too_generic", "content": ""},
                {
                    "operation": "supersede",
                    "content": "Decision: SQLite/vector remains primary until Hindsight backfill is complete.",
                    "memory_type": "decision",
                    "reason": "User corrected the previous memory provider direction.",
                    "evidence": "SQLite/vector is primary until Hindsight is backfilled.",
                    "supersedes_id": old_id,
                    "confidence": 0.94,
                },
            ],
            config=config,
            cwd="E:/kai-chattr",
            session_id="operation-test",
            extraction_meta={"extractionMode": "llm", "llmModel": "spark-test"},
        )

        assert not rejected_rows
        assert len(skipped_rows) == 1
        assert skipped_rows[0]["reason"] == "too_generic"
        assert len(stored_rows) == 1
        new_id = stored_rows[0]["memoryId"]

        con = sqlite3.connect(db_path)
        try:
            old = con.execute("SELECT superseded_by FROM memories WHERE id = ?", (old_id,)).fetchone()
            active = con.execute(f"SELECT id, confidence FROM memories WHERE {ACTIVE_SQL}").fetchall()
        finally:
            con.close()

        assert old[0] == str(new_id)
        assert active == [(new_id, 0.94)]


def test_harvest_waits_for_exchange_interval() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        transcript = os.path.join(temp_dir, "transcript.jsonl")
        create_memory_db(db_path)
        config = base_config(db_path, state_dir)
        settings = {
            "stateDir": state_dir,
            "runAfterNewExchanges": 4,
            "reviewLastExchanges": 4,
            "maxCandidatesPerStop": 6,
            "extraction": {"mode": "heuristic", "heuristic": {"maxSentencesPerExchange": 2, "minAssistantChars": 80}},
        }
        payload = {
            "session_id": "cadence-test",
            "transcript_path": transcript,
            "cwd": "E:/kai-chattr",
        }

        write_transcript(transcript, 3)
        early = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        assert early["reason"] == "harvest_interval_not_reached"
        assert early["exchangeCount"] == 3
        assert early["newExchangesSinceHarvest"] == 3
        assert early["runAfterNewExchanges"] == 4
        assert early["reviewLastExchanges"] == 4

        write_transcript(transcript, 4)
        due = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        assert due["decision"] == "harvested"
        assert due["exchangeCount"] == 4
        assert due["newExchangesSinceHarvest"] == 4
        assert due["runAfterNewExchanges"] == 4
        assert due["reviewLastExchanges"] == 4
        assert due["stored"] >= 1

        write_transcript(transcript, 5)
        waiting = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        assert waiting["reason"] == "harvest_interval_not_reached"
        assert waiting["lastHarvestExchangeCount"] == 4
        assert waiting["newExchangesSinceHarvest"] == 1


def test_cadence_uses_full_transcript_count_when_tail_is_small() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "memory.db")
        state_dir = os.path.join(temp_dir, "state")
        transcript = os.path.join(temp_dir, "transcript.jsonl")
        create_memory_db(db_path)
        config = base_config(db_path, state_dir)
        settings = {
            "stateDir": state_dir,
            "transcriptTailBytes": 2500,
            "runAfterNewExchanges": 4,
            "reviewLastExchanges": 4,
            "maxCandidatesPerStop": 6,
            "extraction": {"mode": "heuristic", "heuristic": {"maxSentencesPerExchange": 2, "minAssistantChars": 80}},
        }
        payload = {
            "session_id": "long-tail-cadence-test",
            "transcript_path": transcript,
            "cwd": "E:/kai-chattr",
        }

        write_transcript(transcript, 4, assistant_padding_chars=25)
        first = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        assert first["decision"] == "harvested"
        assert first["exchangeCount"] == 4
        assert first["visibleExchangeCount"] < first["exchangeCount"]

        write_transcript(transcript, 8, assistant_padding_chars=25)
        second = harvest_session(payload, config, settings, cwd=payload["cwd"], project="kai-chattr")
        assert second["decision"] == "harvested"
        assert second["exchangeCount"] == 8
        assert second["lastHarvestExchangeCount"] == 4
        assert second["newExchangesSinceHarvest"] == 4
        assert second["visibleExchangeCount"] < second["exchangeCount"]


def main() -> int:
    test_parse_and_exchange()
    test_harvest_writes_once()
    test_existing_memory_context_returns_active_scoped_rows()
    test_store_candidates_applies_skip_and_supersede_operations()
    test_harvest_waits_for_exchange_interval()
    test_cadence_uses_full_transcript_count_when_tail_is_small()
    print(json.dumps({"ok": True, "tests": 6}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
