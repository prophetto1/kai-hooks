# Two-Tier Hook Telemetry Implementation Plan

**Goal:** Replace synchronous broad telemetry logging with a two-tier path: direct synchronous SQLite logging for safety-critical telemetry, fast queue writes for successful ordinary tool telemetry, and bounded batch queue draining outside the `PostToolUse` hot path.

**Architecture:** Keep `hook_events` in `E:/hooks/_db/hooks.db` as the durable system of record for `thinking-gate` and `loop-safety`. Split `hook-telemetry` into a direct durable store (`log-event.py`), a hot-path telemetry router (`queue-event.py`), and a bounded drain worker (`drain-events.py`) that writes queued success events into the same `hook_events` schema. The live Codex TOML wires sequential-thinking `PostToolUse` to `log-event.py`, broad `PostToolUse` / `PostToolUseFailure` to `queue-event.py`, and `Stop` to `drain-events.py`; `queue-event.py` must synchronously persist any failure-class event before returning so `loop-safety` can see retry-loop failures in the same turn.

**Tech Stack:** Python 3.11 hooks, SQLite, Node ESM config validator/tests, `config.json`, `C:/Users/jwchu/.codex/config.toml`, existing quality-completion-gate manifest.

**Status:** Draft
**Author:** Codex plan for Jon
**Date:** 2026-06-06

## Options Considered

1. **Minimal broad synchronous logging**
   - Summary: Keep `log-event.py` as the broad `PostToolUse` hook.
   - Effort: Low.
   - Risk: Reintroduces visible hook stalls because every tool pays SQLite open/schema/insert/commit cost.
   - Builds on: Current temporary broad matcher.
   - Verdict: Reject for long-term use.

2. **Recommended: direct safety logging plus queued successful ordinary telemetry**
   - Summary: Keep sequential-thinking grants and failure-class tool events synchronous, queue successful ordinary tool events, and drain queued successes on `Stop`.
   - Effort: Medium.
   - Risk: Successful queued events are not durable until drain, but loop-safety-critical failures remain visible immediately.
   - Builds on: Existing `hook_events` schema, `hook_runtime.py`, `log-event.py`, and Stop hook.
   - Verdict: Adopt.

3. **Queue everything and inline-drain before `thinking-gate`**
   - Summary: Put sequential-thinking in the queue too and try to drain immediately before the next gated tool.
   - Effort: Medium-high.
   - Risk: Racy grant visibility and more moving parts in `PreToolUse`.
   - Builds on: Queue path plus `thinking-gate`.
   - Verdict: Reject until `thinking-gate` no longer depends on `hook_events`.

## Manifest

### Platform API

No platform API endpoints are added, modified, or consumed.

The owned runtime seam is the local hook command surface, not a FastAPI service.

### Observability

| Type | Name | Where | Purpose |
|------|------|-------|---------|
| Durable event row | `hook_events` | `hook-telemetry/store.py:write_payload` / `write_payloads` | Preserve the existing durable telemetry row shape consumed by `thinking-gate` and `loop-safety` |
| Queue file | `telemetry queue event` | `hook-telemetry/queue-event.py:write_queued_event` | Record successful ordinary tool telemetry with minimal hot-path work |
| Drain summary | `telemetry drain summary` | `hook-telemetry/drain-events.py:main` | Report processed, failed, remaining, and elapsed drain state |

Allowed attributes in queue records and durable rows: `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input` collapsed target, structural status, bounded error detail, queue timestamp, process id. Oversized payload handling must trim bulky fields while preserving `hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, and structural error signals.

Forbidden behavior: telemetry must not become quality proof; telemetry drain failures must not block Stop completion; queue files must not store secrets beyond what the hook payload already contains; oversized payload handling must not replace real tool identity with synthetic tool names; malformed stdin must not become a `hook_events` row; no trace or metric service is added.

### Database Migrations

No database migrations are added.

The existing SQLite `hook_events` table remains the system of record. The schema is preserved exactly.

### Edge Functions

No edge functions are created or modified.

### Frontend Surface Area

No frontend pages, components, hooks, services, or routes are added or modified.

## Pre-Implementation Contract

No major runtime, queue, durability, config, or live-wire decision may be improvised during implementation. If any item below needs to change, stop and revise this plan before writing implementation code.

## Locked Product Decisions

1. `hook_events` remains the durable telemetry table.
2. `log-event.py` remains the synchronous compatibility path for sequential-thinking grant events.
3. `queue-event.py` is the broad hot-path `PostToolUse` / `PostToolUseFailure` command.
4. `queue-event.py` explicitly skips direct grant tools so sequential-thinking is not recorded twice.
5. `queue-event.py` synchronously writes failure-class events (`PostToolUseFailure` and structurally failed `PostToolUse`) to `hook_events` before returning.
6. Queue drain happens outside `PostToolUse`, through a bounded `Stop` hook command, and writes queued events in one DB connection per drain batch.
7. Telemetry remains fail-open; successful ordinary telemetry is non-authoritative, but failure telemetry is authoritative input for `loop-safety`.
8. This plan does not change `thinking-gate` policy, `loop-safety` thresholds, or quality-gate authority.

## Locked Acceptance Contract

The implementation is complete only when all of the following are true:

1. A successful `Bash` `PostToolUse` payload written through `queue-event.py` creates one queue file and does not open or create the SQLite hooks DB.
2. A sequential-thinking `PostToolUse` payload written through `log-event.py` creates a same-session `hook_events` row synchronously.
3. The same sequential-thinking payload sent to `queue-event.py` creates no queue file because it is a direct grant tool.
4. A `Bash` `PostToolUseFailure` payload sent to `queue-event.py` creates a synchronous `hook_events` row and creates no queue file.
5. A `Bash` `PostToolUse` payload whose response envelope has `exit_code: 1` creates a synchronous `hook_events` row and creates no queue file.
6. `loop-safety` can read same-session Bash failures from `hook_events` before any `Stop` drain runs.
7. Oversized payload handling preserves real tool identity and structural status while trimming bulky fields.
8. Malformed stdin is fail-open and reported on stderr; it creates no queue file and no `hook_events` row.
9. `drain-events.py --max-events 1` drains at most one queued event and leaves the rest for a later drain.
10. `drain-events.py --max-ms <n>` stops within the budget check between events.
11. A stale `*.draining` file is recovered and drained or safely moved to bad-events.
12. Invalid queue records are moved to `bad-events` and do not stop the drain.
13. Drained rows preserve the existing `hook_events` columns and structural status classification.
14. The live TOML has separate direct, broad queue, and Stop drain hooks.

## Locked Observability Surface

### Durable rows

No columns are added or removed from `hook_events`.

### Queue records

Each queued event file is a single JSON object:

```json
{
  "schemaVersion": 1,
  "queuedAt": 1760000000.123,
  "pid": 1234,
  "payload": {}
}
```

### Drain output

`drain-events.py` prints one JSON object:

```json
{
  "ok": true,
  "processed": 0,
  "failed": 0,
  "recovered": 0,
  "remaining": 0,
  "elapsedMs": 0
}
```

## Locked Inventory Counts

### New files: `5`

1. `hook-telemetry/store.py`
2. `hook-telemetry/queue-event.py`
3. `hook-telemetry/drain-events.py`
4. `hook-telemetry/test-queue-event.py`
5. `hook-telemetry/test-drain-events.py`

### Modified repo files: `5`

1. `hook-telemetry/log-event.py`
2. `config.json`
3. `_core/config-model.mjs`
4. `quality-completion-gate/test-config-model.mjs`
5. `quality-completion-gate/quality-verify-manifest.json`

### Modified live config files outside repo: `1`

1. `C:/Users/jwchu/.codex/config.toml`

### Generated files: `0`

`config.schema.json` is not expected to change because the JSON Schema remains generic for non-inject hook settings. The semantic validator carries the new queue invariants.

## Locked File Inventory

### New files

- `hook-telemetry/store.py`
- `hook-telemetry/queue-event.py`
- `hook-telemetry/drain-events.py`
- `hook-telemetry/test-queue-event.py`
- `hook-telemetry/test-drain-events.py`

### Modified files

- `hook-telemetry/log-event.py`
- `config.json`
- `_core/config-model.mjs`
- `quality-completion-gate/test-config-model.mjs`
- `quality-completion-gate/quality-verify-manifest.json`
- `C:/Users/jwchu/.codex/config.toml`

## Frozen Thinking-Gate And Loop-Safety Seam Contract

`thinking-gate` currently reads successful sequential-thinking rows from `hook_events` and consumes them by row id. The queue path must not delay, duplicate, or renew those grant rows. `loop-safety` currently runs at `PreToolUse` and reads same-session failure rows from `hook_events` before a retry proceeds. Therefore:

- Sequential-thinking tools stay on `log-event.py`.
- `queue-event.py` skips the configured direct tools.
- Failure-class ordinary tool telemetry stays synchronous inside `queue-event.py` by calling `store.write_payload`.
- Only successful ordinary tool telemetry is queued.
- The broad queue matcher can still be `.*` because the queue script performs the direct-tool skip.
- Do not queue sequential-thinking until `thinking-gate` is moved away from `hook_events` or a separate approved plan proves same-event grant durability.
- Do not queue failures until `loop-safety` is moved away from same-turn `hook_events` reads or a separate approved plan proves pre-retry failure visibility.

## Explicit Risks Accepted In This Plan

1. Successful ordinary queued telemetry can lag until Stop. This is accepted because successful ordinary telemetry is non-authoritative.
2. If a session ends before Stop runs, queue files remain on disk until the next drain. This is accepted because the drain is idempotent and bounded.
3. The live TOML remains outside the repo. The implementation must verify it directly after editing.
4. `PostToolUseFailure` remains supported and wired, but some runtimes may only emit structurally failed `PostToolUse` payloads.
5. Failure-class telemetry keeps a synchronous SQLite write cost. This is accepted because failures are rare and are load-bearing for `loop-safety`.

## Completion Criteria

1. All new files match the full code below.
2. All existing-file diffs below are applied.
3. `python hook-telemetry/test-queue-event.py` passes.
4. `python hook-telemetry/test-drain-events.py` passes.
5. `node quality-completion-gate/test-config-model.mjs` passes.
6. `node _core/validate-runtime-hooks.mjs` passes.
7. The full hooks runtime manifest passes for the touched repo.
8. A live-style sandbox probe proves successful `Bash` queues, sequential-thinking logs synchronously, failed `Bash` writes synchronously, `loop-safety` can see the failure before Stop, and queued successes drain into `hook_events`.

## Complete New File Code

### `hook-telemetry/store.py`

```python
#!/usr/bin/env python
"""Shared durable store for hook telemetry.

This module preserves the existing hook_events schema while allowing different
entrypoints to choose their hot-path behavior:

- log-event.py writes directly for grant-critical telemetry.
- drain-events.py writes queued successful ordinary telemetry later.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_core"))

from hook_runtime import connect, detect_project, extract_target, hooks_db, safe_table  # noqa: E402

SCHEMA_VERSION = 1
DEFAULT_MAX_EVENT_BYTES = 131_072


class InvalidTelemetryPayload(ValueError):
    """Raised when stdin cannot be treated as hook telemetry."""


def resolve_path(config: dict[str, Any], value: str | None, default_relative: str) -> Path:
    hooks_dir = Path(config.get("shared", {}).get("paths", {}).get("hooksDir", str(ROOT)))
    raw = Path(value or default_relative)
    return raw if raw.is_absolute() else hooks_dir / raw


def queue_settings(hcfg: dict[str, Any]) -> dict[str, Any]:
    settings = hcfg.get("settings", {})
    queue = settings.get("queue", {})
    return queue if isinstance(queue, dict) else {}


def max_event_bytes(hcfg: dict[str, Any]) -> int:
    value = queue_settings(hcfg).get("maxEventBytes", DEFAULT_MAX_EVENT_BYTES)
    try:
        parsed = int(value)
    except Exception:
        return DEFAULT_MAX_EVENT_BYTES
    return parsed if parsed > 0 else DEFAULT_MAX_EVENT_BYTES


def ddl_for(table: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  ts_iso TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  hook_id TEXT,
  event TEXT,
  tool_name TEXT,
  target TEXT,
  decision TEXT,
  status TEXT,
  duration_ms INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_{table}_session_ts ON {table}(session_id, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {table}(ts);
"""


def ensure_schema(con, table: str) -> None:
    con.executescript(ddl_for(table))
    for index_name in (f"idx_{table}_event", f"idx_{table}_tool", f"idx_{table}_session"):
        con.execute(f"DROP INDEX IF EXISTS {index_name}")
    if con.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
        con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def envelope_error(tool_response: Any) -> bool:
    """Detect a failure from structured envelope fields only."""
    if isinstance(tool_response, dict):
        for key in ("is_error", "isError", "iserror"):
            if tool_response.get(key) is True:
                return True
        if tool_response.get("success") is False:
            return True
        for key in ("exit_code", "exitCode", "returncode", "code"):
            value = tool_response.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value != 0:
                return True
        status = tool_response.get("status")
        if isinstance(status, str) and status.lower() in ("error", "failed", "failure"):
            return True
    return False


def status_from_payload(payload: dict[str, Any]) -> str:
    event = payload.get("hook_event_name", "PostToolUse")
    tool_response = payload.get("tool_response", payload.get("tool_result"))
    return "error" if event == "PostToolUseFailure" or envelope_error(tool_response) else "ok"


def detail_from_payload(payload: dict[str, Any], detail_max: int) -> str:
    if status_from_payload(payload) != "error":
        return ""
    source = payload.get("tool_response", payload.get("tool_result"))
    if not source:
        source = payload.get("error") or payload.get("tool_error") or payload.get("message")
    if not source:
        return ""
    if isinstance(source, str):
        return source[:detail_max]
    return json.dumps(source, ensure_ascii=True, sort_keys=True)[:detail_max]


def row_from_payload(
    payload: dict[str, Any],
    config: dict[str, Any],
    settings: dict[str, Any],
    *,
    recorded_at: float | None = None,
) -> tuple[Any, ...]:
    detail_max = int(settings.get("detailMaxChars", 500))
    ts = recorded_at if isinstance(recorded_at, (int, float)) and recorded_at > 0 else time.time()
    tool_input = payload.get("tool_input", {})
    tool_name = payload.get("tool_name", "")
    return (
        ts,
        utc_iso(ts),
        payload.get("session_id", ""),
        detect_project(payload.get("cwd", ""), config.get("shared", {}).get("projects", [])),
        "hook-telemetry",
        payload.get("hook_event_name", "PostToolUse"),
        tool_name,
        extract_target(tool_name, tool_input),
        "",
        status_from_payload(payload),
        None,
        detail_from_payload(payload, detail_max),
    )


def insert_event(con, table: str, row: tuple[Any, ...]) -> int:
    cursor = con.execute(
        f"INSERT INTO {table} "
        "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row,
    )
    return int(cursor.lastrowid or 0)


def prune_if_needed(con, table: str, settings: dict[str, Any], *, now: float, lastrowid: int) -> None:
    retention_days = settings.get("retentionDays", 0)
    prune_every = int(settings.get("retentionPruneEvery", 500))
    if (
        isinstance(retention_days, (int, float))
        and retention_days > 0
        and prune_every > 0
        and lastrowid
        and lastrowid % prune_every == 0
    ):
        con.execute(f"DELETE FROM {table} WHERE ts < ?", (now - retention_days * 86400,))


def write_payload(
    config: dict[str, Any],
    hcfg: dict[str, Any],
    payload: dict[str, Any],
    *,
    recorded_at: float | None = None,
) -> int:
    settings = hcfg.get("settings", {})
    table = safe_table(settings.get("table", "hook_events"), "hook_events")
    row = row_from_payload(payload, config, settings, recorded_at=recorded_at)
    con = connect(hooks_db(config))
    try:
        ensure_schema(con, table)
        lastrowid = insert_event(con, table, row)
        prune_if_needed(con, table, settings, now=time.time(), lastrowid=lastrowid)
        con.commit()
        return lastrowid
    finally:
        con.close()


def write_payloads(
    config: dict[str, Any],
    hcfg: dict[str, Any],
    records: list[tuple[dict[str, Any], float | None]],
) -> int:
    """Write a drain batch with one DB connection, one schema check, and one commit."""
    if not records:
        return 0
    settings = hcfg.get("settings", {})
    table = safe_table(settings.get("table", "hook_events"), "hook_events")
    con = connect(hooks_db(config))
    written = 0
    lastrowid = 0
    try:
        ensure_schema(con, table)
        for payload, recorded_at in records:
            lastrowid = insert_event(con, table, row_from_payload(payload, config, settings, recorded_at=recorded_at))
            written += 1
        prune_if_needed(con, table, settings, now=time.time(), lastrowid=lastrowid)
        con.commit()
        return written
    finally:
        con.close()
```

### `hook-telemetry/queue-event.py`

```python
#!/usr/bin/env python
"""Fast PostToolUse telemetry router.

Successful ordinary telemetry writes one event per file so parallel hook
processes cannot interleave JSONL records. Failure-class telemetry writes
synchronously to hook_events so loop-safety can see same-turn retries.
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_core"))

from hook_runtime import hook_cfg, is_enabled, load_config, matches_tool  # noqa: E402
from store import InvalidTelemetryPayload, max_event_bytes, queue_settings, resolve_path, status_from_payload, write_payload  # noqa: E402

HOOK_ID = "hook-telemetry"


def direct_tools(hcfg: dict[str, Any]) -> set[str]:
    tools = queue_settings(hcfg).get("directTools", [])
    return {str(tool) for tool in tools if str(tool)}


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.buffer.read()
    if not raw.strip():
        raise InvalidTelemetryPayload("empty telemetry payload")
    try:
        parsed = json.loads(raw.decode("utf-8-sig"))
    except Exception as exc:
        raise InvalidTelemetryPayload(f"invalid telemetry JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise InvalidTelemetryPayload("telemetry payload was not a JSON object")
    return parsed


def truncate(value: Any, limit: int) -> Any:
    if isinstance(value, str):
        return value[:limit]
    return value


def compact_tool_input(tool_input: Any) -> Any:
    if not isinstance(tool_input, dict):
        return truncate(tool_input, 2000)
    keep = {}
    for key in ("command", "file_path", "path", "url", "cmd", "query"):
        if key in tool_input:
            keep[key] = truncate(tool_input[key], 2000)
    return keep


def compact_response(source: Any) -> Any:
    if not isinstance(source, dict):
        return truncate(source, 2000)
    keep = {}
    for key in ("is_error", "isError", "iserror", "success", "exit_code", "exitCode", "returncode", "code", "status", "message", "error"):
        if key in source:
            keep[key] = truncate(source[key], 2000)
    return keep


def trim_payload_if_needed(payload: dict[str, Any], limit: int) -> dict[str, Any]:
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) <= limit:
        return payload
    trimmed = {
        "_telemetry": {
            "trimmed": True,
            "reason": "payload exceeded maxEventBytes",
            "originalBytes": len(encoded),
            "maxEventBytes": limit,
        }
    }
    for key in ("hook_event_name", "session_id", "cwd", "tool_name"):
        if key in payload:
            trimmed[key] = payload[key]
    if "tool_input" in payload:
        trimmed["tool_input"] = compact_tool_input(payload.get("tool_input"))
    response_key = "tool_response" if "tool_response" in payload else "tool_result"
    if response_key in payload:
        trimmed[response_key] = compact_response(payload.get(response_key))
    for key in ("error", "tool_error", "message"):
        if key in payload:
            trimmed[key] = truncate(payload[key], 2000)
    return trimmed


def write_queued_event(config: dict[str, Any], hcfg: dict[str, Any], payload: dict[str, Any]) -> Path:
    queue = queue_settings(hcfg)
    queue_dir = resolve_path(config, queue.get("queueDir"), ".state/hook-telemetry/queue")
    queue_dir.mkdir(parents=True, exist_ok=True)
    stamp = f"{time.time_ns()}-{os.getpid()}-{uuid.uuid4().hex}"
    tmp_path = queue_dir / f"{stamp}.json.tmp"
    final_path = queue_dir / f"{stamp}.json"
    record = {
        "schemaVersion": 1,
        "queuedAt": time.time(),
        "pid": os.getpid(),
        "payload": payload,
    }
    tmp_path.write_text(json.dumps(record, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp_path, final_path)
    return final_path


def main() -> int:
    try:
        config = load_config()
        hcfg = hook_cfg(config, HOOK_ID)
        if not is_enabled(hcfg):
            return 0
        payload = read_payload()
        tool_name = str(payload.get("tool_name", ""))
        if tool_name and not matches_tool(hcfg, tool_name):
            return 0
        if tool_name in direct_tools(hcfg):
            return 0
        if status_from_payload(payload) == "error":
            write_payload(config, hcfg, payload)
            print(json.dumps({"ok": True, "queued": False, "direct": True, "reason": "loop-safety-failure"}, ensure_ascii=True, sort_keys=True))
            return 0
        payload = trim_payload_if_needed(payload, max_event_bytes(hcfg))
        write_queued_event(config, hcfg, payload)
    except InvalidTelemetryPayload as exc:
        print(f"[{HOOK_ID}] ignored invalid payload (open): {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"[{HOOK_ID}] queue failed (open): {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

### `hook-telemetry/drain-events.py`

```python
#!/usr/bin/env python
"""Bounded telemetry queue drain.

The drain is best-effort and fail-open. It writes queued events into the same
hook_events schema used by direct telemetry.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_core"))

from hook_runtime import hook_cfg, is_enabled, load_config  # noqa: E402
from store import queue_settings, resolve_path, write_payloads  # noqa: E402

HOOK_ID = "hook-telemetry"


def positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        return fallback
    return parsed if parsed > 0 else fallback


def recover_draining_files(queue_dir: Path, older_than_seconds: int) -> int:
    recovered = 0
    now = time.time()
    for path in sorted(queue_dir.glob("*.json.draining")):
        try:
            age = now - path.stat().st_mtime
            if age < older_than_seconds:
                continue
            target = path.with_suffix("")
            if target.exists():
                target = queue_dir / f"{path.stem}.recovered-{uuid.uuid4().hex}.json"
            os.replace(path, target)
            recovered += 1
        except FileNotFoundError:
            continue
    return recovered


def claim(path: Path) -> Path | None:
    claimed = path.with_suffix(path.suffix + ".draining")
    try:
        os.replace(path, claimed)
        return claimed
    except FileNotFoundError:
        return None


def move_bad(path: Path, bad_dir: Path, reason: str) -> None:
    bad_dir.mkdir(parents=True, exist_ok=True)
    target = bad_dir / f"{path.name}.{uuid.uuid4().hex}.bad"
    try:
        shutil.move(str(path), str(target))
        target.with_suffix(target.suffix + ".error.json").write_text(
            json.dumps({"error": reason, "failedAt": time.time()}, ensure_ascii=True),
            encoding="utf-8",
        )
    except FileNotFoundError:
        return


def read_claimed(path: Path, bad_dir: Path) -> tuple[Path, dict[str, Any], float | None] | None:
    claimed = claim(path)
    if claimed is None:
        return None
    try:
        record = json.loads(claimed.read_text(encoding="utf-8"))
        payload = record.get("payload") if isinstance(record, dict) else None
        if not isinstance(payload, dict):
            raise ValueError("queued record missing payload object")
        queued_at = record.get("queuedAt") if isinstance(record, dict) else None
        return claimed, payload, queued_at if isinstance(queued_at, (int, float)) else None
    except Exception as exc:
        move_bad(claimed, bad_dir, str(exc))
        return None


def remaining_count(queue_dir: Path) -> int:
    return len(list(queue_dir.glob("*.json"))) + len(list(queue_dir.glob("*.json.draining")))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Drain queued hook telemetry into SQLite.")
    parser.add_argument("--max-ms", type=int, default=None)
    parser.add_argument("--max-events", type=int, default=None)
    return parser.parse_args()


def main() -> int:
    started = time.monotonic()
    processed = 0
    failed = 0
    recovered = 0
    try:
        args = parse_args()
        config = load_config()
        hcfg = hook_cfg(config, HOOK_ID)
        if not is_enabled(hcfg):
            print(json.dumps({"ok": True, "skipped": "disabled", "processed": 0, "failed": 0, "recovered": 0, "remaining": 0, "elapsedMs": 0}))
            return 0
        queue = queue_settings(hcfg)
        queue_dir = resolve_path(config, queue.get("queueDir"), ".state/hook-telemetry/queue")
        bad_dir = resolve_path(config, queue.get("badDir"), ".state/hook-telemetry/bad-events")
        max_ms = positive_int(args.max_ms if args.max_ms is not None else queue.get("maxMs"), 1000)
        max_events = positive_int(args.max_events if args.max_events is not None else queue.get("maxEvents"), 500)
        recover_after = positive_int(queue.get("recoverDrainingOlderThanSeconds"), 30)
        queue_dir.mkdir(parents=True, exist_ok=True)
        recovered = recover_draining_files(queue_dir, recover_after)
        deadline = started + (max_ms / 1000.0)
        claimed_records: list[tuple[Path, dict[str, Any], float | None]] = []
        for path in sorted(queue_dir.glob("*.json")):
            if len(claimed_records) >= max_events or time.monotonic() >= deadline:
                break
            record = read_claimed(path, bad_dir)
            if record is None:
                failed += 1
            else:
                claimed_records.append(record)
        if claimed_records:
            try:
                batch = [(payload, queued_at) for _claimed, payload, queued_at in claimed_records]
                processed = write_payloads(config, hcfg, batch)
                for claimed, _payload, _queued_at in claimed_records:
                    claimed.unlink(missing_ok=True)
            except Exception as exc:
                failed += len(claimed_records)
                for claimed, _payload, _queued_at in claimed_records:
                    move_bad(claimed, bad_dir, str(exc))
        elapsed_ms = int((time.monotonic() - started) * 1000)
        print(json.dumps({
            "ok": True,
            "processed": processed,
            "failed": failed,
            "recovered": recovered,
            "remaining": remaining_count(queue_dir),
            "elapsedMs": elapsed_ms,
        }, ensure_ascii=True, sort_keys=True))
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "processed": processed,
            "failed": failed,
            "recovered": recovered,
            "elapsedMs": elapsed_ms,
        }, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

### `hook-telemetry/test-queue-event.py`

```python
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
SCRIPT = ROOT / "hook-telemetry" / "queue-event.py"
DIRECT_TOOL = "mcp__mcp_router__sequentialthinking"


def base_config(root: Path, *, enabled: bool = True) -> dict:
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    hook = next(h for h in config["hooks"] if h["id"] == "hook-telemetry")
    hook["enabled"] = enabled
    hook["script"]["path"] = "hook-telemetry/queue-event.py"
    hook["settings"]["queue"] = {
        "queueDir": str(root / "queue").replace("\\", "/"),
        "badDir": str(root / "bad-events").replace("\\", "/"),
        "maxEventBytes": 4096,
        "maxMs": 1000,
        "maxEvents": 500,
        "recoverDrainingOlderThanSeconds": 1,
        "directTools": [DIRECT_TOOL],
    }
    config["shared"]["paths"]["hooksDb"] = str(root / "hooks.db").replace("\\", "/")
    return config


def invoke(config_path: Path, payload: dict | str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    data = payload if isinstance(payload, str) else json.dumps(payload)
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=data,
        text=True,
        capture_output=True,
        cwd=ROOT,
        env=env,
    )


def queue_files(root: Path) -> list[Path]:
    queue = root / "queue"
    return sorted(queue.glob("*.json")) if queue.exists() else []


def rows(db_path: Path) -> list[tuple[str, str, str]]:
    con = sqlite3.connect(db_path)
    try:
        return con.execute("SELECT tool_name, status, target FROM hook_events ORDER BY id").fetchall()
    finally:
        con.close()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="telemetry-queue-test-") as td:
        root = Path(td)
        config_path = root / "config.json"
        config_path.write_text(json.dumps(base_config(root)), encoding="utf-8")

        bash_payload = {
            "hook_event_name": "PostToolUse",
            "session_id": "queue-test",
            "cwd": "E:/hooks",
            "tool_name": "Bash",
            "tool_input": {"command": "pnpm run build"},
            "tool_response": {"exit_code": 0},
        }
        proc = invoke(config_path, bash_payload)
        assert proc.returncode == 0, proc.stderr
        files = queue_files(root)
        assert len(files) == 1, files
        record = json.loads(files[0].read_text(encoding="utf-8"))
        assert record["schemaVersion"] == 1
        assert record["payload"]["tool_name"] == "Bash"
        assert not (root / "hooks.db").exists(), "queue path must not create SQLite DB"

        proc = invoke(config_path, {**bash_payload, "tool_name": DIRECT_TOOL})
        assert proc.returncode == 0, proc.stderr
        assert len(queue_files(root)) == 1, "direct thinking tools must not be queued"

        failed_payload = {**bash_payload, "tool_response": {"exit_code": 1, "stderr": "build failed"}}
        proc = invoke(config_path, failed_payload)
        assert proc.returncode == 0, proc.stderr
        assert len(queue_files(root)) == 1, "failed Bash telemetry must be direct, not queued"
        assert rows(root / "hooks.db") == [("Bash", "error", "pnpm run build")]

        failure_event_payload = {**bash_payload, "hook_event_name": "PostToolUseFailure", "tool_response": {"message": "permission denied"}}
        proc = invoke(config_path, failure_event_payload)
        assert proc.returncode == 0, proc.stderr
        assert len(queue_files(root)) == 1, "PostToolUseFailure telemetry must be direct, not queued"
        assert rows(root / "hooks.db")[-1] == ("Bash", "error", "pnpm run build")

        oversized_payload = {**bash_payload, "tool_response": {"exit_code": 0, "stdout": "x" * 10000}}
        proc = invoke(config_path, oversized_payload)
        assert proc.returncode == 0, proc.stderr
        files = queue_files(root)
        assert len(files) == 2, files
        oversized_record = json.loads(files[-1].read_text(encoding="utf-8"))
        assert oversized_record["payload"]["tool_name"] == "Bash"
        assert oversized_record["payload"]["_telemetry"]["trimmed"] is True
        assert oversized_record["payload"]["tool_name"] != "__telemetry_payload_too_large__"

        disabled_config_path = root / "disabled-config.json"
        disabled_config_path.write_text(json.dumps(base_config(root, enabled=False)), encoding="utf-8")
        proc = invoke(disabled_config_path, {**bash_payload, "tool_name": "Read"})
        assert proc.returncode == 0, proc.stderr
        assert len(queue_files(root)) == 2, "disabled hook must not queue events"

        proc = invoke(config_path, "{not-json")
        assert proc.returncode == 0, proc.stderr
        files = queue_files(root)
        assert len(files) == 2, "malformed stdin must not queue synthetic telemetry"
        assert "ignored invalid payload" in proc.stderr

    print("telemetry queue tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

### `hook-telemetry/test-drain-events.py`

```python
#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path("E:/hooks")
QUEUE_SCRIPT = ROOT / "hook-telemetry" / "queue-event.py"
DRAIN_SCRIPT = ROOT / "hook-telemetry" / "drain-events.py"
DIRECT_SCRIPT = ROOT / "hook-telemetry" / "log-event.py"
DIRECT_TOOL = "mcp__mcp_router__sequentialthinking"


def base_config(root: Path) -> dict:
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    hook = next(h for h in config["hooks"] if h["id"] == "hook-telemetry")
    hook["enabled"] = True
    hook["script"]["path"] = "hook-telemetry/queue-event.py"
    hook["settings"]["queue"] = {
        "queueDir": str(root / "queue").replace("\\", "/"),
        "badDir": str(root / "bad-events").replace("\\", "/"),
        "maxEventBytes": 4096,
        "maxMs": 1000,
        "maxEvents": 500,
        "recoverDrainingOlderThanSeconds": 1,
        "directTools": [DIRECT_TOOL],
    }
    config["shared"]["paths"]["hooksDb"] = str(root / "hooks.db").replace("\\", "/")
    return config


def run_script(script: Path, config_path: Path, payload: dict | None = None, *args: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HOOKS_CONFIG_PATH"] = str(config_path)
    return subprocess.run(
        [sys.executable, str(script), *args],
        input=json.dumps(payload) if payload is not None else "",
        text=True,
        capture_output=True,
        cwd=ROOT,
        env=env,
    )


def payload(tool_name: str, *, exit_code: int = 0) -> dict:
    return {
        "hook_event_name": "PostToolUse",
        "session_id": "drain-test",
        "cwd": "E:/hooks",
        "tool_name": tool_name,
        "tool_input": {"command": "pnpm run build"} if tool_name == "Bash" else {},
        "tool_response": {"exit_code": exit_code},
    }


def rows(db_path: Path) -> list[tuple[str, str, str]]:
    con = sqlite3.connect(db_path)
    try:
        return con.execute("SELECT tool_name, status, target FROM hook_events ORDER BY id").fetchall()
    finally:
        con.close()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="telemetry-drain-test-") as td:
        root = Path(td)
        config_path = root / "config.json"
        config_path.write_text(json.dumps(base_config(root)), encoding="utf-8")

        for tool_name in ("Bash", "Read"):
            proc = run_script(QUEUE_SCRIPT, config_path, payload(tool_name, exit_code=0))
            assert proc.returncode == 0, proc.stderr

        first = run_script(DRAIN_SCRIPT, config_path, None, "--max-events", "1")
        assert first.returncode == 0, first.stderr
        first_summary = json.loads(first.stdout)
        assert first_summary["processed"] == 1, first.stdout
        assert first_summary["remaining"] == 1, first.stdout
        assert rows(root / "hooks.db") == [("Bash", "ok", "pnpm run build")]

        second = run_script(DRAIN_SCRIPT, config_path, None, "--max-events", "50", "--max-ms", "1000")
        assert second.returncode == 0, second.stderr
        second_summary = json.loads(second.stdout)
        assert second_summary["processed"] == 1, second.stdout
        assert second_summary["remaining"] == 0, second.stdout
        assert rows(root / "hooks.db") == [
            ("Bash", "ok", "pnpm run build"),
            ("Read", "ok", ""),
        ]

        failed = run_script(QUEUE_SCRIPT, config_path, payload("Bash", exit_code=1))
        assert failed.returncode == 0, failed.stderr
        assert rows(root / "hooks.db")[-1] == ("Bash", "error", "pnpm run build")
        assert len(list((root / "queue").glob("*.json"))) == 0, "failed events must bypass queue"

        direct = run_script(DIRECT_SCRIPT, config_path, payload(DIRECT_TOOL))
        assert direct.returncode == 0, direct.stderr
        assert rows(root / "hooks.db")[-1][0] == DIRECT_TOOL

        queue_dir = root / "queue"
        queue_dir.mkdir(exist_ok=True)
        stale = queue_dir / "stale.json.draining"
        stale.write_text(json.dumps({"schemaVersion": 1, "queuedAt": time.time(), "pid": 1, "payload": payload("Read")}), encoding="utf-8")
        old = time.time() - 10
        os.utime(stale, (old, old))
        recovered = run_script(DRAIN_SCRIPT, config_path, None, "--max-events", "10")
        assert recovered.returncode == 0, recovered.stderr
        recovered_summary = json.loads(recovered.stdout)
        assert recovered_summary["recovered"] == 1, recovered.stdout
        assert rows(root / "hooks.db")[-1][0] == "Read"

        bad_file = queue_dir / "bad.json"
        bad_file.write_text("{not-json", encoding="utf-8")
        bad = run_script(DRAIN_SCRIPT, config_path, None, "--max-events", "10")
        assert bad.returncode == 0, bad.stderr
        bad_summary = json.loads(bad.stdout)
        assert bad_summary["failed"] == 1, bad.stdout
        assert list((root / "bad-events").glob("*.bad")), "bad event should be moved aside"

    print("telemetry drain tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

## Existing File Diffs

### `hook-telemetry/log-event.py`

```diff
@@
-#!/usr/bin/env python
-"""hook-telemetry (PostToolUse + PostToolUseFailure): append one row per tool firing to
-`hook_events` in the DEDICATED hooks DB (shared.paths.hooksDb), via the shared hook_runtime.
-
-STATUS is derived from the EVENT, not from scanning output text:
-  - PostToolUseFailure (Claude's failure event) -> status=error
-  - PostToolUse        -> status=ok, unless the response ENVELOPE structurally signals an
-                          error (is_error/success:false/non-zero exit), for example Codex non-zero
-                          Bash. No free-text scan, so a successful grep that prints "error:"
-                          is NOT misclassified.
-This is the substrate loop-safety counts, so signal quality is load-bearing.
-
-The runtime enforces enabled + failPolicy + match.tools and is fail-open: errors never block
-a tool call.
-"""
-from __future__ import annotations
-
-import json
-import os
-import sys
-import time
-from datetime import datetime, timezone
-
-sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_core"))
-from hook_runtime import connect, detect_project, extract_target, hooks_db, run, safe_table  # noqa: E402
-
-SCHEMA_VERSION = 1
-
-
-def ddl_for(table):
-    return f"""
-CREATE TABLE IF NOT EXISTS {table} (
-  id INTEGER PRIMARY KEY AUTOINCREMENT,
-  ts REAL NOT NULL,
-  ts_iso TEXT NOT NULL,
-  session_id TEXT,
-  project TEXT,
-  hook_id TEXT,
-  event TEXT,
-  tool_name TEXT,
-  target TEXT,
-  decision TEXT,
-  status TEXT,
-  duration_ms INTEGER,
-  detail TEXT
-);
-CREATE INDEX IF NOT EXISTS idx_{table}_session_ts ON {table}(session_id, ts DESC, id DESC);
-CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {table}(ts);
-"""
-
-
-def ensure_schema(con, table):
-    """Create the table + indexes idempotently.
-
-    PRAGMA user_version is database-wide, so it cannot be the gate for table
-    creation. Always run IF NOT EXISTS DDL; only use user_version as metadata.
-    """
-    con.executescript(ddl_for(table))
-    for ix in (f"idx_{table}_event", f"idx_{table}_tool", f"idx_{table}_session"):
-        con.execute(f"DROP INDEX IF EXISTS {ix}")
-    if con.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
-        con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
-
-
-def utc_iso(ts):
-    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
-
-
-def envelope_error(tool_response):
-    """Detect a failure from STRUCTURED envelope fields only; never scan body text."""
-    tr = tool_response
-    if isinstance(tr, dict):
-        for k in ("is_error", "isError", "iserror"):
-            if tr.get(k) is True:
-                return True
-        if tr.get("success") is False:
-            return True
-        for k in ("exit_code", "exitCode", "returncode", "code"):
-            v = tr.get(k)
-            if isinstance(v, (int, float)) and not isinstance(v, bool) and v != 0:
-                return True
-        st = tr.get("status")
-        if isinstance(st, str) and st.lower() in ("error", "failed", "failure"):
-            return True
-    return False
-
-
-def handler(payload, config, hcfg):
-    settings = hcfg.get("settings", {})
-    table = safe_table(settings.get("table", "hook_events"), "hook_events")
-    detail_max = int(settings.get("detailMaxChars", 500))
-    retention_days = settings.get("retentionDays", 0)
-    prune_every = int(settings.get("retentionPruneEvery", 500))
-
-    event = payload.get("hook_event_name", "PostToolUse")
-    tool_input = payload.get("tool_input", {})
-    tool_response = payload.get("tool_response", payload.get("tool_result"))
-    status = "error" if (event == "PostToolUseFailure" or envelope_error(tool_response)) else "ok"
-
-    detail = ""
-    if status == "error":
-        src = tool_response
-        if not src:  # PostToolUseFailure may carry the failure elsewhere
-            src = payload.get("error") or payload.get("tool_error") or payload.get("message")
-        if src:
-            detail = (src if isinstance(src, str) else json.dumps(src))[:detail_max]
-
-    now = time.time()
-    row = (
-        now,
-        utc_iso(now),
-        payload.get("session_id", ""),
-        detect_project(payload.get("cwd", ""), config.get("shared", {}).get("projects", [])),
-        "hook-telemetry",
-        event,
-        payload.get("tool_name", ""),
-        extract_target(payload.get("tool_name", ""), tool_input),
-        "",
-        status,
-        None,
-        detail,
-    )
-
-    con = connect(hooks_db(config))
-    try:
-        ensure_schema(con, table)
-        cur = con.execute(
-            f"INSERT INTO {table} "
-            "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
-            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
-            row,
-        )
-        if (isinstance(retention_days, (int, float)) and retention_days > 0
-                and prune_every > 0 and cur.lastrowid and cur.lastrowid % prune_every == 0):
-            con.execute(f"DELETE FROM {table} WHERE ts < ?", (now - retention_days * 86400,))
-        con.commit()
-    finally:
-        con.close()
-
-
-if __name__ == "__main__":
-    run("hook-telemetry", handler)
+#!/usr/bin/env python
+"""Direct synchronous hook telemetry writer.
+
+This entrypoint is retained for grant-critical events, especially
+sequential-thinking events consumed immediately by thinking-gate.
+"""
+from __future__ import annotations
+
+import os
+import sys
+
+sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_core"))
+from hook_runtime import run  # noqa: E402
+
+sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
+from store import write_payload  # noqa: E402
+
+
+def handler(payload, config, hcfg):
+    write_payload(config, hcfg, payload)
+
+
+if __name__ == "__main__":
+    run("hook-telemetry", handler)
```

### `config.json`

Replace the existing `hooks[id="hook-telemetry"]` object with:

```json
{
  "id": "hook-telemetry",
  "name": "Hook Telemetry Logger",
  "description": "PostToolUse + PostToolUseFailure telemetry. Successful ordinary telemetry is queued by hook-telemetry/queue-event.py and drained later into hook_events; failure-class telemetry is written synchronously for loop-safety; grant-critical sequential-thinking telemetry stays on hook-telemetry/log-event.py via live TOML direct wiring.",
  "category": "telemetry",
  "event": ["PostToolUse", "PostToolUseFailure"],
  "match": { "tools": ["*"] },
  "script": { "path": "hook-telemetry/queue-event.py", "runtime": "python" },
  "scope": { "projects": ["*"], "paths": ["**"] },
  "enabled": true,
  "failPolicy": "open",
  "settings": {
    "table": "hook_events",
    "retentionDays": 30,
    "retentionPruneEvery": 500,
    "detailMaxChars": 500,
    "mode": "queue-success-plus-direct-safety",
    "directScript": "hook-telemetry/log-event.py",
    "drainScript": "hook-telemetry/drain-events.py",
    "queue": {
      "queueDir": ".state/hook-telemetry/queue",
      "badDir": ".state/hook-telemetry/bad-events",
      "maxEventBytes": 131072,
      "maxMs": 1000,
      "maxEvents": 500,
      "recoverDrainingOlderThanSeconds": 30,
      "directTools": [
        "mcp__mcp_router__sequentialthinking",
        "mcp__mcp-router__sequentialthinking",
        "mcp__sequential-thinking__sequentialthinking",
        "mcp__sequentialthinking__sequentialthinking",
        "mcp__plugin_sequential-thinking_sequential-thinking__sequentialthinking",
        "mcp__plugin_sequentialthinking_sequentialthinking__sequentialthinking"
      ]
    }
  }
}
```

### `_core/config-model.mjs`

```diff
@@
 function validateTelemetry(config, errors) {
   const hook = hookById(config, 'hook-telemetry');
   pushIf(errors, isObject(hook), 'missing hooks[id=hook-telemetry]');
   if (!isObject(hook)) return;
   const evs = Array.isArray(hook.event) ? hook.event : [hook.event];
   pushIf(errors, evs.includes('PostToolUse'), 'hook-telemetry.event must include PostToolUse');
+  pushIf(errors, evs.includes('PostToolUseFailure'), 'hook-telemetry.event must include PostToolUseFailure');
-  pushIf(errors, hook.script?.path === 'hook-telemetry/log-event.py', 'hook-telemetry.script.path mismatch');
+  pushIf(errors, hook.script?.path === 'hook-telemetry/queue-event.py', 'hook-telemetry.script.path mismatch');
   const s = hook.settings || {};
   pushIf(errors, identifier(s.table), 'hook-telemetry settings.table must be a SQL identifier');
   pushIf(errors, Number.isInteger(s.retentionDays) && s.retentionDays >= 0, 'hook-telemetry settings.retentionDays must be an integer >= 0');
   pushIf(errors, positiveInteger(s.detailMaxChars), 'hook-telemetry settings.detailMaxChars invalid');
   pushIf(errors, positiveInteger(s.retentionPruneEvery), 'hook-telemetry settings.retentionPruneEvery invalid');
+  pushIf(errors, s.mode === 'queue-success-plus-direct-safety', 'hook-telemetry settings.mode must be queue-success-plus-direct-safety');
+  pushIf(errors, s.directScript === 'hook-telemetry/log-event.py', 'hook-telemetry settings.directScript mismatch');
+  pushIf(errors, s.drainScript === 'hook-telemetry/drain-events.py', 'hook-telemetry settings.drainScript mismatch');
+  pushIf(errors, isObject(s.queue), 'hook-telemetry settings.queue must be an object');
+  if (isObject(s.queue)) {
+    pushIf(errors, typeof s.queue.queueDir === 'string' && s.queue.queueDir.length > 0, 'hook-telemetry settings.queue.queueDir missing');
+    pushIf(errors, typeof s.queue.badDir === 'string' && s.queue.badDir.length > 0, 'hook-telemetry settings.queue.badDir missing');
+    pushIf(errors, positiveInteger(s.queue.maxEventBytes), 'hook-telemetry settings.queue.maxEventBytes invalid');
+    pushIf(errors, positiveInteger(s.queue.maxMs), 'hook-telemetry settings.queue.maxMs invalid');
+    pushIf(errors, positiveInteger(s.queue.maxEvents), 'hook-telemetry settings.queue.maxEvents invalid');
+    pushIf(errors, positiveInteger(s.queue.recoverDrainingOlderThanSeconds), 'hook-telemetry settings.queue.recoverDrainingOlderThanSeconds invalid');
+    pushIf(errors, nonEmptyStringArray(s.queue.directTools), 'hook-telemetry settings.queue.directTools must be a non-empty string array');
+  }
 }
```

### `quality-completion-gate/test-config-model.mjs`

Insert after the memory-normalizer source-tools test:

```diff
@@
 const badMemoryNormalizerSourceToolsResult = validateConfig(badMemoryNormalizerSourceTools);
 assert.ok(
   badMemoryNormalizerSourceToolsResult.errors.some((error) => error.includes('memory-normalizer match.tools must equal settings.sourceTools')),
   'memory-normalizer must reject sourceTools drift from match.tools'
 );

+const badTelemetryScript = structuredClone(config);
+hookById(badTelemetryScript, 'hook-telemetry').script.path = 'hook-telemetry/log-event.py';
+const badTelemetryScriptResult = validateConfig(badTelemetryScript);
+assert.ok(
+  badTelemetryScriptResult.errors.some((error) => error.includes('hook-telemetry.script.path mismatch')),
+  'hook-telemetry primary script must be the telemetry router'
+);
+
+const badTelemetryEvents = structuredClone(config);
+hookById(badTelemetryEvents, 'hook-telemetry').event = ['PostToolUse'];
+const badTelemetryEventsResult = validateConfig(badTelemetryEvents);
+assert.ok(
+  badTelemetryEventsResult.errors.some((error) => error.includes('hook-telemetry.event must include PostToolUseFailure')),
+  'hook-telemetry must keep the failure event route for loop-safety'
+);
+
+const badTelemetryQueue = structuredClone(config);
+hookById(badTelemetryQueue, 'hook-telemetry').settings.queue.maxEvents = 0;
+const badTelemetryQueueResult = validateConfig(badTelemetryQueue);
+assert.ok(
+  badTelemetryQueueResult.errors.some((error) => error.includes('hook-telemetry settings.queue.maxEvents invalid')),
+  'hook-telemetry queue bounds must be validated'
+);
+
+const badTelemetryDirectTools = structuredClone(config);
+hookById(badTelemetryDirectTools, 'hook-telemetry').settings.queue.directTools = [];
+const badTelemetryDirectToolsResult = validateConfig(badTelemetryDirectTools);
+assert.ok(
+  badTelemetryDirectToolsResult.errors.some((error) => error.includes('hook-telemetry settings.queue.directTools')),
+  'hook-telemetry must declare direct grant tools'
+);
+
 const badQualityAuthority = structuredClone(config);
 hookById(badQualityAuthority, 'quality-completion-gate').settings.authority = 'assistant-claims';
```

### `quality-completion-gate/quality-verify-manifest.json`

Update the `hooks python compile` command to include the new files:

```diff
@@
-            { "label": "hooks python compile", "command": "python -m py_compile _core/hook_runtime.py _core/test-hook-runtime.py hook-telemetry/log-event.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/maintain-existing-memories.py memory-normalizer/test-memory-runtime.py memory-normalizer/test-normalize-memory-tags-readonly.py memory-normalizer/test-maintain-readonly.py thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py inject-protocol/test-recall-readonly.py inject-protocol/test-suggest-readonly.py inject-protocol-complex/recall.py inject-protocol-complex/suggest.py inject-protocol-complex/test-recall-readonly.py inject-protocol-complex/test-suggest-readonly.py", "timeoutMs": 30000 },
+            { "label": "hooks python compile", "command": "python -m py_compile _core/hook_runtime.py _core/test-hook-runtime.py hook-telemetry/log-event.py hook-telemetry/store.py hook-telemetry/queue-event.py hook-telemetry/drain-events.py hook-telemetry/test-queue-event.py hook-telemetry/test-drain-events.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/maintain-existing-memories.py memory-normalizer/test-memory-runtime.py memory-normalizer/test-normalize-memory-tags-readonly.py memory-normalizer/test-maintain-readonly.py thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py inject-protocol/test-recall-readonly.py inject-protocol/test-suggest-readonly.py inject-protocol-complex/recall.py inject-protocol-complex/suggest.py inject-protocol-complex/test-recall-readonly.py inject-protocol-complex/test-suggest-readonly.py", "timeoutMs": 30000 },
```

Add the queue and drain tests before python compile:

```diff
@@
             { "label": "hooks memory normalizer self-test", "command": "python memory-normalizer/normalize-after-store.py --self-test", "timeoutMs": 30000 },
             { "label": "hooks thinking gate tests", "command": "python thinking-gate/test-thinking-gate.py", "timeoutMs": 30000 },
             { "label": "hooks inject protocol self-test", "command": "node inject-protocol/test-inject-protocol-self-test.mjs", "timeoutMs": 30000 },
+            { "label": "hooks telemetry queue tests", "command": "python hook-telemetry/test-queue-event.py", "timeoutMs": 30000 },
+            { "label": "hooks telemetry drain tests", "command": "python hook-telemetry/test-drain-events.py", "timeoutMs": 30000 },
             { "label": "hooks python compile", "command": "python -m py_compile ...", "timeoutMs": 30000 },
```

### `C:/Users/jwchu/.codex/config.toml`

Replace the current broad `PostToolUse` telemetry block with two `PostToolUse` blocks plus one broad `PostToolUseFailure` block:

```toml
[[hooks.PostToolUse]]
matcher = "(mcp__mcp_router__sequentialthinking|mcp__mcp-router__sequentialthinking|mcp__sequential-thinking__sequentialthinking|mcp__sequentialthinking__sequentialthinking|mcp__plugin_sequential-thinking_sequential-thinking__sequentialthinking|mcp__plugin_sequentialthinking_sequentialthinking__sequentialthinking)"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "python E:/hooks/hook-telemetry/log-event.py"
timeout = 10
statusMessage = "Recording planning grant"

[[hooks.PostToolUse]]
matcher = ".*"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "python E:/hooks/hook-telemetry/queue-event.py"
timeout = 3
statusMessage = "Queueing telemetry event"

[[hooks.PostToolUseFailure]]
matcher = ".*"

[[hooks.PostToolUseFailure.hooks]]
type = "command"
command = "python E:/hooks/hook-telemetry/queue-event.py"
timeout = 3
statusMessage = "Recording failed telemetry event"
```

Add a telemetry drain hook under the existing `[[hooks.Stop]]` block before the quality gate hook:

```toml
[[hooks.Stop.hooks]]
type = "command"
command = "python E:/hooks/hook-telemetry/drain-events.py --max-ms 1000 --max-events 500"
timeout = 3
statusMessage = "Draining telemetry queue"
```

Keep the existing memory-normalizer `PostToolUse` block unchanged.

## Execution Tasks

### Task 1: Add store module

**File(s):** `hook-telemetry/store.py`

**Step 1:** Add the complete `store.py` code from this plan.
**Step 2:** Run `python -m py_compile hook-telemetry/store.py`.

**Expected output:** Exit code `0`.

**Commit:** `refactor: split telemetry durable store`

### Task 2: Add telemetry router

**File(s):** `hook-telemetry/queue-event.py`, `hook-telemetry/test-queue-event.py`

**Step 1:** Add `queue-event.py`.
**Step 2:** Add `test-queue-event.py`.
**Step 3:** Run `python hook-telemetry/test-queue-event.py`.

**Expected output:** `telemetry queue tests passed`

**Commit:** `feat: add telemetry queue router`

### Task 3: Add bounded drain worker

**File(s):** `hook-telemetry/drain-events.py`, `hook-telemetry/test-drain-events.py`

**Step 1:** Add `drain-events.py`.
**Step 2:** Add `test-drain-events.py`.
**Step 3:** Run `python hook-telemetry/test-drain-events.py`.

**Expected output:** `telemetry drain tests passed`

**Commit:** `feat: drain queued telemetry into hook events`

### Task 4: Convert direct logger to compatibility wrapper

**File(s):** `hook-telemetry/log-event.py`

**Step 1:** Apply the `log-event.py` diff.
**Step 2:** Run `python -m py_compile hook-telemetry/log-event.py hook-telemetry/store.py`.

**Expected output:** Exit code `0`.

**Commit:** `refactor: keep direct telemetry for planning grants`

### Task 5: Update repo config and validation

**File(s):** `config.json`, `_core/config-model.mjs`, `quality-completion-gate/test-config-model.mjs`

**Step 1:** Replace the `hook-telemetry` object in `config.json`.
**Step 2:** Apply the telemetry validator diff.
**Step 3:** Add config-model tests.
**Step 4:** Run `node quality-completion-gate/test-config-model.mjs`.
**Step 5:** Run `node _core/validate-runtime-hooks.mjs`.

**Expected output:** `config model tests passed` and `Runtime hook validation passed`

**Commit:** `chore: model queued telemetry configuration`

### Task 6: Expand manifest verification

**File(s):** `quality-completion-gate/quality-verify-manifest.json`

**Step 1:** Add telemetry queue/drain tests to the hooks runtime command list.
**Step 2:** Add new telemetry Python files to the compile command.
**Step 3:** Run `node _core/validate-runtime-hooks.mjs`.

**Expected output:** `Runtime hook validation passed`

**Commit:** `test: include telemetry queue in hook verification`

### Task 7: Update live Codex hook wiring

**File(s):** `C:/Users/jwchu/.codex/config.toml`

**Step 1:** Add the sequential-thinking direct `PostToolUse` block.
**Step 2:** Change the broad `PostToolUse` telemetry block to `queue-event.py`.
**Step 3:** Add the broad `PostToolUseFailure` telemetry block to `queue-event.py`.
**Step 4:** Add the Stop drain hook before the quality gate Stop hook.
**Step 5:** Parse TOML with Python:

```powershell
@'
import tomllib
from pathlib import Path
cfg = tomllib.loads(Path(r"C:\Users\jwchu\.codex\config.toml").read_text(encoding="utf-8"))
print(len(cfg["hooks"]["PostToolUse"]))
print(len(cfg["hooks"].get("PostToolUseFailure", [])))
print(len(cfg["hooks"]["Stop"][0]["hooks"]))
'@ | python -
```

**Expected output:** At least `3` PostToolUse blocks, at least `1` PostToolUseFailure block, and at least `2` Stop hooks, depending on existing memory-normalizer wiring.

**Commit:** No repo commit unless live config is tracked separately.

### Task 8: Run full verification

**File(s):** all touched files

**Step 1:** Run `python hook-telemetry/test-queue-event.py`.
**Step 2:** Run `python hook-telemetry/test-drain-events.py`.
**Step 3:** Run `python _core/test-hook-runtime.py`.
**Step 4:** Run `python thinking-gate/test-thinking-gate.py`.
**Step 5:** Run `python memory-normalizer/test-memory-runtime.py`.
**Step 6:** Run `node quality-completion-gate/test-config-model.mjs`.
**Step 7:** Run `node _core/validate-runtime-hooks.mjs`.
**Step 8:** Run the hooks runtime manifest command set for `E:/hooks`.
**Step 9:** Run `git diff --check`.

**Expected output:** All commands exit `0`; `git diff --check` has no whitespace errors except acceptable CRLF warnings if present.

**Commit:** `test: verify two-tier telemetry path`

## Rollback

1. Revert `C:/Users/jwchu/.codex/config.toml` telemetry wiring to synchronous `log-event.py` for all desired tools.
2. Set `hooks[id="hook-telemetry"].script.path` back to `hook-telemetry/log-event.py` in `config.json`.
3. Remove the new queue/drain files from manifest commands.
4. Leave queued files under `.state/hook-telemetry/queue` untouched or drain them manually with the old direct logger disabled.

## Final Contract Check

- Platform API: explicitly zero.
- Database migrations: explicitly zero.
- Edge functions: explicitly zero.
- Frontend surface: explicitly zero.
- Observability: locked to queue files, drain summary, and existing `hook_events`.
- Compatibility seam: sequential-thinking grants remain synchronous.
- File inventory: locked.
- Tests: concrete commands and expected outputs declared.
