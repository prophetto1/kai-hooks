#!/usr/bin/env python
"""LLM-backed harvest extraction — all tunables come from config.json settings.extraction.llm."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

JSON_ARRAY_RE = re.compile(r"\[[\s\S]*\]")


def _base_root(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/v1"):
        return trimmed[:-3]
    return trimmed


def proxy_health_ok(llm: dict[str, Any]) -> bool:
    base_url = str(llm.get("baseUrl") or "").strip()
    if not base_url:
        return False
    required_model = str(llm.get("model") or "")
    timeout_sec = max(0.5, float(llm.get("healthCheckTimeoutMs", 3000)) / 1000.0)
    root = _base_root(base_url.rstrip("/"))
    try:
        with urllib.request.urlopen(f"{root}/health", timeout=timeout_sec) as response:
            if response.status != 200:
                return False
        with urllib.request.urlopen(f"{root}/v1/models", timeout=timeout_sec) as response:
            parsed = json.loads(response.read().decode("utf-8", errors="replace"))
        model_ids = [str(item.get("id") or "") for item in (parsed.get("data") or []) if isinstance(item, dict)]
        return (not required_model) or required_model in model_ids
    except Exception:
        return False


def ensure_proxy_if_needed(llm: dict[str, Any]) -> dict[str, Any]:
    if llm.get("autoEnsureProxy") is False:
        return {"attempted": False, "reason": "disabled"}
    if proxy_health_ok(llm):
        return {"attempted": False, "reason": "already_healthy"}

    script = str(llm.get("ensureScript") or "E:/hooks/codex-proxy/ensure-codex-proxy.ps1")
    timeout_sec = max(5.0, float(llm.get("ensureTimeoutMs", 90000)) / 1000.0)
    run_kwargs: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": timeout_sec,
        "check": False,
    }
    if sys.platform == "win32":
        run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-WindowStyle",
                "Hidden",
                "-NonInteractive",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script,
            ],
            **run_kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        return {"attempted": True, "ok": False, "reason": f"ensure timed out after {timeout_sec}s", "error": str(exc)}
    except Exception as exc:
        return {"attempted": True, "ok": False, "reason": "ensure failed", "error": str(exc)}

    ok = completed.returncode == 0 and proxy_health_ok(llm)
    detail = (completed.stdout or completed.stderr or "").strip()
    return {
        "attempted": True,
        "ok": ok,
        "exitCode": completed.returncode,
        "reason": "restarted" if ok else "ensure exited unhealthy",
        "detailPreview": detail[:240],
    }


def render_template(template: str, values: dict[str, Any]) -> str:
    text = str(template or "")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", "" if value is None else str(value))
    return text


def format_exchanges(
    exchanges: list[tuple[str, str]],
    *,
    llm: dict[str, Any],
    project: str,
    cwd: str,
    session_id: str,
) -> str:
    order = str(llm.get("exchangeOrder") or "oldest-first").lower()
    pairs = list(exchanges)
    if order == "oldest-first":
        pairs = list(reversed(pairs))

    exchange_template = str(
        llm.get("exchangeTemplate")
        or "--- Exchange {{index}} ---\nUser: {{user_text}}\nAssistant: {{assistant_text}}\n"
    )
    blocks: list[str] = []
    for index, (user_text, assistant_text) in enumerate(pairs, start=1):
        blocks.append(
            render_template(
                exchange_template,
                {
                    "index": index,
                    "user_text": user_text or "(none)",
                    "assistant_text": assistant_text,
                    "project": project,
                    "cwd": cwd,
                    "session_id": session_id,
                },
            ).rstrip()
        )
    return "\n\n".join(blocks)


def build_llm_prompts(
    exchanges: list[tuple[str, str]],
    *,
    llm: dict[str, Any],
    project: str,
    cwd: str,
    session_id: str,
) -> tuple[str, str]:
    header = render_template(
        str(llm.get("userPromptHeader") or ""),
        {"project": project or "all", "cwd": cwd, "session_id": session_id or "anonymous"},
    ).rstrip()
    body = format_exchanges(exchanges, llm=llm, project=project, cwd=cwd, session_id=session_id)
    task = str(llm.get("taskPrompt") or "").strip()
    parts = [part for part in (header, body, task) if part]
    user_prompt = "\n\n".join(parts)
    system_prompt = str(llm.get("systemPrompt") or "").strip()
    return system_prompt, user_prompt


def parse_harvest_json(raw: str, *, allowed_memory_types: list[str] | None = None) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return []
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    if not text.startswith("["):
        match = JSON_ARRAY_RE.search(text)
        if not match:
            raise ValueError("LLM response did not contain a JSON array")
        text = match.group(0)
    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise ValueError("LLM response JSON root must be an array")
    allowed = {item.lower() for item in (allowed_memory_types or [])}
    rows: list[dict[str, Any]] = []
    for item in parsed:
        if isinstance(item, str):
            content = item.strip()
            memory_type = ""
        elif isinstance(item, dict):
            content = str(item.get("content") or item.get("text") or "").strip()
            memory_type = str(item.get("memory_type") or item.get("type") or "").strip()
        else:
            continue
        if not content:
            continue
        row: dict[str, Any] = {"content": content}
        if memory_type and (not allowed or memory_type.lower() in allowed):
            row["memory_type"] = memory_type
        rows.append(row)
    return rows


def call_chat_completions(
    llm: dict[str, Any],
    *,
    system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    base_url = str(llm.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise ValueError("memory-harvester settings.extraction.llm.baseUrl is required when extraction.mode=llm")
    endpoint = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
    payload: dict[str, Any] = {
        "model": str(llm.get("model") or "gpt-5.3-codex-spark"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": float(llm.get("temperature", 0)),
    }
    max_tokens = llm.get("maxTokens")
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)
    reasoning = llm.get("reasoningEffort")
    if reasoning:
        payload["reasoning_effort"] = str(reasoning)

    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    api_key = str(llm.get("apiKey") or "local")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    timeout_sec = max(1.0, float(llm.get("timeoutMs", 45000)) / 1000.0)
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"LLM HTTP {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"LLM request failed: {exc}") from exc

    parsed = json.loads(raw)
    choices = parsed.get("choices") or []
    if not choices:
        raise ValueError("LLM response missing choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        content = "\n".join(part for part in parts if part)
    if not isinstance(content, str) or not content.strip():
        raise ValueError("LLM response missing assistant content")
    return {
        "content": content.strip(),
        "model": parsed.get("model") or payload["model"],
        "usage": parsed.get("usage") or {},
    }


def extract_candidates_llm(
    exchanges: list[tuple[str, str]],
    *,
    llm: dict[str, Any],
    project: str,
    cwd: str,
    session_id: str,
) -> dict[str, Any]:
    ensure_meta = ensure_proxy_if_needed(llm)
    if ensure_meta.get("attempted") and not ensure_meta.get("ok"):
        raise RuntimeError(f"Codex proxy unavailable: {ensure_meta.get('reason')}; {ensure_meta.get('detailPreview', '')}")

    system_prompt, user_prompt = build_llm_prompts(
        exchanges,
        llm=llm,
        project=project,
        cwd=cwd,
        session_id=session_id,
    )
    response = call_chat_completions(llm, system_prompt=system_prompt, user_prompt=user_prompt)
    allowed = llm.get("allowedMemoryTypes")
    allowed_list = [str(item) for item in allowed] if isinstance(allowed, list) else None
    rows = parse_harvest_json(response["content"], allowed_memory_types=allowed_list)
    max_items = int(llm.get("maxItemsPerStop", 6))
    return {
        "candidates": rows[:max_items],
        "model": response.get("model"),
        "usage": response.get("usage") or {},
        "rawPreview": response["content"][:240],
        "proxyEnsure": ensure_meta,
    }
