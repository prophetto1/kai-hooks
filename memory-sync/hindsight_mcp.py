#!/usr/bin/env python
"""Reusable Hindsight MCP client (single session, many tool calls)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any


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


class HindsightMcpClient:
    def __init__(self, endpoint: str, *, timeout_ms: int = 120000, client_name: str = "memory-sync") -> None:
        self.endpoint = endpoint.rstrip("/") + "/"
        self.timeout_sec = max(1.0, timeout_ms / 1000.0)
        self.client_name = client_name
        self.session_headers: dict[str, str] = {}
        self._ready = False

    def connect(self) -> None:
        init_headers, _payload = self._post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": self.client_name, "version": "1.0.0"},
                },
            },
            {},
        )
        session_id = init_headers.get("mcp-session-id") or init_headers.get("Mcp-Session-Id")
        if not session_id:
            raise RuntimeError("Hindsight initialize returned no MCP session id")
        self.session_headers = {"mcp-session-id": session_id}
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, self.session_headers)
        self._ready = True

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if not self._ready:
            self.connect()
        _headers, payload = self._post(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
            self.session_headers,
        )
        result = payload.get("result") or {}
        if result.get("isError"):
            parts = []
            for item in result.get("content") or []:
                if isinstance(item, dict):
                    parts.append(str(item.get("text") or item.get("content") or ""))
            raise RuntimeError("; ".join(part for part in parts if part) or f"{name} returned isError")
        return payload

    def _post(self, body: dict[str, Any], headers: dict[str, str]) -> tuple[dict[str, str], dict[str, Any]]:
        payload = json.dumps(body, ensure_ascii=True).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=payload,
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
                **headers,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_sec) as response:
                response_headers = {key.lower(): value for key, value in response.headers.items()}
                raw = response.read().decode("utf-8", errors="replace")
                if response.status >= 400:
                    raise RuntimeError(f"HTTP {response.status}: {raw[:500]}")
                return response_headers, parse_mcp_payload(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {raw[:500]}") from exc
