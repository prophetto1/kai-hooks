#!/usr/bin/env python
"""Read-only tests for Hindsight sync helpers in memory-harvester."""
from __future__ import annotations

import json
import sys
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOK_DIR))

from harvest_hindsight import (  # noqa: E402
    DOCUMENT_ID_PREFIX,
    build_sync_retain_args,
    parse_mcp_payload,
    resolve_hindsight_settings,
)


def test_parse_mcp_payload_json_and_sse() -> None:
    assert parse_mcp_payload('{"result":{"ok":true}}')["result"]["ok"] is True
    sse = "event: message\ndata: {\"result\":{\"items\":[]}}\n\n"
    assert parse_mcp_payload(sse)["result"]["items"] == []


def test_resolve_hindsight_settings() -> None:
    config = {
        "hooks": [
            {
                "id": "inject-protocol",
                "settings": {"sources": {"memory": {"hindsight": {"endpoint": "http://127.0.0.1:10003/mcp/collective/"}}}},
            }
        ]
    }
    assert resolve_hindsight_settings(config, {"hindsight": {"enabled": False}}) is None
    resolved = resolve_hindsight_settings(config, {"hindsight": {"enabled": True}})
    assert resolved is not None
    assert resolved["endpoint"] == "http://127.0.0.1:10003/mcp/collective/"
    assert resolved["tool"] == "retain"


def test_build_sync_retain_args() -> None:
    retain = {
        "content": "Decision: use SQLite as primary recall until Hindsight backfill completes.",
        "content_fingerprint": "abc123" * 8,
        "memory_type": "decision",
        "tags": ["decision", "hooks"],
        "created_at_iso": "2026-06-19T12:00:00Z",
        "context": {"project": "hooks"},
        "metadata": {"harvest_source": "stop-hook", "extraction_mode": "llm"},
    }
    args = build_sync_retain_args(
        retain,
        hindsight_settings={"documentIdPrefix": DOCUMENT_ID_PREFIX},
        session_id="sess-1",
        memory_id=42,
    )
    assert args["document_id"] == f"{DOCUMENT_ID_PREFIX}{retain['content_fingerprint']}"
    assert args["metadata"]["sqlite_content_hash"] == retain["content_fingerprint"]
    assert args["metadata"]["sqlite_id"] == "42"
    assert args["tags"] == ["decision", "hooks"]
    assert "project:hooks" in args["context"]

    args_exact = build_sync_retain_args(
        retain,
        hindsight_settings={"documentIdPrefix": DOCUMENT_ID_PREFIX, "strategy": "exact"},
        session_id="sess-1",
        memory_id=42,
    )
    assert args_exact["strategy"] == "exact"


def main() -> int:
    test_parse_mcp_payload_json_and_sse()
    test_resolve_hindsight_settings()
    test_build_sync_retain_args()
    print(json.dumps({"ok": True, "tests": 3}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
