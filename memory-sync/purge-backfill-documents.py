#!/usr/bin/env python
"""Delete sqlite-memory backfill documents from Hindsight (requires API up)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_core"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hook_runtime import load_config  # noqa: E402
from hindsight_mcp import HindsightMcpClient  # noqa: E402

PREFIX = "sqlite-memory:"
DEFAULT_ENDPOINT = "http://127.0.0.1:10003/mcp/collective/"


def resolve_endpoint(config: dict) -> str:
    harvest = next((h for h in config.get("hooks") or [] if h.get("id") == "memory-harvester"), {})
    hindsight = (harvest.get("settings") or {}).get("hindsight") or {}
    endpoint = str(hindsight.get("endpoint") or "").strip()
    if endpoint:
        return endpoint
    inject = next((h for h in config.get("hooks") or [] if h.get("id") == "inject-protocol"), {})
    memory = ((inject.get("settings") or {}).get("sources") or {}).get("memory") or {}
    return str((memory.get("hindsight") or {}).get("endpoint") or DEFAULT_ENDPOINT)


def list_document_ids(client: HindsightMcpClient, *, prefix: str) -> list[str]:
    ids: set[str] = set()
    offset = 0
    limit = 100
    total = None
    while True:
        payload = client.call_tool("list_documents", {"limit": limit, "offset": offset})
        structured = payload.get("result", {}).get("structuredContent") or {}
        if not structured:
            text = ""
            for item in payload.get("result", {}).get("content") or []:
                if isinstance(item, dict):
                    text += str(item.get("text") or "")
            if text:
                try:
                    structured = json.loads(text)
                except Exception:
                    structured = {}
        items = structured.get("items") or []
        if total is None:
            total = int(structured.get("total") or 0)
        for item in items:
            doc_id = str(item.get("id") or "")
            if doc_id.startswith(prefix):
                ids.add(doc_id)
        offset += len(items)
        if not items or offset >= total:
            break
    return sorted(ids)


def purge(*, endpoint: str, prefix: str, dry_run: bool, max_passes: int = 10) -> dict:
    matched_ids: set[str] = set()
    deleted_ids: set[str] = set()
    errors: list[dict[str, str]] = []
    passes: list[dict[str, int]] = []
    remaining: list[str] = []

    for pass_no in range(1, max_passes + 1):
        # Hindsight document listing can be session-cached after deletes. Use a
        # fresh MCP session per pass so the stop condition reflects server state.
        client = HindsightMcpClient(endpoint, timeout_ms=120000, client_name=f"memory-sync-purge-{pass_no}")
        client.connect()
        doc_ids = list_document_ids(client, prefix=prefix)
        matched_ids.update(doc_ids)
        passes.append({"pass": pass_no, "matched": len(doc_ids)})
        remaining = doc_ids
        if not doc_ids or dry_run:
            break
        for doc_id in doc_ids:
            try:
                client.call_tool("delete_document", {"document_id": doc_id})
                deleted_ids.add(doc_id)
                if len(deleted_ids) % 25 == 0:
                    print(f"deleted {len(deleted_ids)}/{len(matched_ids)}", flush=True)
            except Exception as exc:
                errors.append({"documentId": doc_id, "error": str(exc)})
        if errors:
            break

    if not dry_run and not errors:
        client = HindsightMcpClient(endpoint, timeout_ms=120000, client_name="memory-sync-purge-verify")
        client.connect()
        remaining = list_document_ids(client, prefix=prefix)
        if remaining:
            errors.append(
                {
                    "documentId": "*",
                    "error": f"{len(remaining)} document(s) still matched prefix after {max_passes} purge passes",
                }
            )

    would_delete = len(matched_ids) if dry_run else 0
    return {
        "prefix": prefix,
        "matched": len(matched_ids),
        "deleted": len(deleted_ids),
        "wouldDelete": would_delete,
        "remaining": len(remaining),
        "passes": passes,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Purge sqlite-memory backfill documents from Hindsight")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prefix", default=PREFIX)
    parser.add_argument("--max-passes", type=int, default=10)
    args = parser.parse_args()

    config = load_config()
    endpoint = resolve_endpoint(config)
    stats = purge(endpoint=endpoint, prefix=args.prefix, dry_run=args.dry_run, max_passes=args.max_passes)
    progress = ROOT / ".state" / "memory-sync" / "backfill-progress.json"
    if not args.dry_run and progress.is_file():
        progress.write_text(
            json.dumps({"completedHashes": [], "purgedAt": stats, "errors": stats.get("errors", [])}, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps({"ok": not stats.get("errors"), "endpoint": endpoint, "stats": stats}, indent=2))
    return 0 if not stats.get("errors") else 1


if __name__ == "__main__":
    raise SystemExit(main())
