#!/usr/bin/env python
"""One-time backfill: E:/_memory/memory-sqlite.db active rows -> Hindsight documents."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_core"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hook_runtime import load_config  # noqa: E402
from hindsight_mcp import HindsightMcpClient  # noqa: E402

DOCUMENT_PREFIX = "sqlite-memory:"
ACTIVE_SQL = "deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')"
DEFAULT_STATE = ROOT / ".state" / "memory-sync" / "backfill-progress.json"


def resolve_endpoint(config: dict[str, Any]) -> str:
    harvest = next((h for h in config.get("hooks") or [] if h.get("id") == "memory-harvester"), {})
    hindsight = (harvest.get("settings") or {}).get("hindsight") or {}
    endpoint = str(hindsight.get("endpoint") or "").strip()
    if endpoint:
        return endpoint
    inject = next((h for h in config.get("hooks") or [] if h.get("id") == "inject-protocol"), {})
    memory = ((inject.get("settings") or {}).get("sources") or {}).get("memory") or {}
    endpoint = str((memory.get("hindsight") or {}).get("endpoint") or "").strip()
    if not endpoint:
        raise RuntimeError("No Hindsight endpoint in config (memory-harvester or inject-protocol)")
    return endpoint


def load_progress(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"completedHashes": [], "errors": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"completedHashes": [], "errors": []}


def save_progress(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [part.strip() for part in str(raw).split(",") if part.strip()]


def fetch_sqlite_rows(db_path: str) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(
            con.execute(
                f"""
                SELECT id, content_hash, content, tags, memory_type, metadata, created_at_iso
                FROM memories
                WHERE {ACTIVE_SQL}
                ORDER BY id ASC
                """
            )
        )
    finally:
        con.close()


def build_retain_args(row: sqlite3.Row) -> dict[str, Any]:
    content_hash = str(row["content_hash"] or "")
    document_id = f"{DOCUMENT_PREFIX}{content_hash}"
    memory_type = str(row["memory_type"] or "")
    tags = parse_tags(row["tags"])
    if memory_type and memory_type not in tags:
        tags = [memory_type, *tags]

    metadata: dict[str, str] = {
        "source": "E:/_memory/memory-sqlite.db",
        "sqlite_id": str(row["id"]),
        "sqlite_content_hash": content_hash,
        "memory_type": memory_type,
        "migration": "sqlite-backfill",
    }
    if row["created_at_iso"]:
        metadata["created_at_iso"] = str(row["created_at_iso"])

    raw_meta = row["metadata"]
    if raw_meta:
        try:
            parsed = json.loads(raw_meta)
            if isinstance(parsed, dict):
                for key, value in parsed.items():
                    if value in ("", None):
                        continue
                    if isinstance(value, (dict, list)):
                        metadata[key] = json.dumps(value, ensure_ascii=True, sort_keys=True)
                    else:
                        metadata[key] = str(value)
        except Exception:
            metadata["metadata_raw"] = str(raw_meta)[:500]

    project = "all"
    for tag in tags:
        if tag.startswith("project:"):
            project = tag.split(":", 1)[1]
            break

    args: dict[str, Any] = {
        "content": str(row["content"] or ""),
        "context": f"project:{project} migration:sqlite-backfill",
        "document_id": document_id,
        "tags": tags,
        "metadata": metadata,
        "strategy": "exact",
    }
    if row["created_at_iso"]:
        args["timestamp"] = str(row["created_at_iso"])
    return args


def list_existing_sqlite_documents(client: HindsightMcpClient) -> set[str]:
    existing: set[str] = set()
    offset = 0
    limit = 100
    while True:
        payload = client.call_tool("list_documents", {"limit": limit, "offset": offset})
        structured = payload.get("result", {}).get("structuredContent") or {}
        if not structured:
            result = payload.get("result") or {}
            text = ""
            for item in result.get("content") or []:
                if isinstance(item, dict):
                    text += str(item.get("text") or "")
            if text:
                try:
                    structured = json.loads(text)
                except Exception:
                    structured = {}
        items = structured.get("items") or []
        total = int(structured.get("total") or 0)
        for item in items:
            doc_id = str(item.get("id") or "")
            if doc_id.startswith(DOCUMENT_PREFIX):
                existing.add(doc_id)
        offset += len(items)
        if not items or offset >= total:
            break
    return existing


def run_backfill(
    *,
    db_path: str,
    endpoint: str,
    tool: str,
    state_path: Path,
    limit: int | None,
    dry_run: bool,
    skip_existing: bool,
) -> dict[str, Any]:
    rows = fetch_sqlite_rows(db_path)
    if limit is not None:
        rows = rows[:limit]

    progress = load_progress(state_path)
    completed = set(progress.get("completedHashes") or [])
    errors: list[dict[str, Any]] = list(progress.get("errors") or [])

    client = HindsightMcpClient(endpoint, timeout_ms=120000, client_name="memory-sync-backfill")
    existing_docs: set[str] = set()
    if skip_existing and not dry_run:
        client.connect()
        existing_docs = list_existing_sqlite_documents(client)

    stats = {
        "total": len(rows),
        "queued": 0,
        "skippedCompleted": 0,
        "skippedExisting": 0,
        "errors": 0,
        "dryRun": dry_run,
    }

    if not dry_run:
        client.connect()

    for index, row in enumerate(rows, start=1):
        content_hash = str(row["content_hash"] or "")
        document_id = f"{DOCUMENT_PREFIX}{content_hash}"

        if content_hash in completed:
            stats["skippedCompleted"] += 1
            continue
        if document_id in existing_docs:
            completed.add(content_hash)
            stats["skippedExisting"] += 1
            continue

        args = build_retain_args(row)
        if not args["content"].strip():
            errors.append({"contentHash": content_hash, "error": "empty content"})
            stats["errors"] += 1
            continue

        if dry_run:
            stats["queued"] += 1
            continue

        try:
            client.call_tool(tool, args)
            completed.add(content_hash)
            stats["queued"] += 1
            if index % 25 == 0 or index == len(rows):
                save_progress(
                    state_path,
                    {
                        "completedHashes": sorted(completed),
                        "errors": errors[-100:],
                        "lastIndex": index,
                        "lastDocumentId": document_id,
                        "updatedAt": time.time(),
                    },
                )
                print(f"[{index}/{len(rows)}] retained {document_id[:48]}...", flush=True)
        except Exception as exc:
            stats["errors"] += 1
            errors.append({"contentHash": content_hash, "documentId": document_id, "error": str(exc)})
            save_progress(
                state_path,
                {
                    "completedHashes": sorted(completed),
                    "errors": errors[-100:],
                    "lastIndex": index,
                    "lastError": str(exc),
                    "updatedAt": time.time(),
                },
            )
            print(f"[{index}/{len(rows)}] ERROR {content_hash[:16]}: {exc}", flush=True)

    save_progress(
        state_path,
        {
            "completedHashes": sorted(completed),
            "errors": errors[-100:],
            "finishedAt": time.time(),
            "stats": stats,
        },
    )
    stats["completedTotal"] = len(completed)
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill SQLite memories into Hindsight")
    parser.add_argument("--dry-run", action="store_true", help="Count work only; no retains")
    parser.add_argument("--limit", type=int, default=None, help="Max rows to process")
    parser.add_argument("--tool", default="retain", choices=["retain", "sync_retain"], help="Hindsight MCP retain tool")
    parser.add_argument("--state", default=str(DEFAULT_STATE), help="Progress file path")
    parser.add_argument("--no-skip-existing", action="store_true", help="Retain even if document id already exists")
    args = parser.parse_args()

    config = load_config()
    db_path = config.get("shared", {}).get("paths", {}).get("memoryDb", "E:/_memory/memory-sqlite.db")
    endpoint = resolve_endpoint(config)

    stats = run_backfill(
        db_path=db_path,
        endpoint=endpoint,
        tool=args.tool,
        state_path=Path(args.state),
        limit=args.limit,
        dry_run=args.dry_run,
        skip_existing=not args.no_skip_existing,
    )
    print(json.dumps({"ok": True, "endpoint": endpoint, "stats": stats}, ensure_ascii=True, indent=2))
    return 0 if stats.get("errors", 0) == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
