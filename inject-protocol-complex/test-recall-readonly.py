#!/usr/bin/env python
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile


RECALL = os.path.join(os.path.dirname(__file__), "recall.py")


def recall_config() -> dict:
    return {
        "ftsTable": "memory_content_fts",
        "joinTable": "memories",
        "filtersSql": ["m.deleted_at IS NULL"],
        "candidatePool": 10,
        "max": 3,
        "snippetChars": 160,
        "crossProjectTag": "all",
        "scoring": {
            "scoreScale": {"min": 0, "max": 100, "baseline": 0},
            "missingSignalPolicy": "drop-candidate",
            "minFinalScore": 1,
            "relativeFloor": 0,
            "signals": {
                "fts": {"weight": 0.5},
                "recency": {"weight": 0.25, "halfLifeDays": 30},
                "confidence": {"weight": 0.25},
            },
        },
    }


def test_missing_db_is_not_created_by_recall() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "memory.db")
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                RECALL,
                db_path,
                "memory",
                "",
                json.dumps(recall_config(), ensure_ascii=True),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        if os.path.exists(db_path):
            raise AssertionError(f"recall created missing DB file: {db_path}\nstdout={result.stdout}\nstderr={result.stderr}")


def main() -> int:
    test_missing_db_is_not_created_by_recall()
    print("complex recall read-only tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
