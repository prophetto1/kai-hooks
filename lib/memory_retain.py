#!/usr/bin/env python
"""Canonical retain-payload normalizer for the local hook memory path.

This module is intentionally pure: callers provide raw content/context and get a
normalized payload back. Database mutation belongs to hook-specific code.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

CONFIG_PATH = os.environ.get("HOOKS_CONFIG_PATH", "E:/hooks/config.json")
MIN_CONTENT_CHARS = 12
TAG_RE = re.compile(r"[^a-z0-9_-]+")
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{2,}")

TYPE_KEYWORDS = {
    "mistake": (
        "wrong:",
        "right:",
        "mistake",
        "error pattern",
        "root cause",
        "failure mode",
        "regression",
    ),
    "decision": (
        "decision",
        "decided",
        "locked",
        "approved",
        "must",
        "do not",
        "canonical",
        "why:",
    ),
    "planning": (
        "plan",
        "phase",
        "roadmap",
        "pending",
        "next step",
        "implementation",
        "acceptance",
        "scope",
    ),
    "reference": (
        "http://",
        "https://",
        "e:/",
        "c:/",
        ".mdx",
        ".py",
        ".mjs",
        "path:",
        "lives at",
        "source of truth",
    ),
}

TOPIC_KEYWORDS = {
    "memory": ("memory", "recall", "retain", "hindsight", "vector", "fts"),
    "hooks": ("hook", "hooks", "telemetry", "posttooluse", "pretooluse", "inject-protocol"),
    "devdocs": ("devdocs", "fumadocs", "docs-site", ".mdx"),
    "governance": ("governance", "contract", "contracts"),
    "auth": ("auth", "better-auth", "login", "session"),
    "frontend": ("frontend", "ui", "design", "css", "layout"),
}

HOOK_SYSTEM_MARKERS = (
    "e:/hooks",
    "hook-system",
    "hook system",
    "inject-protocol",
    "hook-telemetry",
    "loop-safety",
    "governance-gate",
    "quality-completion-gate",
    "memory-normalizer",
    "per-prompt protocol",
    "config.json hook registry",
)


class MemoryQualityError(ValueError):
    """Raised when memory content is too low-quality to retain."""


def load_config(path: str | None = None) -> dict[str, Any]:
    with open(path or CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def utc_stamp(now: float | None = None) -> tuple[float, str]:
    ts = float(time.time() if now is None else now)
    iso = datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return ts, iso


def cleanup_content(content: Any) -> str:
    if content is None:
        raise MemoryQualityError("memory content is empty")
    text = str(content).replace("\r\n", "\n").replace("\r", "\n")
    lines = [" ".join(line.strip().split()) for line in text.split("\n")]
    cleaned = "\n".join(line for line in lines if line).strip()
    if len(cleaned) < MIN_CONTENT_CHARS:
        raise MemoryQualityError(f"memory content is shorter than {MIN_CONTENT_CHARS} characters")
    lowered = cleaned.lower()
    if lowered in {"ok", "okay", "thanks", "thank you", "done", "todo", "note"}:
        raise MemoryQualityError("memory content is too generic")
    return cleaned


def normalize_for_hash(content: str) -> str:
    return " ".join(content.strip().lower().split())


def content_fingerprint(content: str) -> str:
    return hashlib.sha256(normalize_for_hash(content).encode("utf-8")).hexdigest()


def slugify_tag(value: Any) -> str:
    tag = TAG_RE.sub("-", str(value or "").strip().lower()).strip("-")
    return tag[:64]


def parse_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        if raw.startswith("["):
            try:
                decoded = json.loads(raw)
                if isinstance(decoded, list):
                    return parse_tags(decoded)
            except Exception:
                pass
        parts = raw.split(",")
    elif isinstance(value, (list, tuple, set)):
        parts = list(value)
    else:
        parts = [value]
    tags: list[str] = []
    seen = set()
    for item in parts:
        tag = slugify_tag(item)
        if tag and tag not in seen:
            tags.append(tag)
            seen.add(tag)
    return tags


def normalize_tags(tags: Any, config: dict[str, Any] | None = None) -> list[str]:
    cfg = config or load_config()
    memory_tags = cfg.get("shared", {}).get("memoryTags", {})
    rewrite = {slugify_tag(k): slugify_tag(v) for k, v in (memory_tags.get("legacyRewrite") or {}).items()}
    retired = {slugify_tag(item) for item in memory_tags.get("retiredTags", [])}

    normalized: list[str] = []
    seen = set()
    for tag in parse_tags(tags):
        tag = rewrite.get(tag, tag)
        if not tag or tag in retired or tag in seen:
            continue
        normalized.append(tag)
        seen.add(tag)
    return normalized


def tags_to_string(tags: Any, config: dict[str, Any] | None = None) -> str:
    return ",".join(normalize_tags(tags, config))


def detect_project(cwd: str, projects: list[dict[str, Any]]) -> str:
    current = (cwd or "").replace("\\", "/").lower().rstrip("/")
    for project in projects:
        repo_path = (project.get("repoPath") or "").replace("\\", "/").lower().rstrip("/")
        if repo_path and (current == repo_path or current.startswith(repo_path + "/")):
            return project.get("slug", "")
    segments = set(part for part in current.split("/") if part)
    for project in projects:
        tokens = [project.get("slug", "")] + list(project.get("aliases") or [])
        if any(token and token.lower() in segments for token in tokens):
            return project.get("slug", "")
    return ""


def classify_memory_type(content: str) -> tuple[str, str, float]:
    lowered = content.lower()
    if "wrong:" in lowered and "right:" in lowered:
        return "mistake", "deterministic:v1", 0.95
    for memory_type in ("mistake", "decision", "planning", "reference"):
        if any(keyword in lowered for keyword in TYPE_KEYWORDS[memory_type]):
            return memory_type, "deterministic:v1", 0.85
    return "learning", "deterministic:v1", 0.70


def project_slugs(config: dict[str, Any]) -> set[str]:
    return {slugify_tag(project.get("slug")) for project in config.get("shared", {}).get("projects", []) if project.get("slug")}


def stopwords(config: dict[str, Any]) -> set[str]:
    return {word.strip().lower() for word in str(config.get("shared", {}).get("stopwords", "")).split() if word.strip()}


def is_hook_system_memory(content: str, cwd: str = "") -> bool:
    lowered = content.lower()
    cwd_lower = (cwd or "").replace("\\", "/").lower()
    return "e:/hooks" in cwd_lower or any(marker in lowered for marker in HOOK_SYSTEM_MARKERS)


def derive_topic_tags(
    content: str,
    *,
    config: dict[str, Any],
    cwd: str = "",
    project: str = "",
    memory_type: str = "learning",
    max_topics: int = 3,
) -> list[str]:
    lowered = content.lower()
    topics: list[str] = []

    def add(tag: str) -> None:
        tag = slugify_tag(tag)
        if tag and tag not in topics:
            topics.append(tag)

    hook_system = is_hook_system_memory(content, cwd)
    if hook_system:
        add(config.get("shared", {}).get("memoryTags", {}).get("crossProjectTag", "all"))
        add("hooks")
    elif project:
        add(project)

    for candidate in project_slugs(config):
        if not hook_system and not project and candidate and candidate in lowered:
            add(candidate)

    cwd_lower = (cwd or "").replace("\\", "/").lower()
    if "e:/hooks" in cwd_lower or "hook" in lowered:
        add("hooks")

    for tag, keywords in TOPIC_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            add(tag)

    blocked = stopwords(config) | project_slugs(config) | {memory_type, "memory", "memories"}
    for token in WORD_RE.findall(lowered):
        tag = slugify_tag(token)
        if tag and tag not in blocked and len(tag) > 3:
            add(tag)
        if len(topics) >= max_topics:
            break

    return topics[:max_topics]


def build_retain_payload(
    content: Any,
    *,
    config: dict[str, Any] | None = None,
    cwd: str = "",
    source_tool: str = "",
    session_id: str = "",
    metadata: dict[str, Any] | None = None,
    document_id: str = "",
    update_mode: str = "replace",
    now: float | None = None,
) -> dict[str, Any]:
    cfg = config or load_config()
    cleaned = cleanup_content(content)
    ts, iso = utc_stamp(now)
    memory_type, classifier_source, classifier_confidence = classify_memory_type(cleaned)
    project = detect_project(cwd, cfg.get("shared", {}).get("projects", []))
    topics = derive_topic_tags(cleaned, config=cfg, cwd=cwd, project=project, memory_type=memory_type)
    tags = normalize_tags([memory_type, *topics], cfg)
    fingerprint = content_fingerprint(cleaned)
    mode = update_mode if update_mode in {"replace", "append"} else "replace"

    system_metadata = {
        "normalizer": "memory_retain:v1",
        "classifier_source": classifier_source,
        "classifier_confidence": classifier_confidence,
        "content_fingerprint": fingerprint,
        "project": project,
        "cwd": cwd,
        "source_tool": source_tool,
        "session_id": session_id,
    }
    merged_metadata: dict[str, Any] = {}
    if isinstance(metadata, dict):
        merged_metadata.update(metadata)
    merged_metadata.update({k: v for k, v in system_metadata.items() if v not in ("", None)})

    return {
        "content": cleaned,
        "context": {
            "project": project,
            "cwd": cwd,
            "source_tool": source_tool,
            "session_id": session_id,
        },
        "timestamp": ts,
        "created_at": ts,
        "created_at_iso": iso,
        "memory_type": memory_type,
        "tags": tags,
        "metadata": merged_metadata,
        "document_id": str(document_id or ""),
        "content_fingerprint": fingerprint,
        "update_mode": mode,
    }


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Build a canonical local retain payload.")
    parser.add_argument("--content", default="Memory normalizer decision: workers provide only content; hooks derive metadata.")
    parser.add_argument("--cwd", default="")
    parser.add_argument("--source-tool", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    cfg = load_config()
    if args.self_test:
        first = build_retain_payload(args.content, config=cfg, cwd=args.cwd, source_tool=args.source_tool, now=1700000000)
        second = build_retain_payload(args.content, config=cfg, cwd=args.cwd, source_tool=args.source_tool, now=1700000001)
        stable_keys = ("content", "memory_type", "tags", "content_fingerprint", "update_mode")
        if any(first[key] != second[key] for key in stable_keys):
            raise SystemExit("self-test failed: non-timestamp fields drifted")
        if normalize_tags(["global", "memory"], cfg) != ["all", "memory"]:
            raise SystemExit("self-test failed: global did not rewrite to all")
        try:
            build_retain_payload("ok", config=cfg)
        except MemoryQualityError:
            pass
        else:
            raise SystemExit("self-test failed: low-quality content was accepted")
        print(json.dumps({"status": "ok", "payload": first}, ensure_ascii=True, sort_keys=True))
        return 0

    print(json.dumps(build_retain_payload(args.content, config=cfg, cwd=args.cwd, source_tool=args.source_tool), ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
