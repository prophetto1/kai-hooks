#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path("E:/hooks")
SCRIPT = ROOT / "inject-protocol" / "index-skills.py"

SKILL_FIXTURE = """---
name: {name}
description: {desc}
---

# {name}

{body}
"""


def write_skill(warehouse: Path, slug: str, name: str, desc: str, body: str) -> None:
    folder = warehouse / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(SKILL_FIXTURE.format(name=name, desc=desc, body=body), encoding="utf-8")


def base_config(*, memory_db: Path, catalog: Path, scan_root: Path) -> dict:
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    config["shared"]["paths"]["memoryDb"] = str(memory_db).replace("\\", "/")
    config["shared"]["paths"]["skillsCatalog"] = str(catalog).replace("\\", "/")
    script = next(s for s in config["scripts"] if s["id"] == "skill-indexer")
    script["settings"]["scanRoots"] = [
        {"path": str(scan_root).replace("\\", "/"), "source": "warehouse", "scope": "all"}
    ]
    return config


def run_indexer(config_path: Path, *args: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        text=True,
        capture_output=True,
        cwd=ROOT,
        env=env,
    )


def skills_names(db: Path):
    """Return sorted skill names, or None if the skills table is absent."""
    if not db.exists():
        return None
    con = sqlite3.connect(db)
    try:
        try:
            return con.execute("SELECT name FROM skills ORDER BY name").fetchall()
        except sqlite3.OperationalError:
            return None
    finally:
        con.close()


def main() -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="index-skills-test-") as td:
        root = Path(td)
        warehouse = root / "warehouse"
        catalog = root / "skills-catalog.md"
        db = root / "memory.db"

        write_skill(warehouse, "alpha", "alpha-skill", "Alpha does A.", "Alpha body.")
        write_skill(warehouse, "beta", "beta-skill", "Beta does B.", "Beta body.")
        catalog.write_text("- `alpha-skill` - a\n- `beta-skill` - b\n", encoding="utf-8")

        config_path = root / "config.json"
        config_path.write_text(json.dumps(base_config(memory_db=db, catalog=catalog, scan_root=warehouse)), encoding="utf-8")

        # 1) A normal rebuild populates skills + skills_fts from the allowlisted warehouse skills.
        proc = run_indexer(config_path)
        checks.append(("rebuild exits 0", proc.returncode == 0, proc.stderr))
        checks.append(("rebuild populated both skills", skills_names(db) == [("alpha-skill",), ("beta-skill",)], skills_names(db)))

        # 2) --dry-run must NOT mutate. Remove beta, dry-run, and assert the DB is unchanged (still both).
        (warehouse / "beta" / "SKILL.md").unlink()
        dry = run_indexer(config_path, "--dry-run")
        checks.append(("dry-run exits 0", dry.returncode == 0, dry.stderr))
        checks.append(("dry-run did not mutate", skills_names(db) == [("alpha-skill",), ("beta-skill",)], skills_names(db)))

        # 3) Data-loss guard: when 0 skills are collected, abort WITHOUT wiping the existing index.
        empty_catalog = root / "empty-catalog.md"
        empty_catalog.write_text("- `does-not-exist-skill` - x\n", encoding="utf-8")
        empty_config = root / "empty-config.json"
        empty_config.write_text(json.dumps(base_config(memory_db=db, catalog=empty_catalog, scan_root=warehouse)), encoding="utf-8")
        guard = run_indexer(empty_config)
        checks.append(("zero-collected aborts nonzero", guard.returncode != 0, (guard.returncode, guard.stderr)))
        checks.append(("zero-collected preserved old index", skills_names(db) == [("alpha-skill",), ("beta-skill",)], skills_names(db)))

        # 4) A real rebuild after the change reflects the removal and leaves no temp swap tables behind.
        proc2 = run_indexer(config_path)
        checks.append(("rebuild after change exits 0", proc2.returncode == 0, proc2.stderr))
        checks.append(("rebuild reflects removal", skills_names(db) == [("alpha-skill",)], skills_names(db)))
        con = sqlite3.connect(db)
        try:
            leftover = con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'skills_new%' OR name LIKE 'skills_fts_new%')"
            ).fetchall()
        finally:
            con.close()
        checks.append(("no temp swap tables remain", leftover == [], leftover))

    failures = [{"check": name, "info": str(info)} for name, ok, info in checks if not ok]
    if failures:
        print(json.dumps({"failures": failures}, indent=2))
        return 1
    print("index-skills tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
