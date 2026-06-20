#!/usr/bin/env python
"""Read-only test for the deterministic harvest quality replay harness."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent


def test_eval_harness_reports_labeled_cases() -> None:
    result = subprocess.run(
        [sys.executable, str(HOOK_DIR / "eval-harvest-quality.py"), "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["passed"] == report["cases"]
    names = {case["name"] for case in report["results"]}
    assert {"garbage_skip", "durable_insert", "duplicate_skip", "correction_supersede"}.issubset(names)


def main() -> int:
    test_eval_harness_reports_labeled_cases()
    print(json.dumps({"ok": True, "tests": 1}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
