#!/usr/bin/env python
"""Push harvested memory rows to Hindsight via MCP sync_retain."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

DOCUMENT_ID_PREFIX = "sqlite-memory:"


def resolve_hindsight_settings(config: dict[str, Any], harvest_settings: dict[str, Any]) -> dict[str, Any] | None:
    block = harvest_settings.get("hindsight")
    if not isinstance(block, dict) or block.get("enabled") is not True:
        return None

    endpoint = str(block.get("endpoint") or "").strip()
    if not endpoint:
        for hook in config.get("hooks") or []:
            if hook.get("id") != "inject-protocol":
                continue
            memory = ((hook.get("settings") or {}).get("sources") or {}).get("memory") or {}
            hindsight = memory.get("hindsight") or {}
            endpoint = str(hindsight.get("endpoint") or "").strip()
            break
    if not endpoint:
        return None

    normalized = endpoint.rstrip("/") + "/"
    return {
        "enabled": True,
        "endpoint": normalized,
        "tool": str(block.get("tool") or "retain"),
        "timeoutMs": int(block.get("timeoutMs") or 120000),
        "documentIdPrefix": str(block.get("documentIdPrefix") or DOCUMENT_ID_PREFIX),
        "strategy": block.get("strategy"),
    }


def parse_mcp_payload(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if not text:
        return {}
    if text.startswith("event:") or re.search(r"(^|\n)data: ", text):
        for line in text.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:])
        raise ValueError("MCP response used SSE but contained no data payload")
    return json.loads(text)


def mcp_post(url: str, body: dict[str, Any], headers: dict[str, str], timeout_sec: float) -> tuple[dict[str, str], dict[str, Any]]:
    payload = json.dumps(body, ensure_ascii=True).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            **headers,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            response_headers = {key.lower(): value for key, value in response.headers.items()}
            raw = response.read().decode("utf-8", errors="replace")
            if response.status >= 400:
                raise RuntimeError(f"HTTP {response.status}: {raw[:500]}")
            return response_headers, parse_mcp_payload(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {raw[:500]}") from exc


def session_header(response_headers: dict[str, str]) -> str:
    session_id = response_headers.get("mcp-session-id") or response_headers.get("Mcp-Session-Id")
    if not session_id:
        raise RuntimeError("Hindsight initialize returned no MCP session id")
    return session_id


def build_sync_retain_args(
    retain: dict[str, Any],
    *,
    hindsight_settings: dict[str, Any],
    session_id: str,
    memory_id: int | None = None,
) -> dict[str, Any]:
    fingerprint = str(retain.get("content_fingerprint") or "")
    prefix = str(hindsight_settings.get("documentIdPrefix") or DOCUMENT_ID_PREFIX)
    document_id = str(retain.get("document_id") or "").strip() or f"{prefix}{fingerprint}"

    context_obj = retain.get("context") or {}
    project = str(context_obj.get("project") or retain.get("metadata", {}).get("project") or "general")
    context = f"project:{project} harvest:stop-hook session:{session_id or 'unknown'}"

    metadata: dict[str, str] = {
        "source": "memory-harvester",
        "sqlite_content_hash": fingerprint,
        "memory_type": str(retain.get("memory_type") or ""),
        "harvest_source": "stop-hook",
    }
    if memory_id is not None:
        metadata["sqlite_id"] = str(memory_id)
    for key, value in (retain.get("metadata") or {}).items():
        if value in ("", None):
            continue
        if isinstance(value, (dict, list)):
            metadata[key] = json.dumps(value, ensure_ascii=True, sort_keys=True)
        else:
            metadata[key] = str(value)

    args: dict[str, Any] = {
        "content": str(retain.get("content") or ""),
        "context": context,
        "document_id": document_id,
        "tags": list(retain.get("tags") or []),
        "metadata": metadata,
    }
    if retain.get("created_at_iso"):
        args["timestamp"] = retain["created_at_iso"]
    strategy = hindsight_settings.get("strategy")
    if strategy:
        args["strategy"] = strategy
    return args


def call_retain(hindsight_settings: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    endpoint = hindsight_settings["endpoint"]
    timeout_sec = max(1.0, float(hindsight_settings.get("timeoutMs") or 120000) / 1000.0)
    tool = str(hindsight_settings.get("tool") or "retain")

    init_headers, _init_payload = mcp_post(
        endpoint,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "memory-harvester", "version": "1.0.0"},
            },
        },
        {},
        timeout_sec,
    )
    session_id = session_header(init_headers)
    session_headers = {"mcp-session-id": session_id}

    mcp_post(
        endpoint,
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        session_headers,
        timeout_sec,
    )

    _call_headers, call_payload = mcp_post(
        endpoint,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        },
        session_headers,
        timeout_sec,
    )
    result = call_payload.get("result") or {}
    if result.get("isError"):
        text_parts = []
        for item in result.get("content") or []:
            if isinstance(item, dict):
                text_parts.append(str(item.get("text") or item.get("content") or ""))
        raise RuntimeError("; ".join(part for part in text_parts if part) or f"{tool} returned isError")
    return call_payload


def sync_retain_row(
    retain: dict[str, Any],
    *,
    hindsight_settings: dict[str, Any],
    session_id: str,
    memory_id: int | None = None,
) -> dict[str, Any]:
    args = build_sync_retain_args(
        retain,
        hindsight_settings=hindsight_settings,
        session_id=session_id,
        memory_id=memory_id,
    )
    if not args["content"].strip():
        return {"decision": "skip", "reason": "empty_content", "documentId": args.get("document_id")}

    call_retain(hindsight_settings, args)
    tool = str(hindsight_settings.get("tool") or "retain")
    decision = "synced" if tool == "sync_retain" else "queued"
    return {
        "decision": decision,
        "documentId": args["document_id"],
        "contentHash": args["metadata"].get("sqlite_content_hash"),
    }


def sync_stored_rows(
    stored: list[tuple[dict[str, Any], dict[str, Any]]],
    *,
    hindsight_settings: dict[str, Any],
    session_id: str,
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    for outcome, retain in stored:
        try:
            result = sync_retain_row(
                retain,
                hindsight_settings=hindsight_settings,
                session_id=session_id,
                memory_id=outcome.get("memoryId"),
            )
        except Exception as exc:
            result = {
                "decision": "error",
                "documentId": build_sync_retain_args(
                    retain,
                    hindsight_settings=hindsight_settings,
                    session_id=session_id,
                    memory_id=outcome.get("memoryId"),
                ).get("document_id"),
                "contentHash": outcome.get("contentHash"),
                "error": str(exc),
            }
        outcomes.append(result)
    return outcomes
