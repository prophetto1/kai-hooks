#!/usr/bin/env python
"""Probe memory-harvester against a long transcript built from past Codex sessions.

The script never writes to the production memory DB. It extracts user/assistant
exchange text from local Codex rollout JSONL files, builds temporary transcripts,
and runs harvest_session with a temporary SQLite DB and temporary state.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_core"))
sys.path.insert(0, str(ROOT / "memory-normalizer"))
sys.path.insert(0, str(ROOT / "memory-harvester"))

from harvest_core import ACTIVE_SQL, harvest_session, text_from_content  # noqa: E402
from hook_runtime import load_config  # noqa: E402


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


def digest_text(text: str) -> str:
    return hashlib.sha256(" ".join(text.lower().split()).encode("utf-8")).hexdigest()


def clip_text(text: str, max_chars: int) -> tuple[str, bool]:
    if max_chars <= 0 or len(text) <= max_chars:
        return text, False
    return text[:max_chars].rsplit(" ", 1)[0] + "\n[clipped by long transcript probe]", True


def codex_session_files(source_root: Path, max_files: int) -> list[Path]:
    if not source_root.exists():
        return []
    files = [path for path in source_root.rglob("*.jsonl") if path.is_file()]
    return sorted(files, key=lambda path: path.stat().st_mtime, reverse=True)[:max_files]


def is_synthetic_user_prompt(text: str) -> bool:
    stripped = text.lstrip()
    return stripped.startswith("<hook_prompt") or stripped.startswith("<turn_aborted")


def extract_codex_exchanges(
    paths: list[Path],
    *,
    limit: int,
    max_message_chars: int,
    include_hook_prompts: bool,
) -> tuple[list[tuple[str, str]], dict[str, Any]]:
    exchanges: list[tuple[str, str]] = []
    current_user = ""
    assistant_parts: list[str] = []
    stats = {
        "filesScanned": 0,
        "messageRows": 0,
        "userMessages": 0,
        "assistantMessages": 0,
        "skippedHookPrompts": 0,
        "clippedMessages": 0,
        "jsonErrors": 0,
    }

    def flush_current() -> None:
        nonlocal current_user, assistant_parts
        if current_user and assistant_parts and len(exchanges) < limit:
            exchanges.append((current_user, "\n\n".join(assistant_parts)))
        current_user = ""
        assistant_parts = []

    for path in paths:
        if len(exchanges) >= limit:
            break
        stats["filesScanned"] += 1
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if len(exchanges) >= limit:
                    break
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    stats["jsonErrors"] += 1
                    continue
                if row.get("type") != "response_item":
                    continue
                payload = row.get("payload") or {}
                if not isinstance(payload, dict):
                    continue
                if payload.get("type") != "message":
                    continue
                role = str(payload.get("role") or "")
                if role not in {"user", "assistant"}:
                    continue
                text = text_from_content(payload)
                if not text.strip():
                    continue
                stats["messageRows"] += 1
                clipped, was_clipped = clip_text(text.strip(), max_message_chars)
                if was_clipped:
                    stats["clippedMessages"] += 1
                if role == "user":
                    if is_synthetic_user_prompt(clipped) and not include_hook_prompts:
                        stats["skippedHookPrompts"] += 1
                        continue
                    flush_current()
                    current_user = clipped
                    stats["userMessages"] += 1
                    continue
                if current_user:
                    assistant_parts.append(clipped)
                    stats["assistantMessages"] += 1
        flush_current()

    return exchanges[:limit], stats


def write_transcript(path: Path, exchanges: list[tuple[str, str]]) -> None:
    rows = []
    for user_text, assistant_text in exchanges:
        rows.append({"type": "user", "message": {"role": "user", "content": user_text}})
        rows.append({"type": "assistant", "message": {"role": "assistant", "content": assistant_text}})
    path.write_text("\n".join(json.dumps(row, ensure_ascii=True) for row in rows) + "\n", encoding="utf-8")


def db_snapshot(db_path: str, *, include_hashes: bool) -> dict[str, Any]:
    con = sqlite3.connect(db_path)
    try:
        active = con.execute(f"SELECT COUNT(*) FROM memories WHERE {ACTIVE_SQL}").fetchone()[0]
        fts = con.execute("SELECT COUNT(*) FROM memory_content_fts").fetchone()[0]
        snapshot: dict[str, Any] = {"active": active, "fts": fts}
        if include_hashes:
            rows = con.execute(
                "SELECT id, content_hash, length(content), tags, memory_type FROM memories ORDER BY id"
            ).fetchall()
            snapshot["rows"] = [
                {
                    "id": row[0],
                    "contentHash": row[1],
                    "contentLength": row[2],
                    "tags": row[3],
                    "memoryType": row[4],
                }
                for row in rows
            ]
        return snapshot
    finally:
        con.close()


def slim_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "decision": result.get("decision"),
        "reason": result.get("reason"),
        "exchangeCount": result.get("exchangeCount"),
        "visibleExchangeCount": result.get("visibleExchangeCount"),
        "newExchangesSinceHarvest": result.get("newExchangesSinceHarvest"),
        "reviewLastExchanges": result.get("reviewLastExchanges"),
        "runAfterNewExchanges": result.get("runAfterNewExchanges"),
        "exchangesScanned": result.get("exchangesScanned"),
        "extractionMode": result.get("extractionMode"),
        "llmModel": result.get("llmModel"),
        "llmUsage": result.get("llmUsage"),
        "llmRawPreview": result.get("llmRawPreview"),
        "candidates": result.get("candidates"),
        "stored": result.get("stored"),
        "skipped": result.get("skipped"),
        "rejected": result.get("rejected"),
        "storedRows": result.get("storedRows"),
        "hindsight": result.get("hindsight"),
    }


def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config()
    hook = next(hook for hook in config.get("hooks", []) if hook.get("id") == "memory-harvester")
    source_files = codex_session_files(args.source_root, args.max_session_files)
    exchanges, extract_stats = extract_codex_exchanges(
        source_files,
        limit=args.exchange_count,
        max_message_chars=args.max_message_chars,
        include_hook_prompts=args.include_hook_prompts,
    )
    if len(exchanges) < args.exchange_count:
        raise RuntimeError(f"Only found {len(exchanges)} exchanges; requested {args.exchange_count}")

    temp_context = tempfile.TemporaryDirectory() if not args.keep_temp else None
    temp_dir = Path(temp_context.name if temp_context else tempfile.mkdtemp(prefix="harvester-long-probe-"))
    db_path = temp_dir / "memory.db"
    transcript_path = temp_dir / "transcript.jsonl"
    state_dir = temp_dir / "state"
    create_memory_db(str(db_path))

    test_config = json.loads(json.dumps(config))
    test_config.setdefault("shared", {}).setdefault("paths", {})["memoryDb"] = str(db_path).replace("\\", "/")
    settings = json.loads(json.dumps(hook.get("settings") or {}))
    settings["stateDir"] = str(state_dir).replace("\\", "/")
    if not args.enable_hindsight:
        settings.setdefault("hindsight", {})["enabled"] = False
    if args.force_heuristic:
        settings.setdefault("extraction", {})["mode"] = "heuristic"

    cadence = int(settings.get("runAfterNewExchanges") or 1)
    run_points = list(range(cadence, len(exchanges) + 1, cadence))
    if args.final_only:
        run_points = [len(exchanges)]

    runs = []
    for count in run_points:
        write_transcript(transcript_path, exchanges[:count])
        payload = {
            "session_id": args.session_id,
            "transcript_path": str(transcript_path),
            "cwd": args.cwd,
        }
        result = harvest_session(payload, test_config, settings, cwd=args.cwd, project=args.project)
        slim = slim_result(result)
        if not args.include_raw_preview:
            slim.pop("llmRawPreview", None)
        runs.append({"exchangePrefix": count, "result": slim, "db": db_snapshot(str(db_path), include_hashes=False)})

    final_snapshot = db_snapshot(str(db_path), include_hashes=True)
    output = {
        "sourceRoot": str(args.source_root),
        "sourceFilesUsed": [str(path) for path in source_files[: extract_stats["filesScanned"]]],
        "realMemoryDb": config.get("shared", {}).get("paths", {}).get("memoryDb"),
        "tempDir": str(temp_dir),
        "tempKept": bool(args.keep_temp),
        "settingsUnderTest": {
            "reviewLastExchanges": settings.get("reviewLastExchanges"),
            "runAfterNewExchanges": settings.get("runAfterNewExchanges"),
            "extractionMode": (settings.get("extraction") or {}).get("mode"),
            "model": ((settings.get("extraction") or {}).get("llm") or {}).get("model"),
            "hindsightEnabled": (settings.get("hindsight") or {}).get("enabled"),
        },
        "extractStats": extract_stats,
        "exchangesBuilt": len(exchanges),
        "exchangeDigests": [
            {
                "index": index,
                "userHash": digest_text(user_text),
                "assistantHash": digest_text(assistant_text),
                "userLength": len(user_text),
                "assistantLength": len(assistant_text),
            }
            for index, (user_text, assistant_text) in enumerate(exchanges[: args.digest_count], start=1)
        ],
        "runCount": len(runs),
        "runs": runs,
        "finalDb": final_snapshot,
    }
    if temp_context:
        temp_context.cleanup()
        output["tempDirDeleted"] = True
    return output


def compact_output(output: dict[str, Any]) -> dict[str, Any]:
    runs = output.get("runs") or []
    rows = (output.get("finalDb") or {}).get("rows") or []
    totals = Counter()
    decisions = Counter()
    memory_types = Counter()
    tags = Counter()
    run_summaries = []

    for run in runs:
        result = run.get("result") or {}
        db = run.get("db") or {}
        decisions[str(result.get("decision") or "unknown")] += 1
        for key in ("candidates", "stored", "skipped", "rejected"):
            totals[key] += int(result.get(key) or 0)
        run_summaries.append(
            {
                "exchangePrefix": run.get("exchangePrefix"),
                "decision": result.get("decision"),
                "reason": result.get("reason"),
                "exchangeCount": result.get("exchangeCount"),
                "visibleExchangeCount": result.get("visibleExchangeCount"),
                "newExchangesSinceHarvest": result.get("newExchangesSinceHarvest"),
                "exchangesScanned": result.get("exchangesScanned"),
                "candidates": result.get("candidates"),
                "stored": result.get("stored"),
                "skipped": result.get("skipped"),
                "rejected": result.get("rejected"),
                "dbActive": db.get("active"),
                "dbFts": db.get("fts"),
                "hindsight": result.get("hindsight"),
            }
        )

    for row in rows:
        memory_types[str(row.get("memoryType") or "unknown")] += 1
        for tag in str(row.get("tags") or "").split(","):
            if tag:
                tags[tag] += 1

    final_db = output.get("finalDb") or {}
    return {
        "sourceRoot": output.get("sourceRoot"),
        "sourceFilesUsed": output.get("sourceFilesUsed"),
        "realMemoryDb": output.get("realMemoryDb"),
        "tempDir": output.get("tempDir"),
        "tempKept": output.get("tempKept"),
        "tempDirDeleted": output.get("tempDirDeleted"),
        "settingsUnderTest": output.get("settingsUnderTest"),
        "extractStats": output.get("extractStats"),
        "exchangesBuilt": output.get("exchangesBuilt"),
        "exchangeDigests": output.get("exchangeDigests"),
        "runCount": output.get("runCount"),
        "runTotals": dict(totals),
        "decisionCounts": dict(decisions),
        "runSummaries": run_summaries,
        "finalDb": {
            "active": final_db.get("active"),
            "fts": final_db.get("fts"),
            "rowCount": len(rows),
            "memoryTypes": dict(memory_types),
            "topTags": dict(tags.most_common(12)),
        },
        "rawTranscriptPrinted": False,
        "rawMemoryContentPrinted": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a long memory-harvester probe from past Codex sessions")
    parser.add_argument("--source-root", type=Path, default=Path.home() / ".codex" / "sessions")
    parser.add_argument("--exchange-count", type=int, default=100)
    parser.add_argument("--max-session-files", type=int, default=50)
    parser.add_argument("--max-message-chars", type=int, default=4000)
    parser.add_argument("--digest-count", type=int, default=8)
    parser.add_argument("--session-id", default="long-transcript-probe")
    parser.add_argument("--cwd", default="E:/hooks")
    parser.add_argument("--project", default="hooks")
    parser.add_argument("--include-hook-prompts", action="store_true")
    parser.add_argument("--include-raw-preview", action="store_true")
    parser.add_argument("--force-heuristic", action="store_true")
    parser.add_argument("--final-only", action="store_true", help="Run only once after the full transcript is built")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--full-output", action="store_true", help="Print every stored hash row instead of compact counts")
    parser.add_argument("--enable-hindsight", action="store_true", help="Also send accepted memories to Hindsight")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = run_probe(args)
    if not args.full_output:
        output = compact_output(output)
    print(json.dumps(output, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
