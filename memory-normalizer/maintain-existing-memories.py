#!/usr/bin/env python
"""Normalize and dedupe existing memories.

Default mode is an audit-only dry run. `--apply` updates only safe memory
metadata columns. `--delete-exact` requires `--apply` and soft-deletes only
canonical exact duplicates; near-duplicate matches are review candidates only.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path
from typing import Any

HOOK_DIR = Path(__file__).resolve().parent
ROOT = HOOK_DIR.parent
LIB = ROOT / "_core"
sys.path.insert(0, str(LIB))
sys.path.insert(0, str(HOOK_DIR))

from memory_retain import (  # noqa: E402
    MemoryQualityError,
    build_retain_payload,
    cleanup_content,
    content_fingerprint,
    normalize_tags,
    parse_tags,
    tags_to_string,
)

CONFIG_PATH = os.environ.get("HOOKS_CONFIG_PATH", "E:/hooks/config.json")
SCRIPT_ID = "memory-maintenance"
ACTIVE_SQL = "deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')"
RETired_TAGS_FALLBACK = {"global", "untagged"}
DEFAULT_NEAR_THRESHOLD = 0.92
DEFAULT_MINHASH_PERMUTATIONS = 64
DEFAULT_LSH_BANDS = 16
DEFAULT_SHINGLE_SIZE = 4
BROAD_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_:/.-]{2,}")
BROAD_STOPWORDS = {
    "why",
    "context",
    "wrong",
    "right",
    "decision",
    "learning",
    "planning",
    "reference",
    "memory",
    "memories",
    "codex",
    "claude",
    "jon",
}


def load_config(path: str = CONFIG_PATH) -> dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def memory_db(config: dict[str, Any]) -> str:
    return config.get("shared", {}).get("paths", {}).get("memoryDb", "E:/memory/memory-sqlite.db")


def connect_readonly(db_path: str) -> sqlite3.Connection:
    normalized = os.path.abspath(db_path).replace("\\", "/")
    con = sqlite3.connect(f"file:{normalized}?mode=ro", uri=True, timeout=3.0)
    con.execute("PRAGMA busy_timeout=3000")
    return con


def utc_iso(ts: float | None = None) -> str:
    stamp = time.time() if ts is None else ts
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if not raw:
        return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {"legacy_metadata": raw}
    return {"legacy_metadata": str(raw)}


def active_rows(con: sqlite3.Connection) -> list[sqlite3.Row]:
    con.row_factory = sqlite3.Row
    return con.execute(f"SELECT * FROM memories WHERE {ACTIVE_SQL} ORDER BY id").fetchall()


def retired_tags(config: dict[str, Any]) -> set[str]:
    configured = config.get("shared", {}).get("memoryTags", {}).get("retiredTags", [])
    return set(parse_tags(configured)) | RETired_TAGS_FALLBACK


def row_normalization_plan(row: sqlite3.Row, config: dict[str, Any], *, scope: str = "needed") -> dict[str, Any]:
    retain = build_retain_payload(
        row["content"],
        config=config,
        cwd="",
        source_tool=SCRIPT_ID,
        session_id="",
    )
    existing_metadata = parse_metadata(row["metadata"])
    existing_normalizer = existing_metadata.get("memory_normalizer", {})
    if not isinstance(existing_normalizer, dict):
        existing_normalizer = {}

    existing_tags = normalize_tags(row["tags"], config)
    new_tags = normalize_tags([*existing_tags, *retain["tags"]], config)
    desired_tags = tags_to_string(new_tags, config)
    desired_type = retain["memory_type"]
    desired_core = {
        "version": "v1",
        "source_tool": existing_normalizer.get("source_tool") or SCRIPT_ID,
        "content_fingerprint": retain["content_fingerprint"],
        "classifier_source": retain["metadata"].get("classifier_source"),
        "classifier_confidence": retain["metadata"].get("classifier_confidence"),
    }

    raw_changed_columns: list[str] = []
    if str(row["tags"] if row["tags"] is not None else "") != desired_tags:
        raw_changed_columns.append("tags")
    if str(row["memory_type"] if row["memory_type"] is not None else "") != desired_type:
        raw_changed_columns.append("memory_type")
    if any(existing_normalizer.get(key) != value for key, value in desired_core.items()):
        raw_changed_columns.append("metadata")

    if scope == "all":
        changed_columns = raw_changed_columns
    elif scope == "needed":
        current_tags = set(item.strip() for item in str(row["tags"] or "").split(",") if item.strip())
        normalized_current_tags = set(normalize_tags(row["tags"], config))
        legacy_or_retired_tags = bool(current_tags - normalized_current_tags) or not current_tags
        metadata_needed = (
            not isinstance(existing_normalizer, dict)
            or existing_normalizer.get("version") != "v1"
            or existing_normalizer.get("content_fingerprint") != retain["content_fingerprint"]
        )
        current_type = str(row["memory_type"] or "")
        type_needed = current_type not in {"mistake", "decision", "planning", "reference", "learning"}
        changed_columns = []
        if "tags" in raw_changed_columns and legacy_or_retired_tags:
            changed_columns.append("tags")
        if "memory_type" in raw_changed_columns and type_needed:
            changed_columns.append("memory_type")
        if "metadata" in raw_changed_columns and metadata_needed:
            changed_columns.append("metadata")
    else:
        raise ValueError(f"unknown normalization scope: {scope}")

    return {
        "id": row["id"],
        "content_hash": row["content_hash"],
        "fingerprint": retain["content_fingerprint"],
        "memory_type": desired_type,
        "tags": desired_tags,
        "metadata": existing_metadata,
        "normalizer": desired_core,
        "changed_columns": sorted(set(changed_columns)),
        "raw_changed_columns": sorted(set(raw_changed_columns)),
    }


def apply_normalization(con: sqlite3.Connection, row: sqlite3.Row, plan: dict[str, Any], now: float) -> None:
    metadata = dict(plan["metadata"])
    metadata["memory_normalizer"] = {
        **plan["normalizer"],
        "normalized_at": now,
        "normalized_at_iso": utc_iso(now),
    }
    con.execute(
        "UPDATE memories SET tags = ?, memory_type = ?, metadata = ?, updated_at = ?, updated_at_iso = ? WHERE id = ?",
        (
            plan["tags"],
            plan["memory_type"],
            json.dumps(metadata, ensure_ascii=True, sort_keys=True),
            now,
            utc_iso(now),
            row["id"],
        ),
    )


def keeper_score(row: sqlite3.Row, config: dict[str, Any]) -> tuple[Any, ...]:
    metadata = parse_metadata(row["metadata"])
    normalizer = metadata.get("memory_normalizer")
    raw_tags = set(parse_tags(row["tags"]))
    tags = set(normalize_tags(row["tags"], config))
    retired = retired_tags(config)
    confidence = row["confidence"] if "confidence" in row.keys() and row["confidence"] is not None else 0
    recency = row["last_accessed"] or row["updated_at"] or row["created_at"] or 0
    return (
        1 if isinstance(normalizer, dict) else 0,
        1 if not (raw_tags & retired) else 0,
        1 if row["memory_type"] else 0,
        len(tags),
        float(confidence),
        float(recency),
        -int(row["id"]),
    )


def exact_duplicate_groups(rows: list[sqlite3.Row], plans: dict[int, dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    groups: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        plan = plans.get(row["id"])
        if plan:
            groups[plan["fingerprint"]].append(row)

    result: list[dict[str, Any]] = []
    for fingerprint, members in groups.items():
        if len(members) < 2:
            continue
        keeper = max(members, key=lambda item: keeper_score(item, config))
        result.append(
            {
                "fingerprint": fingerprint,
                "keeper": row_summary(keeper),
                "duplicates": [row_summary(row) for row in members if row["id"] != keeper["id"]],
            }
        )
    return sorted(result, key=lambda item: item["fingerprint"])


def row_summary(row: sqlite3.Row) -> dict[str, Any]:
    content = (row["content"] or "").replace("\n", " ").strip()
    if len(content) > 180:
        content = content[:180].rsplit(" ", 1)[0] + " ..."
    return {
        "id": row["id"],
        "content_hash": row["content_hash"],
        "tags": row["tags"] or "",
        "memory_type": row["memory_type"] or "",
        "snippet": content,
    }


def soft_delete_exact_duplicates(con: sqlite3.Connection, duplicate_groups: list[dict[str, Any]], now: float) -> int:
    deleted = 0
    for group in duplicate_groups:
        for duplicate in group["duplicates"]:
            row = con.execute("SELECT metadata FROM memories WHERE id = ?", (duplicate["id"],)).fetchone()
            metadata = parse_metadata(row[0] if row else "")
            metadata["memory_dedupe"] = {
                "deleted_by": SCRIPT_ID,
                "deleted_at": now,
                "deleted_at_iso": utc_iso(now),
                "reason": "canonical exact duplicate",
                "keeper_id": group["keeper"]["id"],
                "fingerprint": group["fingerprint"],
            }
            con.execute(
                "UPDATE memories SET deleted_at = ?, updated_at = ?, updated_at_iso = ?, metadata = ? WHERE id = ?",
                (now, now, utc_iso(now), json.dumps(metadata, ensure_ascii=True, sort_keys=True), duplicate["id"]),
            )
            deleted += 1
    return deleted


def tokens(text: str) -> list[str]:
    cleaned = cleanup_content(text).lower()
    return [part for part in "".join(ch if ch.isalnum() else " " for ch in cleaned).split() if part]


def shingles(text: str, size: int) -> set[str]:
    parts = tokens(text)
    if not parts:
        return set()
    if len(parts) < size:
        return {" ".join(parts)}
    return {" ".join(parts[index : index + size]) for index in range(len(parts) - size + 1)}


def stable_int(value: str) -> int:
    return int.from_bytes(hashlib.blake2b(value.encode("utf-8"), digest_size=8).digest(), "big")


def minhash_signature(shingle_set: set[str], permutations: int) -> tuple[int, ...]:
    if not shingle_set:
        return tuple()
    signature = []
    for seed in range(permutations):
        signature.append(min(stable_int(f"{seed}:{item}") for item in shingle_set))
    return tuple(signature)


def jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    union = left | right
    if not union:
        return 0.0
    return len(left & right) / len(union)


def near_duplicate_candidates(
    rows: list[sqlite3.Row],
    *,
    threshold: float,
    shingle_size: int,
    permutations: int,
    bands: int,
) -> list[dict[str, Any]]:
    if permutations % bands != 0:
        raise ValueError("--minhash-permutations must be divisible by --lsh-bands")
    rows_by_id = {row["id"]: row for row in rows}
    shingle_by_id: dict[int, set[str]] = {}
    signature_by_id: dict[int, tuple[int, ...]] = {}
    for row in rows:
        try:
            row_shingles = shingles(row["content"], shingle_size)
        except MemoryQualityError:
            continue
        shingle_by_id[row["id"]] = row_shingles
        signature_by_id[row["id"]] = minhash_signature(row_shingles, permutations)

    bucket_members: dict[tuple[int, int], list[int]] = defaultdict(list)
    rows_per_band = permutations // bands
    for row_id, signature in signature_by_id.items():
        if len(signature) != permutations:
            continue
        for band in range(bands):
            start = band * rows_per_band
            bucket_key = stable_int(json.dumps(signature[start : start + rows_per_band]))
            bucket_members[(band, bucket_key)].append(row_id)

    pairs: set[tuple[int, int]] = set()
    for ids in bucket_members.values():
        if len(ids) < 2:
            continue
        sorted_ids = sorted(set(ids))
        for left_index, left_id in enumerate(sorted_ids):
            for right_id in sorted_ids[left_index + 1 :]:
                pairs.add((left_id, right_id))

    candidates = []
    for left_id, right_id in sorted(pairs):
        score = jaccard(shingle_by_id[left_id], shingle_by_id[right_id])
        if score >= threshold:
            candidates.append(
                {
                    "jaccard": round(score, 4),
                    "left": row_summary(rows_by_id[left_id]),
                    "right": row_summary(rows_by_id[right_id]),
                }
            )
    return sorted(candidates, key=lambda item: (-item["jaccard"], item["left"]["id"], item["right"]["id"]))


def broad_tokens(text: str, config: dict[str, Any]) -> list[str]:
    configured_stopwords = set(str(config.get("shared", {}).get("stopwords", "")).split())
    stopwords = configured_stopwords | BROAD_STOPWORDS
    return [
        token
        for token in BROAD_WORD_RE.findall(" ".join((text or "").lower().split()))
        if token not in stopwords and len(token) > 2
    ]


def token_ngrams(tokens_value: list[str], size: int) -> set[tuple[str, ...]]:
    if not tokens_value:
        return set()
    if len(tokens_value) < size:
        return {tuple(tokens_value)}
    return {tuple(tokens_value[index : index + size]) for index in range(len(tokens_value) - size + 1)}


def broad_pairwise_candidates(rows: list[sqlite3.Row], config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return high-overlap review candidates from an all-pairs comparison.

    This is intentionally for small stores like the local memory DB. For larger
    stores, use blocking or MinHash/LSH before this all-pairs scoring pass.
    """
    items = []
    for row in rows:
        canonical = " ".join((row["content"] or "").lower().split())
        tokens_value = broad_tokens(canonical, config)
        items.append(
            {
                "id": row["id"],
                "content_hash": row["content_hash"],
                "content": row["content"] or "",
                "canonical": canonical,
                "tokens": set(tokens_value),
                "shingle3": token_ngrams(tokens_value, 3),
                "shingle5": token_ngrams(tokens_value, 5),
                "tags": row["tags"] or "",
                "memory_type": row["memory_type"] or "",
            }
        )

    candidates = []
    for left, right in combinations(items, 2):
        left_tokens = left["tokens"]
        right_tokens = right["tokens"]
        if not left_tokens or not right_tokens:
            continue
        intersection = len(left_tokens & right_tokens)
        min_tokens = min(len(left_tokens), len(right_tokens))
        union = len(left_tokens | right_tokens)
        containment = intersection / min_tokens if min_tokens else 0.0
        jaccard_score = intersection / union if union else 0.0
        shingle3 = len(left["shingle3"] & right["shingle3"]) / (len(left["shingle3"] | right["shingle3"]) or 1)
        shingle5 = len(left["shingle5"] & right["shingle5"]) / (len(left["shingle5"] | right["shingle5"]) or 1)
        substring = min(len(left["canonical"]), len(right["canonical"])) >= 80 and (
            left["canonical"] in right["canonical"] or right["canonical"] in left["canonical"]
        )
        plausible = substring or containment >= 0.55 or jaccard_score >= 0.35 or shingle3 >= 0.25 or shingle5 >= 0.18
        sequence = SequenceMatcher(None, left["canonical"], right["canonical"], autojunk=True).ratio() if plausible else 0.0
        if not (
            substring
            or containment >= 0.70
            or jaccard_score >= 0.45
            or shingle3 >= 0.40
            or shingle5 >= 0.32
            or sequence >= 0.72
        ):
            continue
        candidates.append(
            {
                "score": round(max(jaccard_score, shingle3, shingle5, containment * 0.72, sequence * 0.88, 1.0 if substring else 0.0), 4),
                "metrics": {
                    "containment": round(containment, 4),
                    "jaccard": round(jaccard_score, 4),
                    "shingle3": round(shingle3, 4),
                    "shingle5": round(shingle5, 4),
                    "sequence": round(sequence, 4),
                    "substring": substring,
                },
                "left": row_summary_from_item(left),
                "right": row_summary_from_item(right),
            }
        )
    return sorted(candidates, key=lambda item: (-item["score"], item["left"]["id"], item["right"]["id"]))


def row_summary_from_item(item: dict[str, Any]) -> dict[str, Any]:
    content = (item["content"] or "").replace("\n", " ").strip()
    if len(content) > 180:
        content = content[:180].rsplit(" ", 1)[0] + " ..."
    return {
        "id": item["id"],
        "content_hash": item["content_hash"],
        "tags": item["tags"],
        "memory_type": item["memory_type"],
        "snippet": content,
    }


def build_report(
    rows: list[sqlite3.Row],
    plans: dict[int, dict[str, Any]],
    duplicate_groups: list[dict[str, Any]],
    near_candidates: list[dict[str, Any]],
    pairwise_candidates: list[dict[str, Any]],
    pairwise_ran: bool,
    normalize_errors: list[dict[str, Any]],
    *,
    applied: bool,
    normalization_changes: int,
    exact_deleted: int,
    db: str,
) -> dict[str, Any]:
    changed_column_counts: dict[str, int] = defaultdict(int)
    for plan in plans.values():
        for column in plan["changed_columns"]:
            changed_column_counts[column] += 1
    return {
        "db": db,
        "mode": "APPLIED" if applied else "DRY-RUN",
        "activeRows": len(rows),
        "normalization": {
            "rowsNeedingChange": normalization_changes,
            "changedColumnCounts": dict(sorted(changed_column_counts.items())),
            "errors": normalize_errors,
        },
        "exactDuplicates": {
            "groups": len(duplicate_groups),
            "duplicateRows": sum(len(group["duplicates"]) for group in duplicate_groups),
            "deletedRows": exact_deleted,
            "sampleGroups": duplicate_groups[:10],
        },
        "nearDuplicateCandidates": {
            "count": len(near_candidates),
            "samplePairs": near_candidates[:20],
            "reviewOnly": True,
        },
        "pairwiseDuplicateCandidates": {
            "ran": pairwise_ran,
            "pairsChecked": len(rows) * (len(rows) - 1) // 2 if pairwise_ran else 0,
            "count": len(pairwise_candidates),
            "samplePairs": pairwise_candidates[:20],
            "reviewOnly": True,
        },
    }


def print_report(report: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(report, indent=2, ensure_ascii=True, sort_keys=True))
        return
    print(f"{report['mode']}: {report['db']}")
    print(f"Active rows: {report['activeRows']}")
    print(
        "Normalization changes: "
        f"{report['normalization']['rowsNeedingChange']} "
        f"{report['normalization']['changedColumnCounts']}"
    )
    if report["normalization"]["errors"]:
        print(f"Normalization errors: {len(report['normalization']['errors'])}")
    exact = report["exactDuplicates"]
    print(f"Exact duplicate groups: {exact['groups']} ({exact['duplicateRows']} duplicate rows; deleted {exact['deletedRows']})")
    for group in exact["sampleGroups"]:
        print(f"  fingerprint {group['fingerprint'][:12]} keeper={group['keeper']['id']}")
        for duplicate in group["duplicates"]:
            print(f"    duplicate={duplicate['id']} {duplicate['content_hash'][:10]} {duplicate['snippet']}")
    near = report["nearDuplicateCandidates"]
    print(f"Near duplicate candidates: {near['count']} (review only)")
    for pair in near["samplePairs"]:
        print(f"  {pair['jaccard']:.4f}: {pair['left']['id']} <-> {pair['right']['id']}")
    pairwise = report["pairwiseDuplicateCandidates"]
    print(f"Pairwise duplicate candidates: {pairwise['count']} (review only)")
    for pair in pairwise["samplePairs"]:
        print(f"  {pair['score']:.4f}: {pair['left']['id']} <-> {pair['right']['id']} {pair['metrics']}")


def run_maintenance(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(args.config)
    db = memory_db(config)
    con = sqlite3.connect(db) if args.apply else connect_readonly(db)
    con.row_factory = sqlite3.Row
    try:
        rows = active_rows(con)
        plans: dict[int, dict[str, Any]] = {}
        normalize_errors: list[dict[str, Any]] = []
        for row in rows:
            try:
                plan = row_normalization_plan(row, config, scope=args.scope)
                plans[row["id"]] = plan
            except Exception as exc:
                normalize_errors.append({"id": row["id"], "content_hash": row["content_hash"], "error": str(exc)})

        changed_rows = [row for row in rows if row["id"] in plans and plans[row["id"]]["changed_columns"]]
        if args.apply:
            now = time.time()
            for row in changed_rows:
                apply_normalization(con, row, plans[row["id"]], now)

        duplicate_groups = exact_duplicate_groups(rows, plans, config)
        exact_deleted = 0
        if args.delete_exact:
            if not args.apply:
                raise SystemExit("--delete-exact requires --apply")
            exact_deleted = soft_delete_exact_duplicates(con, duplicate_groups, time.time())

        near_candidates: list[dict[str, Any]] = []
        if args.near:
            near_candidates = near_duplicate_candidates(
                rows,
                threshold=args.near_threshold,
                shingle_size=args.shingle_size,
                permutations=args.minhash_permutations,
                bands=args.lsh_bands,
            )
        pairwise_candidates: list[dict[str, Any]] = []
        if args.pairwise:
            pairwise_candidates = broad_pairwise_candidates(rows, config)

        if args.apply:
            con.commit()

        return build_report(
            rows,
            plans,
            duplicate_groups,
            near_candidates,
            pairwise_candidates,
            args.pairwise,
            normalize_errors,
            applied=args.apply,
            normalization_changes=len(changed_rows),
            exact_deleted=exact_deleted,
            db=db,
        )
    finally:
        con.close()


def self_test() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        db = Path(temp_dir) / "memory.db"
        con = sqlite3.connect(db)
        con.execute(
            """
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  memory_type TEXT,
  metadata TEXT,
  created_at REAL,
  updated_at REAL,
  created_at_iso TEXT,
  updated_at_iso TEXT,
  deleted_at REAL,
  parent_id INTEGER,
  version INTEGER,
  confidence REAL,
  last_accessed REAL,
  superseded_by TEXT
)
"""
        )
        fixtures = [
            (
                "a" * 64,
                "Decision: E:/hooks memory normalizer must backfill old rows. Why: existing rows can predate the hook.",
                "global,untagged",
                "",
                "{}",
                0.5,
            ),
            (
                "b" * 64,
                "Decision: E:/hooks memory normalizer must backfill old rows. Why: existing rows can predate the hook.",
                "decision,all,hooks,memory",
                "decision",
                json.dumps({"memory_normalizer": {"version": "v1", "source_tool": "memory_store"}}),
                0.9,
            ),
            (
                "c" * 64,
                "Decision: E:/hooks memory normalizer should backfill prior rows. Why: existing rows can predate runtime hooks.",
                "decision,all,hooks,memory",
                "decision",
                "{}",
                0.7,
            ),
        ]
        now = time.time()
        for content_hash, content, tags, memory_type, metadata, confidence in fixtures:
            con.execute(
                "INSERT INTO memories (content_hash, content, tags, memory_type, metadata, created_at, confidence) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (content_hash, content, tags, memory_type, metadata, now, confidence),
            )
        con.commit()
        con.close()

        config = {
            "shared": {
                "paths": {"memoryDb": str(db)},
                "projects": [{"slug": "kai", "kind": "rebuild", "repoPath": "E:/kai-ai", "aliases": ["kai-ai"]}],
                "memoryTags": {"crossProjectTag": "all", "legacyRewrite": {"global": "all"}, "retiredTags": ["global", "untagged"]},
                "stopwords": "",
            }
        }
        config_path = Path(temp_dir) / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")

        dry_args = argparse.Namespace(
            config=str(config_path),
            apply=False,
            delete_exact=False,
            near=True,
            near_threshold=0.60,
            shingle_size=4,
            minhash_permutations=64,
            lsh_bands=16,
            scope="needed",
            pairwise=True,
            json=True,
        )
        dry = run_maintenance(dry_args)
        apply_args = argparse.Namespace(**{**vars(dry_args), "apply": True})
        applied = run_maintenance(apply_args)
        delete_args = argparse.Namespace(**{**vars(dry_args), "apply": True, "delete_exact": True})
        deleted = run_maintenance(delete_args)

        check = sqlite3.connect(db)
        try:
            active_count = check.execute(f"SELECT COUNT(*) FROM memories WHERE {ACTIVE_SQL}").fetchone()[0]
            normalized_count = check.execute("SELECT COUNT(*) FROM memories WHERE metadata LIKE '%memory_normalizer%'").fetchone()[0]
        finally:
            check.close()

        errors = []
        if dry["normalization"]["rowsNeedingChange"] < 2:
            errors.append(f"expected at least two rows needing normalization, got {dry['normalization']['rowsNeedingChange']}")
        if dry["exactDuplicates"]["groups"] != 1:
            errors.append(f"expected one exact duplicate group, got {dry['exactDuplicates']['groups']}")
        if not dry["nearDuplicateCandidates"]["count"]:
            errors.append("expected at least one near duplicate candidate")
        if not dry["pairwiseDuplicateCandidates"]["count"]:
            errors.append("expected at least one pairwise duplicate candidate")
        if applied["normalization"]["rowsNeedingChange"] < 2:
            errors.append("apply run did not detect the expected changes before applying")
        if normalized_count != 3:
            errors.append(f"expected all rows normalized, got {normalized_count}")
        if deleted["exactDuplicates"]["deletedRows"] != 1 or active_count != 2:
            errors.append(f"expected one soft-deleted exact duplicate and two active rows, got deleted={deleted['exactDuplicates']['deletedRows']} active={active_count}")

        print(json.dumps({"dry": dry, "applied": applied, "deleted": deleted, "activeCount": active_count, "errors": errors}, indent=2, ensure_ascii=True, sort_keys=True))
        return 1 if errors else 0


def arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Normalize and dedupe existing memories.")
    parser.add_argument("--config", default=CONFIG_PATH)
    parser.add_argument("--apply", action="store_true", help="Apply normalization updates. Dry-run by default.")
    parser.add_argument(
        "--scope",
        choices=["needed", "all"],
        default="needed",
        help="needed backfills missing/invalid normalization only; all fully reconciles tags/type/metadata.",
    )
    parser.add_argument("--delete-exact", action="store_true", help="Soft-delete canonical exact duplicates. Requires --apply.")
    parser.add_argument("--near", action="store_true", help="Report near-duplicate candidates using MinHash/LSH over word shingles.")
    parser.add_argument("--pairwise", action="store_true", help="Run a full active-row pairwise high-overlap review audit.")
    parser.add_argument("--near-threshold", type=float, default=DEFAULT_NEAR_THRESHOLD)
    parser.add_argument("--shingle-size", type=int, default=DEFAULT_SHINGLE_SIZE)
    parser.add_argument("--minhash-permutations", type=int, default=DEFAULT_MINHASH_PERMUTATIONS)
    parser.add_argument("--lsh-bands", type=int, default=DEFAULT_LSH_BANDS)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main() -> int:
    args = arg_parser().parse_args()
    if args.self_test:
        return self_test()
    report = run_maintenance(args)
    print_report(report, json_output=args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
