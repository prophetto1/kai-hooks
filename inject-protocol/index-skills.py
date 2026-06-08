#!/usr/bin/env python
# Mirrors allowlisted SKILL.md files into the configured memory SQLite FTS tables.
# Config authority: E:/hooks/config.json shared.paths + scripts[id=skill-indexer].settings.
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
import time

CONFIG = os.environ.get("HOOKS_CONFIG_PATH", "E:/hooks/config.json")
SCRIPT_ID = "skill-indexer"


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print(f"Cannot read {CONFIG}: {exc}", file=sys.stderr)
        raise SystemExit(2)


def find_script(config):
    scripts = config.get("scripts")
    if not isinstance(scripts, list):
        print("config.scripts must be a list", file=sys.stderr)
        raise SystemExit(2)
    for script in scripts:
        if isinstance(script, dict) and script.get("id") == SCRIPT_ID:
            return script
    print(f"config.scripts entry id={SCRIPT_ID!r} not found", file=sys.stderr)
    raise SystemExit(2)


def validate_config(config, script):
    errors = []
    shared = config.get("shared") if isinstance(config.get("shared"), dict) else {}
    paths = shared.get("paths") if isinstance(shared.get("paths"), dict) else {}
    settings = script.get("settings") if isinstance(script.get("settings"), dict) else {}
    scan_roots = settings.get("scanRoots")
    fts = settings.get("fts") if isinstance(settings.get("fts"), dict) else {}
    columns = fts.get("columns")

    if not isinstance(paths.get("memoryDb"), str):
        errors.append("shared.paths.memoryDb must be a string")
    if not isinstance(paths.get("skillsCatalog"), str):
        errors.append("shared.paths.skillsCatalog must be a string")
    if not isinstance(scan_roots, list) or not scan_roots:
        errors.append("skill-indexer.settings.scanRoots must be a non-empty array")
    else:
        for idx, root in enumerate(scan_roots):
            if not isinstance(root, dict):
                errors.append(f"scanRoots[{idx}] must be an object")
                continue
            for key in ("path", "source", "scope"):
                if not isinstance(root.get(key), str) or not root.get(key):
                    errors.append(f"scanRoots[{idx}].{key} must be a non-empty string")
    if not isinstance(settings.get("skipPathContains"), list):
        errors.append("skill-indexer.settings.skipPathContains must be an array")
    if not isinstance(columns, list) or columns != ["name", "description", "content"]:
        errors.append('skill-indexer.settings.fts.columns must be ["name","description","content"]')
    if not isinstance(settings.get("curatedRegex"), str):
        errors.append("skill-indexer.settings.curatedRegex must be a string")

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        raise SystemExit(2)


CFG = load_config()
SCRIPT = find_script(CFG)
validate_config(CFG, SCRIPT)

SHARED_PATHS = CFG["shared"]["paths"]
SETTINGS = SCRIPT["settings"]
DB = SHARED_PATHS["memoryDb"]
CATALOG = SHARED_PATHS["skillsCatalog"]
SCAN_ROOTS = SETTINGS["scanRoots"]
SKIP_PATH_CONTAINS = [x.lower() for x in SETTINGS["skipPathContains"]]
CURATED_REGEX = SETTINGS["curatedRegex"]


def clean_scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def fold_block(lines):
    paragraphs, current = [], []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            continue
        current.append(stripped)
    if current:
        paragraphs.append(" ".join(current))
    return "\n".join(paragraphs).strip()


def parse_frontmatter(text):
    if not text.startswith("---"):
        return None, None
    end = text.find("\n---", 3)
    if end == -1:
        return None, None
    name = desc = None
    lines = text[3:end].splitlines()
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        i += 1
        if not stripped or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip().lower()
        value = value.strip()
        if value in (">", "|", ">-", "|-", ">+", "|+"):
            style = value[0]
            block = []
            while i < len(lines):
                raw = lines[i]
                child = raw.strip()
                if child and not raw.startswith((" ", "\t")) and ":" in child:
                    break
                block.append(raw)
                i += 1
            value = fold_block(block) if style == ">" else "\n".join(x.strip() for x in block).strip()
        value = clean_scalar(value)
        if key == "name" and name is None:
            name = value
        elif key == "description" and desc is None:
            desc = value
    return name, desc


def skill_body(text):
    if not text.startswith("---"):
        return text.strip()
    end = text.find("\n---", 3)
    if end == -1:
        return text.strip()
    return text[end + len("\n---"):].strip()


def should_skip(path):
    normalized = path.replace("\\", "/").lower()
    return any(token in normalized for token in SKIP_PATH_CONTAINS)


def collect(allowlist):
    found = {}
    for root in SCAN_ROOTS:
        root_path = root["path"]
        if not os.path.isdir(root_path):
            continue
        for path in glob.glob(os.path.join(root_path, "**", "SKILL.md"), recursive=True):
            if should_skip(path):
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
            except Exception:
                continue
            name, desc = parse_frontmatter(text)
            if not name or not desc or name not in allowlist:
                continue
            candidate = {
                "name": name,
                "source": root["source"],
                "scope": root["scope"],
                "path": path.replace("\\", "/"),
                "description": desc,
                "content": skill_body(text),
            }
            previous = found.get(name)
            if previous is None or len(candidate["path"]) < len(previous["path"]):
                found[name] = candidate
    return list(found.values())


def load_curated():
    try:
        with open(CATALOG, encoding="utf-8") as fh:
            text = fh.read()
    except Exception:
        return set()
    values = re.findall(CURATED_REGEX, text)
    names = []
    for value in values:
        if isinstance(value, tuple):
            value = next((part for part in value if part), "")
        names.append(value.split(":")[-1])
    return set(names)


def parse_args():
    parser = argparse.ArgumentParser(description="Rebuild skills/skills_fts from allowlisted SKILL.md files.")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be indexed without modifying the DB.")
    parser.add_argument("--allow-empty", action="store_true", help="Permit rebuilding to zero skills (otherwise abort to avoid wiping the index).")
    parser.add_argument("--list", action="store_true", help="List indexed and missing skills.")
    return parser.parse_args()


def rebuild_index(conn, skills, now):
    """Atomic swap: DROP + CREATE + INSERT run inside ONE transaction, so a failure
    rolls back to the existing tables and concurrent readers never see an empty index."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DROP TABLE IF EXISTS skills")
        conn.execute("DROP TABLE IF EXISTS skills_fts")
        conn.execute("""CREATE TABLE skills(
            id INTEGER PRIMARY KEY,
            name TEXT,
            source TEXT,
            scope TEXT,
            path TEXT,
            description TEXT,
            content TEXT,
            curated INTEGER DEFAULT 0,
            indexed_at REAL
        )""")
        conn.execute("CREATE VIRTUAL TABLE skills_fts USING fts5(name, description, content)")
        for skill in skills:
            cur = conn.execute(
                "INSERT INTO skills(name,source,scope,path,description,content,curated,indexed_at) VALUES(?,?,?,?,?,?,?,?)",
                (skill["name"], skill["source"], skill["scope"], skill["path"], skill["description"], skill["content"], 1, now),
            )
            conn.execute(
                "INSERT INTO skills_fts(rowid,name,description,content) VALUES(?,?,?,?)",
                (cur.lastrowid, skill["name"], skill["description"], skill["content"]),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def report(skills, indexed_names, curated, missing, *, verb="Indexed"):
    by_source = {}
    for skill in skills:
        by_source[skill["source"]] = by_source.get(skill["source"], 0) + 1
    print(f"{verb} {len(skills)} skills into {DB} -> skills / skills_fts")
    print("  by source:", ", ".join(f"{key}={value}" for key, value in sorted(by_source.items())))
    print(f"  allowlist indexed: {len(indexed_names)}/{len(curated)}")
    print(f"  allowlist missing from configured roots: {len(missing)}")


def print_list(skills, missing):
    for skill in sorted(skills, key=lambda x: x["name"]):
        print(f" *[{skill['source']}/{skill['scope']}] {skill['name']}")
    for name in missing:
        print(f" ![missing] {name}")


def main():
    args = parse_args()
    curated = load_curated()
    if not curated:
        print(f"No allowlist entries loaded from {CATALOG}; aborting without changing {DB}", file=sys.stderr)
        return 2

    existing_roots = [root["path"] for root in SCAN_ROOTS if os.path.isdir(root["path"])]
    if not existing_roots:
        configured = ", ".join(root["path"] for root in SCAN_ROOTS)
        print(f"No configured skill roots exist: {configured}; aborting without changing {DB}", file=sys.stderr)
        return 2

    skills = collect(curated)
    indexed_names = {s["name"] for s in skills}
    missing = sorted(curated - indexed_names)

    # Data-loss guard: never wipe the live index to empty because of a misconfigured
    # allowlist or scan root. The existing tables are preserved unless --allow-empty.
    if not skills and not args.allow_empty:
        print(f"Collected 0 skills from existing roots; aborting without changing {DB} (use --allow-empty to wipe).", file=sys.stderr)
        return 2

    if args.dry_run:
        report(skills, indexed_names, curated, missing, verb="[dry-run] Would index")
        print("  (dry run: no changes written)")
        if args.list:
            print_list(skills, missing)
        return 0

    now = time.time()
    conn = sqlite3.connect(DB)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        rebuild_index(conn, skills, now)
    finally:
        conn.close()

    report(skills, indexed_names, curated, missing)
    if args.list:
        print_list(skills, missing)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
