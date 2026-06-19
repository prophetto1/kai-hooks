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


def main() -> int:
    test_parse_json_array()
    test_parse_fenced_json()
    test_prompt_templates_from_config_shape()
    print(json.dumps({"ok": True, "tests": 3}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
