#!/usr/bin/env python
"""Read-only tests for LLM harvest parsing and prompt assembly from config."""
from __future__ import annotations

import json
import sys
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOK_DIR))

from harvest_llm import build_llm_prompts, parse_harvest_json  # noqa: E402


def test_parse_json_array() -> None:
    raw = '[{"content":"Decision: SQLite is primary.","memory_type":"decision"}]'
    rows = parse_harvest_json(raw, allowed_memory_types=["decision", "learning"])
    assert len(rows) == 1
    assert rows[0]["content"].startswith("Decision:")
    assert rows[0]["memory_type"] == "decision"


def test_parse_operation_json_array() -> None:
    raw = json.dumps(
        [
            {
                "operation": "supersede",
                "content": "Decision: SQLite/vector remains primary until Hindsight backfill is complete.",
                "memory_type": "decision",
                "confidence": 0.91,
                "reason": "User corrected the prior Hindsight-primary assumption.",
                "evidence": "User: SQLite/vector is primary until Hindsight is backfilled.",
                "supersedes_id": 42,
            },
            {"operation": "skip", "reason": "too_generic", "content": ""},
        ]
    )

    rows = parse_harvest_json(raw, allowed_memory_types=["decision", "learning"])

    assert rows[0]["operation"] == "supersede"
    assert rows[0]["supersedes_id"] == 42
    assert rows[0]["confidence"] == 0.91
    assert rows[0]["reason"].startswith("User corrected")
    assert rows[0]["evidence"].startswith("User:")
    assert rows[1]["operation"] == "skip"
    assert rows[1]["reason"] == "too_generic"


def test_parse_fenced_json() -> None:
    raw = '```json\n[{"content":"Learning: harvester uses Spark."}]\n```'
    rows = parse_harvest_json(raw)
    assert len(rows) == 1


def test_prompt_templates_from_config_shape() -> None:
    llm = {
        "userPromptHeader": "Project: {{project}}\nWorkspace: {{cwd}}",
        "exchangeTemplate": "U: {{user_text}}\nA: {{assistant_text}}",
        "taskPrompt": "Return JSON only.",
        "systemPrompt": "Extract facts.",
    }
    system, user = build_llm_prompts(
        [("decide sqlite", "Decision: use sqlite.")],
        llm=llm,
        project="hooks",
        cwd="E:/hooks",
        session_id="sess-1",
    )
    assert system == "Extract facts."
    assert "Project: hooks" in user
    assert "Decision: use sqlite." in user
    assert user.endswith("Return JSON only.")


def test_prompt_includes_existing_memory_context() -> None:
    llm = {
        "userPromptHeader": "Project: {{project}}\nWorkspace: {{cwd}}",
        "existingMemoryHeader": "Existing active memories:",
        "existingMemoryTemplate": "[{{index}}] id={{id}} type={{memory_type}} content={{content}}",
        "exchangeTemplate": "U: {{user_text}}\nA: {{assistant_text}}",
        "taskPrompt": "Return operation JSON only.",
        "systemPrompt": "Extract facts.",
    }
    _, user = build_llm_prompts(
        [("correct memory", "Decision: SQLite/vector remains primary.")],
        llm=llm,
        project="hooks",
        cwd="E:/hooks",
        session_id="sess-1",
        existing_memories=[
            {
                "id": 123,
                "content": "Decision: Hindsight is primary memory recall.",
                "memory_type": "decision",
                "tags": "hooks,all",
            }
        ],
    )

    assert "Existing active memories:" in user
    assert "id=123" in user
    assert "Hindsight is primary memory recall" in user
    assert "Return operation JSON only." in user


def main() -> int:
    test_parse_json_array()
    test_parse_operation_json_array()
    test_parse_fenced_json()
    test_prompt_templates_from_config_shape()
    test_prompt_includes_existing_memory_context()
    print(json.dumps({"ok": True, "tests": 5}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
