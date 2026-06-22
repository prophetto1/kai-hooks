#!/usr/bin/env python
"""Store harvester rows through mcp-memory-service sqlite_vec storage.

This file is intentionally small because the hook runtime Python and the
mcp-memory-service Python are different versions. harvest_core.py calls this
script with the mcp-memory-service interpreter so sqlite-vec and the embedding
model come from the same runtime that serves recall.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from mcp_memory_service.models.memory import Memory
from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage


DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"


def write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, sort_keys=True))


def model_cache_dir(payload: dict[str, Any]) -> Path:
    raw = payload.get("model_cache_dir") or os.environ.get("MCP_MEMORY_MODEL_CACHE_DIR")
    if raw:
        return Path(str(raw))
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata) / "mcp-memory" / "model-cache"
    return Path.home() / ".cache" / "mcp-memory"


def prepare_model_environment(payload: dict[str, Any]) -> None:
    cache_dir = model_cache_dir(payload)
    hf_home = cache_dir / "huggingface"
    sentence_home = cache_dir / "sentence-transformers"
    for path in (hf_home, sentence_home):
        path.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ["HF_HOME"] = str(hf_home)
    os.environ["SENTENCE_TRANSFORMERS_HOME"] = str(sentence_home)


def memory_from_payload(payload: dict[str, Any]) -> Memory:
    return Memory(
        content=str(payload["content"]),
        content_hash=str(payload["content_hash"]),
        tags=[str(tag) for tag in payload.get("tags") or [] if str(tag).strip()],
        memory_type=str(payload.get("memory_type") or "note"),
        metadata=dict(payload.get("metadata") or {}),
        created_at=payload.get("created_at"),
        created_at_iso=payload.get("created_at_iso"),
        updated_at=payload.get("updated_at"),
        updated_at_iso=payload.get("updated_at_iso"),
    )


def row_for_hash(storage: SqliteVecMemoryStorage, content_hash: str) -> tuple[int, float | None] | None:
    if not storage.conn:
        return None
    row = storage.conn.execute(
        "SELECT id, confidence FROM memories WHERE content_hash = ? AND deleted_at IS NULL",
        (content_hash,),
    ).fetchone()
    if not row:
        return None
    return int(row[0]), row[1]


def apply_harvester_columns(storage: SqliteVecMemoryStorage, row_id: int, confidence: Any) -> None:
    if not storage.conn:
        return
    if confidence is not None:
        storage.conn.execute(
            "UPDATE memories SET confidence = ? WHERE id = ?",
            (float(confidence), row_id),
        )
    storage.conn.commit()


async def store(payload: dict[str, Any]) -> dict[str, Any]:
    prepare_model_environment(payload)
    model = str(payload.get("embedding_model") or os.environ.get("MCP_EMBEDDING_MODEL") or DEFAULT_MODEL)
    storage = SqliteVecMemoryStorage(db_path=str(payload["db_path"]), embedding_model=model)
    try:
        await storage.initialize()
        memory = memory_from_payload(payload)
        success, message = await storage.store(memory, skip_semantic_dedup=True)
        existing = row_for_hash(storage, memory.content_hash)
        if not success:
            if "Duplicate content detected" in message and existing:
                return {
                    "ok": True,
                    "decision": "skip",
                    "reason": "duplicate",
                    "memoryId": existing[0],
                    "contentHash": memory.content_hash,
                    "embeddingModel": model,
                }
            return {"ok": False, "error": message, "embeddingModel": model}

        if not existing:
            return {"ok": False, "error": "stored row not found after vector store", "embeddingModel": model}
        apply_harvester_columns(storage, existing[0], payload.get("confidence"))
        return {
            "ok": True,
            "decision": "stored",
            "memoryId": existing[0],
            "contentHash": memory.content_hash,
            "embeddingModel": model,
        }
    finally:
        await storage.close()


async def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = await store(payload)
        write_json(result)
        return 0 if result.get("ok") else 1
    except Exception as exc:
        write_json({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
