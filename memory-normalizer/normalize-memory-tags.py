#!/usr/bin/env python
"""Memory tag normalizer.

Enforces the configured project-tag taxonomy on the memory store. Dry-run by
default; --apply writes only the `tags` metadata column.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter

CONFIG_PATH = os.environ.get("HOOKS_CONFIG_PATH", "E:/hooks/config.json")
SCRIPT_ID = "tag-normalizer"


def load_config(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print(f"Cannot read {path}: {exc}", file=sys.stderr)
        raise SystemExit(2)


def script_settings(config: dict) -> dict:
    for script in config.get("scripts", []):
        if isinstance(script, dict) and script.get("id") == SCRIPT_ID:
            return script.get("settings") if isinstance(script.get("settings"), dict) else {}
    print(f"config.scripts entry id={SCRIPT_ID!r} not found", file=sys.stderr)
    raise SystemExit(2)


def configured_taxonomy(config: dict, settings: dict) -> dict:
    shared = config.get("shared") if isinstance(config.get("shared"), dict) else {}
    paths = shared.get("paths") if isinstance(shared.get("paths"), dict) else {}
    memory_tags = shared.get("memoryTags") if isinstance(shared.get("memoryTags"), dict) else {}
    projects = [p for p in shared.get("projects", []) if isinstance(p, dict)]

    cross_project = settings.get("crossProjectTag") or memory_tags.get("crossProjectTag") or "all"
    active_slugs = settings.get("activeSlugs")
    if not isinstance(active_slugs, list) or not active_slugs:
        active_slugs = [p.get("slug") for p in projects if p.get("kind") == "rebuild" and p.get("slug")]
    project_set = settings.get("projectSet")
    if not isinstance(project_set, list) or not project_set:
        project_set = [p.get("slug") for p in projects if p.get("slug")]
        project_set.append(cross_project)

    legacy_rewrite = {}
    legacy_rewrite.update(memory_tags.get("legacyRewrite") or {})
    legacy_rewrite.update(settings.get("legacyRewrite") or {})

    db_path = settings.get("memoryDb") or paths.get("memoryDb")
    if not isinstance(db_path, str) or not db_path:
        print("shared.paths.memoryDb must be configured", file=sys.stderr)
        raise SystemExit(2)

    return {
        "db": db_path,
        "active": [str(item) for item in active_slugs if item],
        "project": {str(item) for item in project_set if item},
        "crossProjectTag": str(cross_project),
        "legacyRewrite": {str(k): str(v) for k, v in legacy_rewrite.items()},
    }


def arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Normalize memory project tags.")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--summary-only", action="store_true")
    parser.add_argument("--hash", dest="hash_prefix")
    parser.add_argument("--config", default=CONFIG_PATH)
    return parser


def normalize(parts: list[str], taxonomy: dict) -> tuple[str, bool, set[str]]:
    project = taxonomy["project"]
    cross_tag = taxonomy["crossProjectTag"]
    legacy = taxonomy["legacyRewrite"]
    active = taxonomy["active"]

    rewritten: list[str] = []
    seen = set()
    cross = cross_tag in parts
    for tag in parts:
        new_tag = legacy.get(tag, tag)
        if new_tag == cross_tag or tag in legacy:
            cross = True
        if new_tag and new_tag not in seen:
            rewritten.append(new_tag)
            seen.add(new_tag)

    new = set(rewritten)
    if cross:
        new.add(cross_tag)
        new.update(active)

    non_project = [tag for tag in rewritten if tag not in project]
    project_tags = sorted(tag for tag in new if tag in project)
    return ",".join(non_project + project_tags), cross, new


def main() -> int:
    args = arg_parser().parse_args()
    config = load_config(args.config)
    taxonomy = configured_taxonomy(config, script_settings(config))
    con = sqlite3.connect(taxonomy["db"])

    if args.hash_prefix:
        rows = con.execute(
            "SELECT content_hash, tags, content FROM memories "
            "WHERE content_hash LIKE ? ORDER BY COALESCE(updated_at, created_at, 0) DESC LIMIT 10",
            (args.hash_prefix + "%",),
        ).fetchall()
        if not rows:
            print(f"No memory matched hash prefix: {args.hash_prefix}")
        for content_hash, tags, content in rows:
            snippet = (content or "").replace("\n", " ").strip()
            if len(snippet) > 500:
                snippet = snippet[:500].rsplit(" ", 1)[0] + " ..."
            print(f"{content_hash}\n  tags: {tags}\n  content: {snippet}\n")
        return 0

    rows = con.execute(
        "SELECT content_hash, tags FROM memories "
        "WHERE deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')"
    ).fetchall()

    changes, no_project = [], []
    for content_hash, tags in rows:
        parts = [item.strip() for item in (tags or "").split(",") if item.strip()]
        current = set(parts)
        new_tags, _cross, new = normalize(parts, taxonomy)
        if not (new & taxonomy["project"]):
            no_project.append((content_hash, tags))
        if new != current:
            changes.append((content_hash, tags, new_tags))

    if not args.summary_only:
        for content_hash, old, new in changes:
            print(f"{content_hash[:10]}: [{old}] -> [{new}]")
            if args.apply:
                con.execute("UPDATE memories SET tags=?, updated_at=? WHERE content_hash=?", (new, time.time(), content_hash))
    else:
        for content_hash, _old, new in changes:
            if args.apply:
                con.execute("UPDATE memories SET tags=?, updated_at=? WHERE content_hash=?", (new, time.time(), content_hash))

    if args.apply:
        con.commit()
    con.close()

    print(f"\n{'APPLIED' if args.apply else 'DRY-RUN'}: {len(changes)} entries change; {len(no_project)} have NO project tag (reported, not auto-fixed).")
    if args.summary_only:
        print("NO-PROJECT tag groups:")
        for tags, count in Counter(tags or "" for _, tags in no_project).most_common():
            print(f"  {count:3} [{tags}]")
    else:
        print("NO-PROJECT entries (need a project tag - write-time hook is the fix):")
        for content_hash, tags in no_project:
            print(f"  {content_hash[:10]} [{tags}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
