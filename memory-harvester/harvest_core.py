#!/usr/bin/env python
"""Stop-time memory harvest: transcript -> durable SQLite rows (FTS-backed)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from memory_retain import (  # noqa: E402 — sibling import via harvest-stop sys.path
    MemoryQualityError,
    build_retain_payload,
    tags_to_string,
)

ACTIVE_SQL = "deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')"
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
TERM_RE = re.compile(r"[A-Za-z0-9_-]{3,}")
HARVEST_SIGNALS = (
    "decision",
    "why:",
    "wrong:",
    "right:",
    " must ",
    " do not ",
    " don't ",
    " never ",
    " always ",
    " locked ",
    " canonical ",
    " path:",
    " e:/",
    " http://",
    " https://",
    " mistake",
    " correction",
    " going forward",
    " from now",
    " remember ",
    " established ",
    " agreed ",
    " will use ",
    " primary ",
    " fallback ",
)


def utc_iso(ts: float | None = None) -> str:
    stamp = time.time() if ts is None else ts
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_text_tail(path: str, max_bytes: int) -> str:
    normalized = Path(path)
    if not normalized.is_file():
        return ""
    size = normalized.stat().st_size
    if size <= 0:
        return ""
    length = min(size, max_bytes)
    with normalized.open("rb") as handle:
        handle.seek(size - length)
        return handle.read(length).decode("utf-8", errors="replace")


def text_from_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(text_from_content(item.get("text") or item.get("content") or item.get("value")))
        return " ".join(part for part in parts if part)
    if isinstance(value, dict):
        return text_from_content(value.get("content") or value.get("text") or value.get("value") or value.get("message"))
    return "" if value is None else str(value)


def message_role_and_text(row: dict[str, Any]) -> tuple[str, str]:
    """Extract role/text from hook transcript rows or Codex response_item rows."""
    payload = row.get("payload")
    if row.get("type") == "response_item" and isinstance(payload, dict):
        if payload.get("type") != "message":
            return "", ""
        return str(payload.get("role") or ""), text_from_content(payload).strip()

    role = row.get("type") or row.get("role")
    if role is None and isinstance(row.get("message"), dict):
        role = row["message"].get("role")
    text_source = row.get("message") if isinstance(row.get("message"), dict) else row
    return str(role or ""), text_from_content(text_source).strip()


def parse_transcript_lines(raw: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            row = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        role, text = message_role_and_text(row)
        if not text:
            continue
        messages.append({"role": role, "text": text})
    return messages


def recent_exchanges(messages: list[dict[str, Any]], max_exchanges: int) -> list[tuple[str, str]]:
    """Return newest-first (user_text, assistant_text) pairs."""
    exchanges: list[tuple[str, str]] = []
    index = len(messages) - 1
    while index >= 0 and len(exchanges) < max_exchanges:
        assistant = messages[index]
        if assistant["role"] not in ("assistant", "agent"):
            index -= 1
            continue
        user_text = ""
        scan = index - 1
        while scan >= 0:
            prior = messages[scan]
            if prior["role"] in ("user", "human"):
                user_text = prior["text"]
                break
            if prior["role"] in ("assistant", "agent"):
                break
            scan -= 1
        exchanges.append((user_text, assistant["text"]))
        index = scan - 1 if scan >= 0 else index - 1
    return exchanges


def exchange_count(messages: list[dict[str, Any]]) -> int:
    count = 0
    in_assistant_cluster = False
    for message in messages:
        role = message["role"]
        if role in ("assistant", "agent"):
            if not in_assistant_cluster:
                count += 1
            in_assistant_cluster = True
        elif role in ("user", "human"):
            in_assistant_cluster = False
    return count


def count_transcript_exchanges(transcript_path: str) -> int:
    """Count assistant exchange clusters from the full transcript without storing text."""
    path = Path(transcript_path)
    if not path.is_file():
        return 0
    count = 0
    in_assistant_cluster = False
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            role, text = message_role_and_text(row)
            if not text:
                continue
            if role in ("assistant", "agent"):
                if not in_assistant_cluster:
                    count += 1
                in_assistant_cluster = True
            elif role in ("user", "human"):
                in_assistant_cluster = False
    return count


def clip(text: str, limit: int) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rsplit(" ", 1)[0] + "..."


def clamp_confidence(value: Any, default: float = 0.85) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        score = default
    return max(0.0, min(1.0, score))


def int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def sentence_has_signal(text: str) -> bool:
    lowered = text.lower()
    return any(signal in lowered for signal in HARVEST_SIGNALS)


def harvest_sentences(text: str, *, max_sentences: int) -> list[str]:
    candidates: list[str] = []
    for chunk in re.split(r"\n{2,}", text):
        chunk = " ".join(chunk.split())
        if not chunk:
            continue
        if sentence_has_signal(chunk):
            candidates.append(chunk)
            continue
        for sentence in SENTENCE_SPLIT_RE.split(chunk):
            sentence = sentence.strip()
            if len(sentence) < 40:
                continue
            if sentence_has_signal(sentence):
                candidates.append(sentence)
            if len(candidates) >= max_sentences:
                break
        if len(candidates) >= max_sentences:
            break
    return candidates[:max_sentences]


def exchange_digest(user_text: str, assistant_text: str, *, project: str) -> str | None:
    assistant = clip(assistant_text, 1800)
    user = clip(user_text, 400)
    if len(assistant) < 80:
        return None
    if not sentence_has_signal(assistant) and not sentence_has_signal(user):
        return None
    prefix = f"Session harvest ({project or 'all'})"
    if user:
        return f"{prefix}\nUser: {user}\nOutcome: {assistant}"
    return f"{prefix}\nOutcome: {assistant}"


def candidates_from_exchange(user_text: str, assistant_text: str, *, project: str, settings: dict[str, Any]) -> list[str]:
    max_sentences = int(settings.get("maxSentencesPerExchange", 2))
    results: list[str] = []
    seen: set[str] = set()

    def add(candidate: str) -> None:
        normalized = " ".join(candidate.split())
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        results.append(normalized)

    for sentence in harvest_sentences(assistant_text, max_sentences=max_sentences):
        add(sentence)

    digest = exchange_digest(user_text, assistant_text, project=project)
    if digest and not results:
        add(digest)

    min_chars = int(settings.get("minAssistantChars", 80))
    if not results and len(assistant_text.strip()) >= min_chars and sentence_has_signal(user_text):
        add(exchange_digest(user_text, assistant_text, project=project) or "")

    return [item for item in results if item]


def transcript_fingerprint(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def session_state_path(state_dir: str, session_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", session_id or "anonymous")[:120]
    return Path(state_dir) / f"{safe}.json"


def load_session_state(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_session_state(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def connect_memory(db_path: str) -> sqlite3.Connection:
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=5.0)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    return con


def existing_memory_settings(settings: dict[str, Any]) -> dict[str, Any]:
    raw = settings.get("existingMemoryContext")
    if not isinstance(raw, dict):
        return {"enabled": False}
    merged = dict(raw)
    merged.setdefault("enabled", True)
    merged.setdefault("max", 8)
    merged.setdefault("snippetChars", 600)
    merged.setdefault("minTerms", 2)
    return merged


def context_terms(exchanges: list[tuple[str, str]], *, config: dict[str, Any], limit: int = 12) -> list[str]:
    stopwords = set(str(config.get("shared", {}).get("stopwords") or "").lower().split())
    seen: set[str] = set()
    terms: list[str] = []
    text = " ".join(part for exchange in exchanges for part in exchange)
    for match in TERM_RE.finditer(text.lower()):
        term = match.group(0).strip("_-")
        if not term or term in stopwords or term in seen:
            continue
        seen.add(term)
        terms.append(term)
        if len(terms) >= limit:
            break
    return terms


def quote_fts_term(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def project_filter_sql(project: str, cross_project_tag: str) -> tuple[str, list[str]]:
    if not project:
        return "", []
    return "AND (','||coalesce(m.tags,'')||',' LIKE ? OR ','||coalesce(m.tags,'')||',' LIKE ?) ", [
        f"%,{project},%",
        f"%,{cross_project_tag},%",
    ]


def load_existing_memory_context(
    exchanges: list[tuple[str, str]],
    *,
    config: dict[str, Any],
    settings: dict[str, Any],
    project: str,
) -> list[dict[str, Any]]:
    ctx = existing_memory_settings(settings)
    if ctx.get("enabled") is False:
        return []

    terms = context_terms(exchanges, config=config)
    min_terms = int(ctx.get("minTerms", 2))
    if len(terms) < min_terms:
        return []

    db_path = config.get("shared", {}).get("paths", {}).get("memoryDb", "E:/_memory/memory-sqlite.db")
    if not Path(db_path).is_file():
        return []

    max_rows = int(ctx.get("max", 8))
    snippet_chars = int(ctx.get("snippetChars", 600))
    cross_tag = config.get("shared", {}).get("memoryTags", {}).get("crossProjectTag", "all")
    scope_sql, scope_params = project_filter_sql(project, cross_tag)
    match_query = " OR ".join(quote_fts_term(term) for term in terms)
    rows: list[dict[str, Any]] = []

    con = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True, timeout=5.0)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        sql = (
            "SELECT m.id, m.content, m.tags, m.memory_type, m.created_at_iso, m.confidence, rank "
            "FROM memory_content_fts f JOIN memories m ON m.id=f.rowid "
            f"WHERE f.memory_content_fts MATCH ? AND {ACTIVE_SQL} "
            f"{scope_sql}"
            "ORDER BY rank LIMIT ?"
        )
        params: list[Any] = [match_query, *scope_params, max_rows]
        for row in con.execute(sql, params).fetchall():
            rows.append(
                {
                    "id": int(row[0]),
                    "content": clip(str(row[1] or ""), snippet_chars),
                    "tags": str(row[2] or ""),
                    "memory_type": str(row[3] or ""),
                    "created_at_iso": str(row[4] or ""),
                    "confidence": row[5],
                }
            )
    except sqlite3.Error:
        return []
    finally:
        con.close()
    return rows


def insert_memory(
    con: sqlite3.Connection,
    retain: dict[str, Any],
    *,
    config: dict[str, Any],
    session_id: str,
) -> dict[str, Any]:
    content_hash = retain["content_fingerprint"]
    existing = con.execute(
        f"SELECT id FROM memories WHERE content_hash = ? AND {ACTIVE_SQL}",
        (content_hash,),
    ).fetchone()
    if existing:
        return {"decision": "skip", "reason": "duplicate", "memoryId": existing[0], "contentHash": content_hash}

    metadata = dict(retain.get("metadata") or {})
    harvester_meta = {
        "version": "v1",
        "session_id": session_id,
        "harvested_at": utc_iso(),
    }
    for key in ("operation", "reason", "evidence", "supersedes_id"):
        if retain.get(key) not in (None, ""):
            harvester_meta[key] = retain[key]
    metadata["memory_harvester"] = harvester_meta
    now = float(retain.get("created_at") or time.time())
    tags = tags_to_string(retain["tags"], config)
    cur = con.execute(
        """
        INSERT INTO memories (
            content_hash, content, tags, memory_type, metadata,
            created_at, updated_at, created_at_iso, updated_at_iso, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            content_hash,
            retain["content"],
            tags,
            retain["memory_type"],
            json.dumps(metadata, ensure_ascii=True, sort_keys=True),
            now,
            now,
            retain.get("created_at_iso") or utc_iso(now),
            retain.get("created_at_iso") or utc_iso(now),
            clamp_confidence(retain.get("confidence"), 0.85),
        ),
    )
    row_id = cur.lastrowid
    con.execute("INSERT INTO memory_content_fts(rowid, content) VALUES (?, ?)", (row_id, retain["content"]))
    return {"decision": "stored", "memoryId": row_id, "contentHash": content_hash, "memoryType": retain["memory_type"], "tags": tags}


def extraction_settings(settings: dict[str, Any]) -> dict[str, Any]:
    extraction = settings.get("extraction")
    if isinstance(extraction, dict):
        return extraction
    # Legacy flat settings before extraction block existed.
    return {
        "mode": "heuristic",
        "fallbackMode": "none",
        "heuristic": {
            "maxSentencesPerExchange": settings.get("maxSentencesPerExchange", 2),
            "minAssistantChars": settings.get("minAssistantChars", 80),
        },
    }


def heuristic_settings(settings: dict[str, Any]) -> dict[str, Any]:
    extraction = extraction_settings(settings)
    heuristic = extraction.get("heuristic")
    if isinstance(heuristic, dict):
        merged = dict(heuristic)
    else:
        merged = {}
    merged.setdefault("maxSentencesPerExchange", settings.get("maxSentencesPerExchange", 2))
    merged.setdefault("minAssistantChars", settings.get("minAssistantChars", 80))
    return merged


def collect_heuristic_candidates(
    exchanges: list[tuple[str, str]],
    *,
    project: str,
    settings: dict[str, Any],
    max_candidates: int,
) -> list[str]:
    heuristic = heuristic_settings(settings)
    candidate_texts: list[str] = []
    seen_candidates: set[str] = set()
    for user_text, assistant_text in exchanges:
        for candidate in candidates_from_exchange(user_text, assistant_text, project=project, settings=heuristic):
            normalized = " ".join(candidate.split())
            if not normalized or normalized in seen_candidates:
                continue
            seen_candidates.add(normalized)
            candidate_texts.append(candidate)
        if len(candidate_texts) >= max_candidates:
            break
    return candidate_texts[:max_candidates]


def collect_extraction_candidates(
    exchanges: list[tuple[str, str]],
    *,
    settings: dict[str, Any],
    project: str,
    cwd: str,
    session_id: str,
    existing_memories: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    extraction = extraction_settings(settings)
    mode = str(extraction.get("mode") or "heuristic").lower()
    max_candidates = int(settings.get("maxCandidatesPerStop", 6))
    meta: dict[str, Any] = {"extractionMode": mode}

    if mode == "llm":
        llm = extraction.get("llm")
        if not isinstance(llm, dict) or llm.get("enabled") is False:
            mode = "heuristic"
            meta["extractionMode"] = "heuristic"
            meta["llmSkipReason"] = "llm disabled in config"
        else:
            from harvest_llm import extract_candidates_llm  # noqa: WPS433

            try:
                llm_result = extract_candidates_llm(
                    exchanges,
                    llm=llm,
                    project=project,
                    cwd=cwd,
                    session_id=session_id,
                    existing_memories=existing_memories or [],
                )
                meta.update(
                    {
                        "llmModel": llm_result.get("model"),
                        "llmUsage": llm_result.get("usage") or {},
                        "llmRawPreview": llm_result.get("rawPreview"),
                        "proxyEnsure": llm_result.get("proxyEnsure"),
                    }
                )
                return llm_result.get("candidates") or [], meta
            except Exception as exc:
                meta["llmError"] = str(exc)
                fallback = str(extraction.get("fallbackMode") or "none").lower()
                if fallback != "heuristic":
                    raise
                meta["extractionMode"] = "heuristic-fallback"
                meta["fallbackReason"] = str(exc)

    heuristic_rows = [
        {"operation": "insert", "content": text}
        for text in collect_heuristic_candidates(
            exchanges,
            project=project,
            settings=settings,
            max_candidates=max_candidates,
        )
    ]
    return heuristic_rows, meta


def normalize_candidate_operation(row: dict[str, Any]) -> str:
    operation = str(row.get("operation") or row.get("action") or "insert").strip().lower()
    aliases = {
        "store": "insert",
        "new": "insert",
        "update": "supersede",
        "contradiction": "supersede",
        "drop": "skip",
    }
    return aliases.get(operation, operation)


def mark_superseded(con: sqlite3.Connection, *, old_id: int, new_id: int) -> bool:
    now = time.time()
    cur = con.execute(
        f"UPDATE memories SET superseded_by = ?, updated_at = ?, updated_at_iso = ? WHERE id = ? AND {ACTIVE_SQL}",
        (str(new_id), now, utc_iso(now), old_id),
    )
    return cur.rowcount > 0


def store_candidates(
    candidate_rows: list[dict[str, Any]],
    *,
    config: dict[str, Any],
    cwd: str,
    session_id: str,
    extraction_meta: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[tuple[dict[str, Any], dict[str, Any]]]]:
    db_path = config.get("shared", {}).get("paths", {}).get("memoryDb", "E:/_memory/memory-sqlite.db")
    stored_rows: list[dict[str, Any]] = []
    skipped_rows: list[dict[str, Any]] = []
    rejected_rows: list[dict[str, Any]] = []
    stored_pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []

    source_tool = "memory-harvester"
    if extraction_meta.get("llmModel"):
        source_tool = "memory-harvester-llm"

    con = connect_memory(db_path)
    try:
        for row in candidate_rows:
            operation = normalize_candidate_operation(row)
            if operation == "skip":
                skipped_rows.append(
                    {
                        "decision": "skip",
                        "operation": "skip",
                        "reason": str(row.get("reason") or "llm_skip"),
                    }
                )
                continue
            content = str(row.get("content") or "").strip()
            if not content:
                skipped_rows.append({"decision": "skip", "operation": operation, "reason": "empty_content"})
                continue
            supersedes_id = int_or_none(row.get("supersedes_id") or row.get("supersedesId"))
            if operation == "supersede" and supersedes_id is None:
                rejected_rows.append({"contentPreview": clip(content, 120), "reason": "missing_supersedes_id"})
                continue
            metadata = {
                "harvest_source": "stop-hook",
                "extraction_mode": extraction_meta.get("extractionMode"),
            }
            if extraction_meta.get("llmModel"):
                metadata["llm_model"] = extraction_meta.get("llmModel")
            try:
                retain = build_retain_payload(
                    content,
                    config=config,
                    cwd=cwd,
                    source_tool=source_tool,
                    session_id=session_id,
                    metadata=metadata,
                )
                if row.get("memory_type"):
                    retain["memory_type"] = str(row["memory_type"])
                retain["operation"] = operation
                if row.get("reason"):
                    retain["reason"] = str(row["reason"])
                if row.get("evidence"):
                    retain["evidence"] = str(row["evidence"])
                if supersedes_id is not None:
                    retain["supersedes_id"] = supersedes_id
                if row.get("confidence") is not None:
                    retain["confidence"] = clamp_confidence(row.get("confidence"))
            except MemoryQualityError as exc:
                rejected_rows.append({"contentPreview": clip(content, 120), "reason": str(exc)})
                continue
            outcome = insert_memory(con, retain, config=config, session_id=session_id)
            if outcome["decision"] == "stored":
                outcome["operation"] = operation
                if supersedes_id is not None:
                    if mark_superseded(con, old_id=supersedes_id, new_id=int(outcome["memoryId"])):
                        outcome["supersededMemoryId"] = supersedes_id
                    else:
                        outcome["supersedeWarning"] = "target_not_active"
                stored_rows.append(outcome)
                stored_pairs.append((outcome, retain))
            else:
                skipped_rows.append(outcome)
        if stored_rows:
            con.commit()
    finally:
        con.close()
    return stored_rows, skipped_rows, rejected_rows, stored_pairs


def harvest_session(
    payload: dict[str, Any],
    config: dict[str, Any],
    settings: dict[str, Any],
    *,
    cwd: str,
    project: str,
) -> dict[str, Any]:
    transcript_path = str(payload.get("transcript_path") or payload.get("transcriptPath") or "")
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "")
    if not transcript_path:
        return {"decision": "skip", "reason": "no_transcript_path"}

    tail_bytes = int(settings.get("transcriptTailBytes", 262144))
    raw = read_text_tail(transcript_path, tail_bytes)
    if not raw.strip():
        return {"decision": "skip", "reason": "empty_transcript"}

    fingerprint = transcript_fingerprint(raw)
    state_dir = settings.get("stateDir") or ".state/memory-harvester"
    if not os.path.isabs(state_dir):
        state_dir = str(Path(config.get("shared", {}).get("paths", {}).get("hooksDir", "E:/hooks")) / state_dir)
    state_path = session_state_path(state_dir, session_id)
    prior = load_session_state(state_path)
    if prior.get("transcriptFingerprint") == fingerprint and prior.get("completed") is True:
        return {
            "decision": "skip",
            "reason": "already_harvested",
            "sessionId": session_id,
            "stored": prior.get("stored", 0),
            "skipped": prior.get("skipped", 0),
        }

    messages = parse_transcript_lines(raw)
    visible_exchange_count = exchange_count(messages)
    total_exchanges = count_transcript_exchanges(transcript_path) or visible_exchange_count
    review_last_exchanges = int(settings.get("reviewLastExchanges", 4))
    exchanges = recent_exchanges(messages, review_last_exchanges)
    if not exchanges:
        return {"decision": "skip", "reason": "no_assistant_exchanges", "messageCount": len(messages)}

    run_after_new_exchanges = int(settings.get("runAfterNewExchanges", 1))
    prior_exchange_count = int(prior.get("lastHarvestExchangeCount") or 0)
    exchanges_since_harvest = total_exchanges - prior_exchange_count
    if exchanges_since_harvest < 0:
        # Transcript rollover/truncation/reset: count from the visible tail.
        exchanges_since_harvest = total_exchanges
    if run_after_new_exchanges > 1 and exchanges_since_harvest < run_after_new_exchanges:
        return {
            "decision": "skip",
            "reason": "harvest_interval_not_reached",
            "sessionId": session_id,
            "exchangeCount": total_exchanges,
            "visibleExchangeCount": visible_exchange_count,
            "lastHarvestExchangeCount": prior_exchange_count,
            "newExchangesSinceHarvest": exchanges_since_harvest,
            "runAfterNewExchanges": run_after_new_exchanges,
            "reviewLastExchanges": review_last_exchanges,
            "transcriptFingerprint": fingerprint,
        }

    max_candidates = int(settings.get("maxCandidatesPerStop", 6))
    try:
        existing_memories = load_existing_memory_context(
            exchanges,
            config=config,
            settings=settings,
            project=project,
        )
        candidate_rows, extraction_meta = collect_extraction_candidates(
            exchanges,
            settings=settings,
            project=project,
            cwd=cwd,
            session_id=session_id,
            existing_memories=existing_memories,
        )
        if existing_memories:
            extraction_meta["existingMemoryContext"] = {"count": len(existing_memories)}
    except Exception as exc:
        return {
            "decision": "skip",
            "reason": "llm_failed",
            "error": str(exc),
            "sessionId": session_id,
            "project": project,
        }

    stored_rows, skipped_rows, rejected_rows, stored_pairs = store_candidates(
        candidate_rows[:max_candidates],
        config=config,
        cwd=cwd,
        session_id=session_id,
        extraction_meta=extraction_meta,
    )

    hindsight_rows: list[dict[str, Any]] = []
    hindsight_meta: dict[str, Any] = {"enabled": False}
    try:
        from harvest_hindsight import resolve_hindsight_settings, sync_stored_rows  # noqa: WPS433

        hindsight_settings = resolve_hindsight_settings(config, settings)
        if hindsight_settings and stored_pairs:
            hindsight_meta = {"enabled": True, "endpoint": hindsight_settings["endpoint"]}
            hindsight_rows = sync_stored_rows(
                stored_pairs,
                hindsight_settings=hindsight_settings,
                session_id=session_id,
            )
    except Exception as exc:
        hindsight_meta = {"enabled": True, "error": str(exc)}
        hindsight_rows = []

    hindsight_synced = sum(1 for row in hindsight_rows if row.get("decision") in ("synced", "queued"))
    hindsight_errors = sum(1 for row in hindsight_rows if row.get("decision") == "error")

    result = {
        "decision": "harvested" if stored_rows else "noop",
        "sessionId": session_id,
        "project": project,
        "exchangesScanned": len(exchanges),
        "exchangeCount": total_exchanges,
        "visibleExchangeCount": visible_exchange_count,
        "lastHarvestExchangeCount": prior_exchange_count,
        "newExchangesSinceHarvest": exchanges_since_harvest,
        "runAfterNewExchanges": run_after_new_exchanges,
        "reviewLastExchanges": review_last_exchanges,
        "candidates": len(candidate_rows[:max_candidates]),
        "stored": len(stored_rows),
        "skipped": len(skipped_rows),
        "rejected": len(rejected_rows),
        "storedRows": stored_rows,
        "hindsight": {
            **hindsight_meta,
            "synced": hindsight_synced,
            "errors": hindsight_errors,
            "rows": hindsight_rows,
        },
        "transcriptFingerprint": fingerprint,
        **extraction_meta,
    }
    save_session_state(
        state_path,
        {
            "sessionId": session_id,
            "transcriptFingerprint": fingerprint,
            "completed": True,
            "harvestedAt": utc_iso(),
            "lastHarvestExchangeCount": total_exchanges,
            **{key: result[key] for key in ("stored", "skipped", "rejected", "candidates", "project")},
        },
    )
    return result
