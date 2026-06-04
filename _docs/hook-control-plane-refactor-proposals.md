# Hook Control Plane Refactor Proposals

Status: proposal for evaluator review, not approved implementation
Date: 2026-06-03
Scope: E:/hooks
Authoring mode: repo-grounded implementation planning after brainstorming, sequential thinking, repo investigation, refactor review, and plan-writing discipline

Baseline revision note: this document must be read as a current-working-tree proposal, not a proposal from `HEAD` and not a proposal from an older hook layout. The current working tree already contains partial hook refactors. Those existing changes are treated as baseline facts below, not future work.

## Required Manual Workflow Constraint

The depcruiser/OpenHands migration work is currently being walked manually in `#newchat`. Claude reports process state. Codex must act only after Jon gives a concrete go-ahead.

This document does not approve wiring depcruiser into the live hook control plane. The depcruiser proposal below is containment and capability modeling only, so unfinished migration assets are not exposed as active capabilities while development continues.

## Executive Summary

This proposal covers six targeted refactors:

1. Add a capability registry so draft systems such as depcruiser cannot be accidentally exposed as live skills or hooks.
2. Split telemetry into a fast queue path and a durable drain path so PostToolUse status cannot appear stalled by synchronous SQLite work.
3. Replace thinking-gate's grant counter with a policy-as-code and capability-lease model based on common admission-control and capability-security patterns.
4. Extend the quality gate from "commands ran" to "declared capabilities and live surfaces are coherent."
5. Consolidate inject-protocol and inject-protocol-complex into one runner with separate profiles.
6. Add a live wiring parity model so `config.json`, live Codex TOML, and actual script paths cannot drift silently.

Recommended implementation order:

1. Capability registry and quality integrity checks.
2. Live wiring parity validator.
3. Telemetry queue and drain split.
4. Injector runner consolidation.
5. Thinking-gate lease model.
6. Depcruiser runtime activation only after the manual depcruiser workflow is approved.

## Current Working-Tree Baseline

This is the baseline the implementation plan must use. Any evaluator should reject an implementation that treats these items as absent or as future work.

### Baseline Source Check

The repo is currently dirty. Existing code changes include hook runtime, config model, injector, memory normalizer, quality gate, thinking gate, and deleted depcruiser migration files. This proposal document is an added `_docs/` file on top of that dirty tree. Implementation must preserve unrelated existing changes and patch only the files named by each approved proposal.

### Repo Config Baseline

- `config.json:43-49` declares active `inject-protocol` with script path `inject-protocol/inject-protocol.mjs`.
- `config.json:131-137` declares `inject-protocol-complex` with script path `inject-protocol-complex/inject-protocol-complex.mjs`.
- `config.json:219-235` declares `hook-telemetry` with `PostToolUse` and `PostToolUseFailure`, repo-side `match.tools=["*"]`, synchronous command `hook-telemetry/log-event.py`, retention settings, and a SQLite event table.
- `config.json:238-268` declares `thinking-gate` as `PreToolUse` on all tools with `grantPolicy.mode="bounded_tool_count"` and `maxToolUses=15`.
- `config.json:402-423` declares `loop-safety` as reading the telemetry event table.
- `config.json:427-443` declares the Stop hook `quality-completion-gate`.
- `config.json` now has expanded memory-normalizer source tools for memory mutation calls, including store, update, observe, cleanup, delete, and mistake-note variants.

### Live Codex Config Baseline

The live file is `C:/Users/jwchu/.codex/config.toml`.

- `config.toml:15-20` wires `UserPromptSubmit` to `node E:/hooks/inject-protocol/inject-protocol.mjs`.
- `config.toml:22-28` wires `Stop` to `node E:/hooks/quality-completion-gate/quality-completion-gate.mjs`.
- `config.toml:30-37` wires `PostToolUse` telemetry only for sequential-thinking matcher variants, with command `python E:/hooks/hook-telemetry/log-event.py` and status message `Recording telemetry (<1s)`.
- `config.toml:39-46` wires `PostToolUse` memory normalization only for memory mutation matchers.
- `config.toml:48-55` wires `PreToolUse` thinking-gate broadly.
- `config.toml:57-64` wires loop-safety for Bash, apply_patch, and context-mode tool patterns.

This means the current live baseline is not broad telemetry after every tool. The broad repo-side telemetry declaration remains in `config.json`, but live Codex has already been narrowed as a mitigation. Proposal 2 must therefore be read as a durable replacement for the scoped mitigation, not as a description of the current live hook firing broadly.

### Telemetry Baseline

- `hook-telemetry/log-event.py:52-62` runs schema and legacy-index cleanup logic during ordinary event logging.
- `hook-telemetry/log-event.py:92-98` reads retention settings and derives event/status structurally.
- `hook-telemetry/log-event.py:124-136` opens SQLite, ensures schema, inserts the event, optionally prunes retention, and commits synchronously for each event.
- `hook-telemetry/` is the canonical telemetry directory. Do not reintroduce a legacy `telemetry/` path.

### Thinking-Gate Baseline

- `thinking-gate/thinking-gate.py:63-74` reads `grantPolicy.mode="bounded_tool_count"` and `maxToolUses`.
- `thinking-gate/thinking-gate.py:151-174` consumes a bounded grant by issuing `BEGIN IMMEDIATE`, locating the latest successful sequential-thinking event, counting consumption rows, and inserting a consumption event.
- `thinking-gate/thinking-gate.py:186-191` now emits direct plain-English denial guidance naming the configured sequential-thinking tool and grant size.
- `thinking-gate/thinking-gate.py:205-229` gates every non-bootstrap, non-thinking tool through the bounded grant function.
- `thinking-gate/test-thinking-gate.py:185-195` currently codifies that write, read, shell inspection, and unknown tools are denied without thinking.
- `thinking-gate/test-thinking-gate.py:197-225` currently codifies bounded consumption across `maxToolUses`.

Proposal 3 changes this model intentionally. It must update both runtime and tests; it cannot be a config-only patch.

### Config Model Baseline

- `_core/config-model.mjs:630-640` validates telemetry as `hook-telemetry/log-event.py`.
- `_core/config-model.mjs:650-690` now validates memory-normalizer `match.tools` against `settings.sourceTools` and requires the expanded mutation suffix set.
- `_core/config-model.mjs:700-715` validates loop-safety and requires telemetry to remain enabled when loop-safety is enabled.
- `_core/config-model.mjs:719-753` validates thinking-gate as bounded-tool-count only and rejects future taxonomy keys such as `consumeReadOnly`, `unknownToolPolicy`, `highRiskPolicy`, `shellCompoundPolicy`, `toolClasses`, and `readOnlyShellPrefixes`.

Proposal 3 must replace that validator section with the new policy-lease schema. Proposal 6 must add live wiring validation without weakening the existing semantic validations.

### Injector Baseline

- `inject-protocol/inject-core.mjs` already exists in the current working tree.
- `inject-protocol/inject-protocol.mjs:10` imports `composeOutput` and `projectFromCwd` from `./inject-core.mjs`.
- `inject-protocol-complex/inject-protocol-complex.mjs:10` imports the same shared helpers from `../inject-protocol/inject-core.mjs`.
- A current `Compare-Object` of the two injector scripts shows they differ only by that import path.
- `inject-protocol/inject-protocol.mjs:340-341` and `inject-protocol-complex/inject-protocol-complex.mjs:340-341` still check `ENABLED` before `--self-test`, so a disabled profile can no-op instead of proving runtime health.
- `inject-protocol/recall.py`, `inject-protocol/suggest.py`, `inject-protocol-complex/recall.py`, and `inject-protocol-complex/suggest.py` already use read-only SQLite connections with `mode=ro`.

Proposal 5 is therefore not "create the first shared injector core." That has already started. Proposal 5 is "finish the consolidation by adding a shared runner/profile layer and fixing self-test ordering."

### Read-Only Database Baseline

Read-only database access has already been patched in the current tree and should not be proposed as pending broad work:

- `_core/hook_runtime.py:112-114` has `connect_readonly`.
- `inject-protocol/recall.py:60-62` and `inject-protocol/suggest.py:48-50` use `mode=ro`.
- `inject-protocol-complex/recall.py:60-62` and `inject-protocol-complex/suggest.py:48-50` use `mode=ro`.
- `memory-normalizer/normalize-memory-tags.py:21-23` uses read-only mode unless `--apply`.
- `memory-normalizer/maintain-existing-memories.py:78-80` uses read-only mode unless `--apply`.

Any future work must build on this read-only baseline rather than repeat it.

### Quality Gate Baseline

- `quality-completion-gate/quality-gate-core.mjs:126-136` reads changed files through NUL-delimited `git status --porcelain=v1 -z --untracked-files=all`.
- `quality-completion-gate/quality-gate-core.mjs:196-218` maps touched files to verify domains and returns unmatched paths.
- `quality-completion-gate/quality-gate-core.mjs:235-267` runs manifest commands synchronously through `execSync`.
- `quality-completion-gate/test-quality-gate-core.mjs:46-69` already tests NUL status parsing and unmatched changed-file behavior.
- `quality-completion-gate/quality-verify-manifest.json:213-223` includes `depcruiser-migrations/`, `hook-telemetry/`, `inject-protocol/`, `inject-protocol-complex/`, `loop-safety/`, `quality-completion-gate/`, and `thinking-gate/`.
- `quality-completion-gate/quality-verify-manifest.json:241-251` already runs config model tests, quality gate tests, injector tests, read-only SQLite tests, memory runtime checks, thinking gate tests, injector self-tests, Python compile, and Node syntax checks.

Proposal 4 must extend integrity validation; it must not re-implement NUL status parsing as if it were absent.

### Depcruiser Baseline

- `skills-catalog.md:52` currently lists `initialize-depcruiser-migrations`.
- The current working tree has tracked deletions under `depcruiser-migrations/`, including the prior `initialize-depcruiser-migrations/SKILL.md`.
- Depcruiser/OpenHands migration remains manually controlled in `#newchat` and requires explicit adjudication approval before target edits or live wiring.

Proposal 1 is therefore a containment proposal: represent depcruiser as draft/unapproved and stop stale exposure. It is not approval to reactivate depcruiser.

## Proposal 1: Capability Registry And Depcruiser Containment

### Problem

The repo has multiple capability surfaces:

- Hook definitions in `config.json`.
- Live hook wiring in `C:/Users/jwchu/.codex/config.toml`.
- Skill exposure in `skills-catalog.md`.
- Verify domains in `quality-completion-gate/quality-verify-manifest.json`.
- Script and skill files on disk.

Right now, a capability can be listed in one surface while missing or inactive in another. The clearest example is depcruiser: `skills-catalog.md` lists `initialize-depcruiser-migrations`, but the current `depcruiser-migrations/*` tracked files are deleted and the user has stated depcruiser must not be wired yet.

### Direct Solution

Add a root capability registry and a validator. The registry becomes the single place where a capability's lifecycle state is declared: `draft`, `active`, `disabled`, or `retired`.

Draft capabilities can exist in planning docs and verify manifests, but they cannot be advertised as active skills and cannot be wired into live Codex hooks.

### Files To Change

Create:

- `capabilities.json`
- `_core/validate-capabilities.mjs`
- `_core/test-capabilities.mjs`

Modify:

- `skills-catalog.md`
- `quality-completion-gate/quality-verify-manifest.json`
- `_core/validate-runtime-hooks.mjs`

Do not modify:

- `depcruiser-migrations/*` runtime behavior
- `C:/Users/jwchu/.codex/config.toml`

### Proposed `capabilities.json`

```json
{
  "$schema": "./_core/capabilities.schema.json",
  "version": 1,
  "capabilities": [
    {
      "id": "hook-telemetry",
      "kind": "hook",
      "status": "active",
      "repoConfigPath": "config.json",
      "runtimeEntrypoints": ["hook-telemetry/log-event.py"],
      "skillEntrypoints": [],
      "allowedCatalogExposure": false,
      "allowedLiveHookExposure": true,
      "verifyDomains": ["runtime"]
    },
    {
      "id": "thinking-gate",
      "kind": "hook",
      "status": "active",
      "repoConfigPath": "config.json",
      "runtimeEntrypoints": ["thinking-gate/thinking-gate.py"],
      "skillEntrypoints": [],
      "allowedCatalogExposure": false,
      "allowedLiveHookExposure": true,
      "verifyDomains": ["runtime"]
    },
    {
      "id": "inject-protocol",
      "kind": "hook",
      "status": "active",
      "repoConfigPath": "config.json",
      "runtimeEntrypoints": ["inject-protocol/inject-protocol.mjs"],
      "skillEntrypoints": [],
      "allowedCatalogExposure": false,
      "allowedLiveHookExposure": true,
      "verifyDomains": ["runtime"]
    },
    {
      "id": "initialize-depcruiser-migrations",
      "kind": "skill",
      "status": "draft",
      "repoConfigPath": null,
      "runtimeEntrypoints": [],
      "skillEntrypoints": ["depcruiser-migrations/initialize-depcruiser-migrations/SKILL.md"],
      "allowedCatalogExposure": false,
      "allowedLiveHookExposure": false,
      "verifyDomains": ["runtime"],
      "manualApprovalRequired": true,
      "manualApprovalContext": "Manual depcruiser/OpenHands workflow in #newchat"
    }
  ]
}
```

### Proposed Validator

File: `_core/validate-capabilities.mjs`

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function existsRelative(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function catalogText() {
  const catalogPath = path.join(repoRoot, 'skills-catalog.md');
  return fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : '';
}

function catalogMentionsSkill(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, 'm').test(text);
}

export function validateCapabilities({ root = repoRoot } = {}) {
  const failures = [];
  const registry = readJson('capabilities.json');
  const catalog = catalogText();

  for (const capability of registry.capabilities ?? []) {
    const status = capability.status;
    assert(
      ['draft', 'active', 'disabled', 'retired'].includes(status),
      `${capability.id}: invalid status ${status}`,
      failures
    );

    for (const runtimePath of capability.runtimeEntrypoints ?? []) {
      assert(
        existsRelative(runtimePath) || status === 'draft' || status === 'retired',
        `${capability.id}: active runtime path missing: ${runtimePath}`,
        failures
      );
    }

    for (const skillPath of capability.skillEntrypoints ?? []) {
      assert(
        existsRelative(skillPath) || status === 'draft' || status === 'retired',
        `${capability.id}: active skill path missing: ${skillPath}`,
        failures
      );
    }

    if (catalogMentionsSkill(catalog, capability.id)) {
      assert(
        capability.allowedCatalogExposure === true && status === 'active',
        `${capability.id}: catalog exposure is not allowed while status=${status}`,
        failures
      );
    }

    if (capability.allowedLiveHookExposure) {
      assert(
        status === 'active',
        `${capability.id}: live hook exposure requires active status`,
        failures
      );
    }
  }

  return failures;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const failures = validateCapabilities();
  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checked: 'capabilities' }));
}
```

### Exact Execution Plan

1. Add `_core/test-capabilities.mjs` first with failing cases:
   - A draft capability mentioned in `skills-catalog.md` fails.
   - An active runtime entrypoint missing on disk fails.
   - A draft capability can have a missing path only when it is not exposed.
2. Add `capabilities.json`.
3. Add `_core/validate-capabilities.mjs`.
4. Remove or annotate the `initialize-depcruiser-migrations` exposure from `skills-catalog.md` so it does not advertise a draft capability.
5. Add `node _core/validate-capabilities.mjs` to `quality-completion-gate/quality-verify-manifest.json` inside `repos[name=hooks].domains.runtime.commands`.
6. Optionally have `_core/validate-runtime-hooks.mjs` invoke `validate-capabilities.mjs` so manual validation and Stop-hook validation share the same check.

### Commands I Would Run

```powershell
node _core/test-capabilities.mjs
node _core/validate-capabilities.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Acceptance Criteria

- Depcruiser is explicitly modeled as draft.
- Draft depcruiser cannot be exposed in `skills-catalog.md`.
- Missing draft depcruiser files do not block the repo if they are not exposed or live-wired.
- Missing active hook files do block validation.
- Quality gate includes capability validation.

### Risks And Accepted Tradeoffs

- Risk: a capability registry can create false confidence if the quality gate does not run it. Mitigation: wire the validator into the existing `hooks` repo `runtime` domain and test that changed `_docs/`, `config.json`, and `skills-catalog.md` trigger it.
- Risk: depcruiser can be accidentally re-exposed while migration adjudication is still manual. Mitigation: keep depcruiser `status="draft"`, `allowedCatalogExposure=false`, and `allowedLiveHookExposure=false` until Jon approves the manual workflow result.
- Risk: strict validation can block edits if it treats draft missing files as active missing files. Mitigation: tests must cover draft missing paths as allowed only when both catalog and live exposure are false.

## Proposal 2: Telemetry Queue And Drain Split

### Problem

Telemetry has two current baselines that must be separated:

- Repo config still declares broad telemetry for `PostToolUse` and `PostToolUseFailure` on all tools.
- Live Codex config has already been narrowed to sequential-thinking telemetry only, as a mitigation for visible PostToolUse telemetry stalls.

The remaining problem is not "live telemetry is currently broad." The remaining problem is that the live telemetry path still performs synchronous SQLite work whenever it does fire, and repo config does not yet model the scoped live mitigation as an intentional difference.

Even when scoped to sequential-thinking events, the current `hook-telemetry/log-event.py` hot path does more than a status recorder needs to do:

- Opens SQLite for every event.
- Runs schema setup and legacy-index cleanup in the hot path.
- Inserts into `hook_events`.
- Runs optional retention deletion.
- Commits before the hook exits.

That is too much work for a hook that the UI labels as `Running PostToolUse hook: Telemetry`. It also leaves the repo-side broad telemetry declaration and live scoped telemetry behavior without a formal parity model.

### Direct Solution

Split telemetry into two paths:

- Hot path: append raw JSON events to a local queue file and exit.
- Durable path: drain queue files into SQLite outside the visible PostToolUse path.

Thinking-gate and loop-safety must retain their data source. The drain worker still writes to the same SQLite schema, but the UI-facing hook does not wait on SQLite.

The durable store must preserve the existing `hook_events` row shape from `hook-telemetry/log-event.py`. It must not replace that schema with a simplified `payload_json` table, because thinking-gate and loop-safety already depend on the current columns.

### Files To Change

Create:

- `hook-telemetry/queue-event.py`
- `hook-telemetry/drain-events.py`
- `hook-telemetry/store.py`
- `hook-telemetry/test-queue-event.py`
- `hook-telemetry/test-drain-events.py`
- `quality-completion-gate/test-telemetry-drain-trigger.mjs`

Modify:

- `hook-telemetry/log-event.py`
- `config.json`
- `quality-completion-gate/quality-completion-gate.mjs`
- `quality-completion-gate/quality-verify-manifest.json`
- Live Codex hook command only after evaluator approval.

### Proposed Hot Path

File: `hook-telemetry/queue-event.py`

```python
#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE_DIR = ROOT / ".state" / "hook-telemetry" / "queue"
MAX_EVENT_BYTES = 128_000


def read_payload() -> dict:
    raw = sys.stdin.buffer.read(MAX_EVENT_BYTES + 1)
    if len(raw) > MAX_EVENT_BYTES:
        return {
            "schemaVersion": 1,
            "event": "telemetry_truncated",
            "timestamp": int(time.time()),
            "rawBytes": len(raw),
        }
    if not raw.strip():
        return {
            "schemaVersion": 1,
            "event": "telemetry_empty",
            "timestamp": int(time.time()),
        }
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        payload = {
            "schemaVersion": 1,
            "event": "telemetry_parse_error",
            "timestamp": int(time.time()),
            "error": str(exc),
        }
    return payload


def queue_path() -> Path:
    session_id = os.environ.get("CODEX_SESSION_ID") or "unknown-session"
    safe_session = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in session_id)
    return QUEUE_DIR / f"{safe_session}.jsonl"


def append_event(payload: dict) -> None:
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "queuedAt": time.time(),
        "pid": os.getpid(),
        "payload": payload,
    }
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
    with open(queue_path(), "a", encoding="utf-8", buffering=1) as handle:
        handle.write(line)


def main() -> int:
    try:
        append_event(read_payload())
    except Exception as exc:
        # Telemetry must never block tool execution.
        sys.stderr.write(f"telemetry queue failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

### Proposed Durable Store

File: `hook-telemetry/store.py`

```python
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_core"))
from hook_runtime import connect, detect_project, extract_target, hooks_db, safe_table  # noqa: E402

SCHEMA_VERSION = 1


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
    for ix in (f"idx_{table}_event", f"idx_{table}_tool", f"idx_{table}_session"):
        con.execute(f"DROP INDEX IF EXISTS {ix}")
    if con.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
        con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def envelope_error(tool_response) -> bool:
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


def row_from_payload(payload: dict, config: dict, settings: dict) -> tuple:
    detail_max = int(settings.get("detailMaxChars", 500))
    event = payload.get("hook_event_name", "PostToolUse")
    tool_input = payload.get("tool_input", {})
    tool_response = payload.get("tool_response", payload.get("tool_result"))
    status = "error" if (event == "PostToolUseFailure" or envelope_error(tool_response)) else "ok"

    detail = ""
    if status == "error":
        source = tool_response or payload.get("error") or payload.get("tool_error") or payload.get("message")
        if source:
            detail = (source if isinstance(source, str) else json.dumps(source))[:detail_max]

    now = time.time()
    return (
        now,
        utc_iso(now),
        payload.get("session_id", ""),
        detect_project(payload.get("cwd", ""), config.get("shared", {}).get("projects", [])),
        "hook-telemetry",
        event,
        payload.get("tool_name", ""),
        extract_target(payload.get("tool_name", ""), tool_input),
        "",
        status,
        None,
        detail,
    )


def insert_event(con, table: str, row: tuple) -> int:
    cursor = con.execute(
        f"INSERT INTO {table} "
        "(ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row,
    )
    return int(cursor.lastrowid or 0)


def prune_if_needed(con, table: str, settings: dict, now: float, lastrowid: int) -> None:
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
```

### Proposed Drain Worker

File: `hook-telemetry/drain-events.py`

```python
#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_core"))
from store import connect, ensure_schema, insert_event, prune_if_needed, row_from_payload
from hook_runtime import hooks_db, load_config, safe_table

QUEUE_DIR = ROOT / ".state" / "hook-telemetry" / "queue"
BAD_DIR = ROOT / ".state" / "hook-telemetry" / "bad-events"


def drain_file(path: Path) -> tuple[int, int]:
    processed = 0
    failed = 0
    tmp_path = path.with_suffix(path.suffix + ".draining")
    try:
        os.replace(path, tmp_path)
    except FileNotFoundError:
        return 0, 0

    config = load_config()
    hook = next(h for h in config["hooks"] if h["id"] == "hook-telemetry")
    settings = hook.get("settings", {})
    table = safe_table(settings.get("table", "hook_events"), "hook_events")

    with connect(hooks_db(config)) as conn:
        ensure_schema(conn, table)
        with tmp_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                    payload = record.get("payload") or record
                    row = row_from_payload(payload, config, settings)
                    lastrowid = insert_event(conn, table, row)
                    prune_if_needed(conn, table, settings, time.time(), lastrowid)
                    processed += 1
                except Exception:
                    failed += 1
                    BAD_DIR.mkdir(parents=True, exist_ok=True)
                    with (BAD_DIR / tmp_path.name).open("a", encoding="utf-8") as bad:
                        bad.write(line)
        conn.commit()

    tmp_path.unlink(missing_ok=True)
    return processed, failed


def main() -> int:
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    processed = 0
    failed = 0
    for path in sorted(QUEUE_DIR.glob("*.jsonl")):
        p, f = drain_file(path)
        processed += p
        failed += f
    print({"ok": True, "processed": processed, "failed": failed})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

### Proposed Drain Trigger

The queue design is incomplete unless a runner invokes the drain worker. The proposed trigger is a bounded best-effort drain from the existing Stop hook, plus an explicit activation guard:

- `quality-completion-gate/quality-completion-gate.mjs` invokes `python hook-telemetry/drain-events.py --max-ms 1000 --max-events 500` before running quality verification.
- The drain trigger is best-effort and fail-open because telemetry must not block Stop-hook verification.
- Live `PostToolUse` sequential-thinking telemetry must remain on synchronous `hook-telemetry/log-event.py` until Proposal 3 moves thinking-gate off the telemetry DB, or until `queue-event.py` can prove same-event grant durability with a bounded inline drain.

Representative Stop-hook addition:

```js
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function drainTelemetryBestEffort(repoRoot) {
  const result = spawnSync('python', [
    join(repoRoot, 'hook-telemetry', 'drain-events.py'),
    '--max-ms',
    '1000',
    '--max-events',
    '500'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.slice(-2000)
  };
}
```

The quality gate must record this result as diagnostic output only. A failed drain cannot flip the Stop hook to deny, because telemetry is explicitly fail-open.

### Proposed Config Shape

File: `config.json`

```json
{
  "id": "hook-telemetry",
  "name": "Hook Telemetry Logger",
  "description": "PostToolUse + PostToolUseFailure logger. Repo declaration remains broad, live Codex may intentionally scope this hook until queue/drain rollout is approved.",
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
    "drainScript": "hook-telemetry/drain-events.py",
    "queueDir": ".state/hook-telemetry/queue",
    "statusMessage": "Queueing telemetry event"
  }
}
```

### Exact Execution Plan

1. Add tests that prove `queue-event.py` exits zero and writes one JSONL row without SQLite.
2. Add tests that prove `drain-events.py` inserts queued rows into `hook_events`.
3. Extract schema and insert logic from `log-event.py` into `store.py`.
4. Keep `log-event.py` temporarily as a compatibility wrapper that calls `store.py` directly. This preserves current live hook behavior until live wiring is explicitly changed.
5. Add bounded `--max-ms` and `--max-events` arguments to `drain-events.py`.
6. Add the Stop-hook best-effort drain trigger.
7. Change repo `config.json` to model queue and drain separately.
8. Add the telemetry and drain-trigger tests to the quality manifest.
9. Do not update live `config.toml` sequential-thinking telemetry from `log-event.py` to `queue-event.py` until the Proposal 3 thinking-gate lease model is live, or until a same-event grant durability test proves queue-event writes grant state before the next PreToolUse decision.

### Commands I Would Run

```powershell
python -B hook-telemetry/test-queue-event.py
python -B hook-telemetry/test-drain-events.py
python -B hook-telemetry/drain-events.py
node quality-completion-gate/test-telemetry-drain-trigger.mjs
python -m py_compile hook-telemetry/log-event.py hook-telemetry/queue-event.py hook-telemetry/drain-events.py hook-telemetry/store.py
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Acceptance Criteria

- Telemetry hot path does not open SQLite.
- Telemetry hot path exits zero on malformed input, empty input, and oversized input.
- Drain worker preserves the existing `hook_events` contract for thinking-gate and loop-safety.
- Stop hook invokes the drain worker with a bounded budget and treats failures as diagnostic only.
- Live sequential-thinking telemetry remains synchronous until thinking-gate is decoupled from telemetry DB grants or same-event queue durability is proven.
- Live hook status message becomes specific and short.
- No long-running PostToolUse telemetry process is required for ordinary tool status.

### Risks And Accepted Tradeoffs

- Risk: queueing telemetry before a drain trigger exists causes `hook_events` to stop updating. Mitigation: implement the Stop-hook drain trigger before any live queue-path switch.
- Risk: thinking-gate currently depends on sequential-thinking rows in `hook_events`. Mitigation: keep live sequential-thinking telemetry on synchronous `log-event.py` until Proposal 3's lease store is active or same-event grant durability is proven.
- Risk: a best-effort drain can leave backlog if Stop is rare. Mitigation: `drain-events.py` must be idempotent and bounded; backlog size should be surfaced in diagnostic output.
- Risk: a drain failure could be mistaken for a completion failure. Mitigation: drain trigger is fail-open diagnostic output only, while the quality verification commands keep exit-code authority.

## Proposal 3: Thinking Gate Policy-As-Code And Capability Leases

### Problem

Thinking-gate currently behaves like a global bounded counter:

- A successful sequential-thinking event grants a fixed number of tool uses.
- Every non-bootstrap, non-thinking tool consumes from the same pool.
- Tool risk is not first-class.
- Read-only observation and write/execute operations are treated too similarly.
- The gate repeatedly queries telemetry history in SQLite.

This explains why an agent can appear blocked in confusing ways. The gate is enforcing "some thinking happened recently" instead of enforcing a structured capability decision.

### Leading Pattern To Use

Use a Policy Enforcement Point / Policy Decision Point split with capability leases.

This is the same broad pattern used by admission controllers, capability-based security systems, and policy-as-code systems:

- The hook is the Policy Enforcement Point.
- A small policy module is the Policy Decision Point.
- Sequential thinking grants a lease with scope, risk budget, and expiry.
- Each tool request is classified into an operation class.
- The gate asks whether the active lease authorizes that class.

This is a better model than a tool-use counter because it separates:

- Observation from modification.
- Low-risk reads from high-risk execution.
- Bootstrap tool loading from ordinary work.
- Plan grants from implementation grants.

### Files To Change

Create:

- `thinking-gate/policy.py`
- `thinking-gate/leases.py`
- `thinking-gate/test-policy.py`
- `thinking-gate/test-leases.py`

Modify:

- `thinking-gate/thinking-gate.py`
- `thinking-gate/test-thinking-gate.py`
- `_core/config-model.mjs`
- `config.json`
- `quality-completion-gate/quality-verify-manifest.json`

### Proposed Policy Config

File: `config.json`

```json
{
  "id": "thinking-gate",
  "name": "Sequential Thinking Gate",
  "category": "gate",
  "event": "PreToolUse",
  "match": { "tools": ["*"] },
  "script": { "path": "thinking-gate/thinking-gate.py", "runtime": "python" },
  "enabled": true,
  "failPolicy": "open",
  "settings": {
    "table": "hook_events",
    "leaseTable": "thinking_gate_leases",
    "consumptionTable": "thinking_gate_consumptions",
    "ttlSeconds": 500,
    "grantPolicy": {
      "mode": "policy_lease_v1",
      "defaultLease": {
        "maxObserve": 30,
        "maxModify": 10,
        "maxExecute": 8,
        "maxHighRisk": 0
      },
      "toolClasses": {
        "mcp__mcp-router__sequentialthinking": "grant",
        "mcp__mcp_router__sequentialthinking": "grant",
        "ToolSearch": "bootstrap",
        "tool_search": "bootstrap",
        "Read": "observe",
        "Grep": "observe",
        "Glob": "observe",
        "LS": "observe",
        "Bash": "execute",
        "Edit": "modify",
        "Write": "modify",
        "MultiEdit": "modify",
        "apply_patch": "modify",
        "functions.shell_command": "execute",
        "functions.apply_patch": "modify",
        "web.run": "observe"
      },
      "shellPolicy": {
        "readOnlyPrefixes": ["rg", "Get-Content", "git status", "git diff", "git show"],
        "writePrefixes": ["git commit", "npm run", "python -B"],
        "dangerPrefixes": ["Remove-Item", "git reset", "git checkout --"]
      },
      "unknownToolPolicy": "require_execute",
      "unknownShellPolicy": "require_execute"
    },
    "thinkingTools": [
      "mcp__mcp_router__sequentialthinking",
      "mcp__mcp-router__sequentialthinking"
    ],
    "bootstrapTools": {
      "ToolSearch": ["sequentialthinking", "sequential thinking"]
    }
  }
}
```

### Proposed Policy Module

File: `thinking-gate/policy.py`

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Decision:
    allow: bool
    consume: bool
    bucket: str | None
    reason: str


BOOTSTRAP_TOOLS = {
    "ToolSearch",
    "tool_search",
    "mcp__mcp-router__ToolSearch",
}

GRANT_TOOLS = {
    "mcp__mcp-router__sequentialthinking",
    "mcp__mcp_router__sequentialthinking",
}


def tool_name(payload: dict[str, Any]) -> str:
    return str(payload.get("tool_name") or payload.get("toolName") or "")


def shell_command(payload: dict[str, Any]) -> str:
    args = payload.get("tool_input") or payload.get("toolInput") or {}
    if isinstance(args, dict):
        return str(args.get("command") or "")
    return ""


def classify(payload: dict[str, Any], policy: dict[str, Any]) -> str:
    name = tool_name(payload)
    if name in GRANT_TOOLS:
        return "grant"
    if name in BOOTSTRAP_TOOLS:
        return "bootstrap"

    configured = (policy.get("toolClasses") or {}).get(name)
    if configured:
        return str(configured)

    if name in {"Bash", "functions.shell_command"}:
        command = shell_command(payload)
        shell_policy = policy.get("shellPolicy") or {}
        for prefix in shell_policy.get("readOnlyPrefixes") or []:
            if command.startswith(prefix):
                return "observe"
        for prefix in shell_policy.get("dangerPrefixes") or []:
            if command.startswith(prefix):
                return "high_risk"
        return str(policy.get("unknownShellPolicy") or "require_execute")

    return str(policy.get("unknownToolPolicy") or "require_execute")


def decide(payload: dict[str, Any], lease: dict[str, Any] | None, policy: dict[str, Any]) -> Decision:
    klass = classify(payload, policy)

    if klass in {"grant", "bootstrap"}:
        return Decision(True, False, None, klass)

    if klass == "deny":
        return Decision(False, False, None, "unknown tool denied")

    if lease is None:
        return Decision(False, False, None, "no active thinking lease")

    if klass == "observe":
        return Decision(True, True, "observe", "observe allowed by lease")
    if klass in {"execute", "require_execute"}:
        return Decision(True, True, "execute", "execute allowed by lease")
    if klass == "modify":
        return Decision(True, True, "modify", "modify allowed by lease")
    if klass == "high_risk":
        if lease.get("allowHighRisk"):
            return Decision(True, True, "high_risk", "high risk allowed by lease")
        return Decision(False, False, None, "high risk requires explicit lease")

    return Decision(False, False, None, f"class {klass} is not supported")
```

### Proposed Classification Completeness Guard

The policy module must include a startup self-test that prevents accidental lockout posture without making unknown tools fatal at runtime. This is an invariant check, not a fail-closed runtime path.

File: `thinking-gate/test-policy.py`

```python
from policy import classify


KNOWN_ALWAYS_ON_TOOLS = [
    "ToolSearch",
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Bash",
    "Edit",
    "Write",
    "MultiEdit",
    "apply_patch",
]


def test_known_tools_have_explicit_classes(policy):
    for name in KNOWN_ALWAYS_ON_TOOLS:
        assert classify({"tool_name": name}, policy) in {
            "bootstrap",
            "observe",
            "modify",
            "execute",
            "high_risk",
        }


def test_unknown_tool_consumes_execute_lease_not_hard_deny(policy):
    assert classify({"tool_name": "mcp__new_server__new_tool"}, policy) == "require_execute"
```

This guard catches incomplete first-party tool coverage in tests, while the runtime remains fail-open at the hook level and does not hard-deny newly introduced MCP tools by default.

### Proposed Lease Store

File: `thinking-gate/leases.py`

```python
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / ".state" / "thinking-gate" / "leases.sqlite3"


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=0.5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=500")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS thinking_gate_leases (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL,
            status TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            budget_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS thinking_gate_consumptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lease_id TEXT NOT NULL,
            created_at REAL NOT NULL,
            bucket TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tg_leases_active ON thinking_gate_leases(session_id, status, expires_at)"
    )


def create_lease(conn: sqlite3.Connection, session_id: str, policy: dict[str, Any]) -> str:
    lease_id = str(uuid.uuid4())
    now = time.time()
    default = policy.get("defaultLease") or {}
    conn.execute(
        """
        INSERT INTO thinking_gate_leases
        (id, session_id, created_at, expires_at, status, scope_json, budget_json)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        """,
        (
            lease_id,
            session_id,
            now,
            now + float(policy.get("leaseSeconds") or 500),
            json.dumps({"session": session_id}, separators=(",", ":")),
            json.dumps(default, separators=(",", ":")),
        ),
    )
    return lease_id


def active_lease(conn: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT id, budget_json
        FROM thinking_gate_leases
        WHERE session_id = ? AND status = 'active' AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (session_id, time.time()),
    ).fetchone()
    if row is None:
        return None
    return {"id": row[0], **json.loads(row[1])}


def consume(conn: sqlite3.Connection, lease_id: str, bucket: str, payload: dict[str, Any]) -> None:
    tool = payload.get("tool_name") or payload.get("toolName") or ""
    conn.execute(
        """
        INSERT INTO thinking_gate_consumptions
        (lease_id, created_at, bucket, tool_name, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            lease_id,
            time.time(),
            bucket,
            str(tool),
            json.dumps(payload, separators=(",", ":")),
        ),
    )
```

### Proposed Hook Integration

File: `thinking-gate/thinking-gate.py`

```python
def handle(payload: dict) -> int:
    policy = load_policy()
    session_id = session_from_payload(payload)
    klass = classify(payload, policy)

    if klass == "grant":
        with connect() as conn:
            ensure_schema(conn)
            lease_id = create_lease(conn, session_id, policy)
            conn.commit()
        return emit_allow(f"thinking lease granted: {lease_id}")

    if klass == "bootstrap":
        return emit_allow("bootstrap tool allowed")

    with connect() as conn:
        ensure_schema(conn)
        lease = active_lease(conn, session_id)
        decision = decide(payload, lease, policy)
        if not decision.allow:
            return emit_block(decision.reason)
        if decision.consume and decision.bucket:
            consume(conn, lease["id"], decision.bucket, payload)
            conn.commit()
    return emit_allow(decision.reason)
```

### Config Model Changes

File: `_core/config-model.mjs`

Current validator rejects the exact fields required for this model. The change must replace the temporary rejection block with a strict accepted schema.

Representative validation:

```js
function validateThinkingGate(hook, ctx) {
  const settings = hook.settings ?? {};
  const policy = settings.grantPolicy;
  if (!policy || policy.mode !== 'policy_lease_v1') {
    ctx.errors.push('thinking-gate: settings.grantPolicy.mode must be policy_lease_v1');
    return;
  }

  requirePositiveInteger(settings.ttlSeconds, 'thinking-gate.settings.ttlSeconds', ctx);
  pushIf(errors, identifier(settings.table), 'thinking-gate settings.table must be a SQL identifier');
  pushIf(errors, identifier(settings.leaseTable), 'thinking-gate settings.leaseTable must be a SQL identifier');
  pushIf(errors, identifier(settings.consumptionTable), 'thinking-gate settings.consumptionTable must be a SQL identifier');
  validateBudget(policy.defaultLease, ctx);
  validateEnum(policy.unknownToolPolicy, ['deny', 'observe', 'modify', 'execute', 'require_execute'], 'unknownToolPolicy', ctx);
  validateEnum(policy.unknownShellPolicy, ['deny', 'observe', 'require_execute'], 'unknownShellPolicy', ctx);

  for (const [tool, klass] of Object.entries(policy.toolClasses ?? {})) {
    validateEnum(klass, ['grant', 'bootstrap', 'observe', 'modify', 'execute', 'high_risk'], `toolClasses.${tool}`, ctx);
  }
}
```

### Exact Execution Plan

1. Add `thinking-gate/test-policy.py` with failing policy classification tests.
2. Add `thinking-gate/test-leases.py` with failing active-lease and consumption tests.
3. Add `policy.py` and `leases.py`.
4. Patch `thinking-gate.py` to delegate to policy and lease modules.
5. Patch `_core/config-model.mjs` to validate the new `grantPolicy` structure.
6. Patch `config.json` to use `settings.grantPolicy.mode="policy_lease_v1"`.
7. Keep the old grant-counter behavior behind a temporary compatibility mode only if evaluator approval requires staged rollout.
8. Run focused tests, then the Stop hook self-test.

### Commands I Would Run

```powershell
python -B thinking-gate/test-policy.py
python -B thinking-gate/test-leases.py
python -B thinking-gate/test-thinking-gate.py
node quality-completion-gate/test-config-model.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Acceptance Criteria

- Sequential thinking creates a lease.
- Read-only observe tools are classified differently from modify and execute tools.
- Unknown tools default to the execute lease bucket instead of hard-denying newly introduced MCP tools.
- High-risk commands require explicit high-risk lease authority.
- The gate no longer depends on scanning telemetry history to decide whether a grant exists.
- The model is strict and validated by `_core/config-model.mjs`.

### Risks And Accepted Tradeoffs

- Risk: this changes enforcement semantics for an always-on PreToolUse gate. Mitigation: keep `failPolicy="open"` and stage rollout behind tests before live TOML changes.
- Risk: unknown MCP tools can otherwise brick editing if they are hard-denied. Mitigation: default unknown tools to `require_execute`, which still requires an active lease but avoids permanent lockout from incomplete classification.
- Risk: a policy bug can misclassify tool risk. Mitigation: add classification completeness tests for known tool names and keep high-risk shell prefixes explicit.
- Risk: moving grants from telemetry events to leases can break current sequential-thinking flow. Mitigation: run old bounded-grant tests and new lease tests side by side during migration, then cut over only after same-session sequential-thinking grant behavior is proven.

## Proposal 4: Quality Gate Capability And Integrity Checks

### Problem

The quality gate currently verifies changed-file domains and runs commands. That is necessary but not sufficient. It does not fully prove that capability declarations, catalog entries, live hook references, and runtime files are coherent.

Examples of gaps:

- A skill can be listed while its directory is missing.
- A hook can be active in `config.json` while its live command differs.
- A self-test can no-op when a profile is disabled.
- A manifest can include a prefix for a draft capability without declaring that the draft is intentionally not live.

### Direct Solution

Add integrity validation as a first-class quality domain. The gate must check cross-surface consistency before accepting changed hook files.

### Files To Change

Create:

- `quality-completion-gate/validate-integrity.mjs`
- `quality-completion-gate/test-integrity.mjs`

Modify:

- `quality-completion-gate/quality-verify-manifest.json`
- `quality-completion-gate/quality-gate-core.mjs`
- `_core/validate-runtime-hooks.mjs`

### Proposed Integrity Validator

File: `quality-completion-gate/validate-integrity.mjs`

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateCapabilities } from '../_core/validate-capabilities.mjs';

const ROOT = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function assertPath(relativePath, failures) {
  if (!fs.existsSync(path.join(ROOT, relativePath))) {
    failures.push(`missing path: ${relativePath}`);
  }
}

function validateConfigEntrypoints(failures) {
  const config = readJson('config.json');
  for (const hook of config.hooks ?? []) {
    const scriptPath = hook.script?.path;
    if (scriptPath) {
      assertPath(scriptPath, failures);
    }
    for (const extraPath of Object.values(hook.settings ?? {})) {
      if (
        typeof extraPath === 'string'
        && /^(?:_core|hook-|thinking-|inject-|memory-|quality-|loop-)/.test(extraPath)
      ) {
        assertPath(extraPath, failures);
      }
    }
  }
}

function validateManifestCommands(failures) {
  const manifest = readJson('quality-completion-gate/quality-verify-manifest.json');
  for (const repo of manifest.repos ?? []) {
    for (const [domainName, domain] of Object.entries(repo.domains ?? {})) {
      for (const command of Array.isArray(domain.commands) ? domain.commands : []) {
        if (!command.label || typeof command.label !== 'string') {
          failures.push(`${repo.name}.${domainName}: command missing label`);
        }
        if (!command.command || typeof command.command !== 'string') {
          failures.push(`${repo.name}.${domainName}: command missing command`);
        }
        if (command.maxBuffer !== undefined && (!Number.isInteger(command.maxBuffer) || command.maxBuffer < 1024 * 1024)) {
          failures.push(`${repo.name}.${domainName}.${command.label || command.command}: maxBuffer must be an integer >= 1048576`);
        }
      }
    }
  }
}

export function validateIntegrity() {
  const failures = [];
  failures.push(...validateCapabilities());
  validateConfigEntrypoints(failures);
  validateManifestCommands(failures);
  return failures;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const failures = validateIntegrity();
  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checked: 'quality-integrity' }));
}
```

### Proposed Manifest Addition

File: `quality-completion-gate/quality-verify-manifest.json`

Add this object to the existing `repos[name=hooks].domains.runtime.commands` array. Do not create a new manifest domain.

```json
{
  "label": "hooks capability and integrity validation",
  "command": "node quality-completion-gate/validate-integrity.mjs",
  "timeoutMs": 30000
}
```

### Proposed Core Change

File: `quality-completion-gate/quality-gate-core.mjs`

The current runner already returns `label`, `domain`, `command`, `cwd`, `ms`, and truncated `output`, and it already passes `maxBuffer`. Do not replace it with a runner that drops `maxBuffer`. The only proposed core-level hardening is to keep the existing shape and add tests that prove `maxBuffer` is preserved.

```js
export function runVerifyCommand(repoRoot, command, defaultTimeoutMs) {
  const cwd = command.cwd ? join(repoRoot, command.cwd) : repoRoot;
  const startedAt = Date.now();
  try {
    const output = execSync(command.command, {
      cwd,
      encoding: 'utf8',
      timeout: command.timeoutMs || defaultTimeoutMs,
      maxBuffer: command.maxBuffer || 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      ok: true,
      label: command.label || command.command,
      domain: command.domain,
      command: command.command,
      cwd,
      ms: Date.now() - startedAt,
      output: String(output || '').slice(-4000)
    };
  } catch (error) {
    return {
      ok: false,
      label: command.label || command.command,
      domain: command.domain,
      command: command.command,
      cwd,
      ms: Date.now() - startedAt,
      status: error.status ?? null,
      output: `${error.stdout || ''}${error.stderr || ''}`.slice(-4000) || error.message
    };
  }
}
```

### Exact Execution Plan

1. Add `test-integrity.mjs` with failing fixtures:
   - Missing active runtime path fails.
   - Draft skill in catalog fails.
   - Manifest `domains` object is iterated with `Object.entries`.
   - Commands require `label`, `command`, and valid optional `maxBuffer`.
   - Integrity command is placed in `repos[name=hooks].domains.runtime.commands`.
2. Add `validate-integrity.mjs`.
3. Add a regression test that proves `runVerifyCommand` passes command-specific `maxBuffer` through to `execSync`.
4. Add integrity command to the existing hooks runtime manifest domain.
5. Run existing and new quality-gate tests.

### Commands I Would Run

```powershell
node quality-completion-gate/test-integrity.mjs
node quality-completion-gate/test-quality-gate-core.mjs
node quality-completion-gate/test-config-model.mjs
node quality-completion-gate/validate-integrity.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Acceptance Criteria

- The quality gate fails if active declared files are missing.
- The quality gate fails if a draft capability is exposed.
- The integrity validator reads the real manifest shape: `repos[].domains` as an object keyed by domain name.
- The quality gate preserves per-command `maxBuffer`.
- `_docs/` remains covered by manifest rules.
- No unmatched changed file can bypass the gate.

### Risks And Accepted Tradeoffs

- Risk: a malformed integrity validator can block every hooks edit. Mitigation: test it against the real manifest shape before wiring it into `repos[name=hooks].domains.runtime.commands`.
- Risk: placing the command under a non-existent domain silently disables the check. Mitigation: update only the existing `hooks` repo `runtime` command list and add a manifest-placement test.
- Risk: dropping `maxBuffer` causes false ENOBUFS failures on large-output commands. Mitigation: preserve `command.maxBuffer || 1024 * 1024` and add a regression test for that option.
- Risk: stricter integrity checks can make draft capability work noisy. Mitigation: capability lifecycle must distinguish draft, active, disabled, and retired before integrity validation treats missing files as blockers.

## Proposal 5: Injector Profile Runner Consolidation

### Problem

`inject-protocol` and `inject-protocol-complex` duplicate most runtime code. That creates several risks:

- Fixes can land in one profile but not the other.
- Self-test behavior can diverge.
- Recall and suggestion logic can drift.
- The disabled-profile self-test path can become a no-op.

This matters because the injector is the per-prompt policy surface. If one profile is stale, prompt-level behavior becomes harder to reason about.

### Direct Solution

Finish the consolidation that has already started. `inject-core.mjs` already contains shared `projectFromCwd` and `composeOutput` helpers, and both injector scripts already import those helpers. The next step is to move the remaining duplicated runtime functions into one shared runner and make each profile a thin wrapper.

Profiles can still have distinct config entries, protocol files, recall scripts, and suggest scripts. The execution engine, self-test ordering, prompt parsing, term extraction, recall/suggest invocation, and output composition must be shared.

### Files To Change

Create:

- `inject-protocol/inject-runner.mjs`
- `inject-protocol/test-inject-runner.mjs`

Modify:

- `inject-protocol/inject-protocol.mjs`
- `inject-protocol-complex/inject-protocol-complex.mjs`
- `inject-protocol/test-inject-protocol-core.mjs`
- `quality-completion-gate/quality-verify-manifest.json`

Optional later cleanup after parity is proven:

- Consolidate `inject-protocol-complex/recall.py` into `inject-protocol/recall.py`.
- Consolidate `inject-protocol-complex/suggest.py` into `inject-protocol/suggest.py`.

### Proposed Runner

File: `inject-protocol/inject-runner.mjs`

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateConfig as validateRuntimeConfig } from '../_core/config-model.mjs';
import { composeOutput, projectFromCwd } from './inject-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function profileDir(profileId) {
  return path.join(ROOT, profileId);
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const validation = validateRuntimeConfig(config);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return config;
}

function hookEntry(config, profileId) {
  return (config.hooks || []).find((hook) => hook.id === profileId);
}

function readAll(stdin = process.stdin) {
  return new Promise((resolve) => {
    const chunks = [];
    stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stdin.resume();
  });
}

function parse(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function py(label, script, args) {
  try {
    return execFileSync('python', [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
    });
  } catch (error) {
    if (process.env.HOOK_DEBUG) {
      console.error(`${label} failed: ${error.message}`);
    }
    return '';
  }
}

function parseObjects(lines) {
  return String(lines || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function selfTest(config, hook, profileId, dir) {
  const protocolFile = hook?.sources?.protocol?.file;
  const protocolPath = protocolFile ? path.join(ROOT, protocolFile) : path.join(dir, 'per-prompt-protocol.md');
  const result = {
    ok: Boolean(hook) && fs.existsSync(protocolPath),
    profileId,
    enabled: hook?.enabled !== false,
    protocolExists: fs.existsSync(protocolPath),
    scriptPath: hook?.script?.path || null,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

async function buildInjection({ profileId, dir, config, hook, payload }) {
  // These functions are moved from the current duplicated scripts:
  // getPrompt, getCwd, extract, recentUserText, terms, recall, suggest, outputLabels.
  // They keep the current behavior, including read-only SQLite helper scripts.
  const settings = hook.settings || {};
  const shared = config.shared || {};
  const prompt = getPrompt(payload);
  const cwd = getCwd(payload);
  const project = projectFromCwd(cwd, shared.projects?.entries || shared.projects || []);
  const termText = terms(prompt, recentUserText(payload, prompt, settings.terms?.contextPrompts || 0));
  const suggested = parseObjects(py('skill suggest', path.join(dir, 'suggest.py'), [
    shared.paths.memoryDb,
    termText,
    project,
    '',
    JSON.stringify(config),
  ]));
  const memories = parseObjects(py('memory recall', path.join(dir, 'recall.py'), [
    shared.paths.memoryDb,
    termText,
    project,
    JSON.stringify(config),
  ]));
  const rules = fs.readFileSync(path.join(ROOT, hook.sources.protocol.file), 'utf8').trim();
  return composeOutput(rules, suggested, memories, outputLabels(project), settings.output?.capChars);
}

export async function runInjector({ profileId, argv = process.argv, stdin = process.stdin, stdout = process.stdout }) {
  const config = loadConfig();
  const hook = hookEntry(config, profileId);
  const dir = profileDir(profileId);

  // Current bug fix: self-test must run before the enabled check.
  if (argv.includes('--self-test')) return selfTest(config, hook, profileId, dir);

  if (!hook || hook.enabled === false) return 0;

  const payload = parse(await readAll(stdin));
  const injection = await buildInjection({ profileId, dir, config, hook, payload });
  if (injection) stdout.write(injection);
  return 0;
}
```

The snippet above intentionally references current function names that must be moved from `inject-protocol/inject-protocol.mjs`: `getPrompt`, `getCwd`, `recentUserText`, `terms`, and `outputLabels`. During implementation, those bodies are moved unchanged into `inject-runner.mjs`, then both profile scripts are reduced to wrappers. The existing `inject-core.mjs` remains the shared helper module for behavior already extracted.

### Proposed Wrappers

File: `inject-protocol/inject-protocol.mjs`

```js
#!/usr/bin/env node
import { runInjector } from './inject-runner.mjs';

runInjector({ profileId: 'inject-protocol' })
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`inject-protocol failed: ${error.message}`);
    process.exit(0);
  });
```

File: `inject-protocol-complex/inject-protocol-complex.mjs`

```js
#!/usr/bin/env node
import { runInjector } from '../inject-protocol/inject-runner.mjs';

runInjector({ profileId: 'inject-protocol-complex' })
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`inject-protocol-complex failed: ${error.message}`);
    process.exit(0);
  });
```

### Proposed Tests

File: `inject-protocol/test-inject-runner.mjs`

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(script) {
  return spawnSync('node', [script, '--self-test'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

const simple = run('inject-protocol/inject-protocol.mjs');
assert.equal(simple.status, 0);
assert.match(simple.stdout, /"profileId":"inject-protocol"/);
assert.match(simple.stdout, /"protocolExists":true/);

const complex = run('inject-protocol-complex/inject-protocol-complex.mjs');
assert.equal(complex.status, 0);
assert.match(complex.stdout, /"profileId":"inject-protocol-complex"/);
assert.match(complex.stdout, /"protocolExists":true/);

console.log(JSON.stringify({ ok: true, checked: 'inject-runner' }));
```

### Exact Execution Plan

1. Add `test-inject-runner.mjs` first and confirm both profile self-tests emit JSON.
2. Move the current duplicated functions from `inject-protocol/inject-protocol.mjs` into `inject-protocol/inject-runner.mjs`.
3. Keep the already-extracted `composeOutput` and `projectFromCwd` functions in `inject-protocol/inject-core.mjs`.
4. Replace both profile scripts with wrappers.
5. Keep profile-specific protocol files and Python helper scripts in place.
6. Keep Python helper consolidation as a separate follow-up unless evaluator approves it in the same batch.
7. Add the runner test to the quality manifest.

### Commands I Would Run

```powershell
node inject-protocol/test-inject-runner.mjs
node inject-protocol/test-inject-protocol-core.mjs
node inject-protocol/inject-protocol.mjs --self-test
node inject-protocol-complex/inject-protocol-complex.mjs --self-test
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Acceptance Criteria

- Both profile wrappers call the same runner.
- Both profile self-tests emit JSON, even if a profile is disabled for ordinary injection.
- Existing injection output remains unchanged for the active profile.
- Complex profile drift is eliminated at the runtime layer.

### Risks And Accepted Tradeoffs

- Risk: moving duplicated runtime functions can subtly change prompt parsing or output truncation. Mitigation: move bodies unchanged first, then run existing core tests and both profile self-tests before any cleanup.
- Risk: profile-specific behavior can be accidentally flattened. Mitigation: keep distinct config entries, protocol files, recall scripts, and suggest scripts until parity tests prove consolidation is safe.
- Risk: wrapper fail-open behavior can hide a runtime exception. Mitigation: self-tests must execute before enabled checks and emit JSON health for both profiles.
- Risk: helper consolidation can race with active per-prompt behavior. Mitigation: do not change live `config.toml`; keep the active wrapper path stable.

## Proposal 6: Config Source Of Truth And Live Wiring Parity

### Problem

The repo has a declarative `config.json`, but live behavior comes from `C:/Users/jwchu/.codex/config.toml`. These can differ. In fact, current live config wires a narrower telemetry hook than repo `config.json` describes.

That drift is not automatically bad. Some differences are intentional. The problem is that the repo does not have a first-class way to declare which differences are expected.

### Direct Solution

Add a live wiring model to `config.json` and validate it against the live Codex TOML. The model must distinguish:

- Repo-declared desired hooks.
- Live required hooks.
- Live intentionally absent hooks.
- Draft hooks that must not be live.

### Files To Change

Create:

- `_core/live-config-model.mjs`
- `_core/validate-live-hooks.mjs`
- `_core/test-live-hooks.mjs`

Modify:

- `config.json`
- `_core/config-model.mjs`
- `_core/validate-runtime-hooks.mjs`
- `quality-completion-gate/quality-verify-manifest.json`

Do not automatically modify:

- `C:/Users/jwchu/.codex/config.toml`

Live config changes must be a separate explicit approval step because they affect all Codex sessions.

### Proposed Config Shape

File: `config.json`

```json
{
  "liveWiring": {
    "codexToml": "C:/Users/jwchu/.codex/config.toml",
    "hooks": [
      {
        "id": "inject-protocol",
        "event": "UserPromptSubmit",
        "required": true,
        "matcher": null,
        "commandContains": ["node", "E:/hooks/inject-protocol/inject-protocol.mjs"],
        "timeoutSeconds": 10
      },
      {
        "id": "quality-completion-gate",
        "event": "Stop",
        "required": true,
        "matcher": null,
        "commandContains": ["node", "E:/hooks/quality-completion-gate/quality-completion-gate.mjs"],
        "timeoutSeconds": 180
      },
      {
        "id": "hook-telemetry",
        "event": "PostToolUse",
        "required": true,
        "matcher": "mcp__mcp-router__sequentialthinking",
        "commandContains": ["python", "E:/hooks/hook-telemetry/log-event.py"],
        "timeoutSeconds": 10,
        "intentionalDifference": "Live telemetry currently records sequential-thinking grants only."
      },
      {
        "id": "initialize-depcruiser-migrations",
        "event": "PreToolUse",
        "required": false,
        "mustBeAbsent": true,
        "manualApprovalRequired": true
      }
    ]
  }
}
```

### Proposed TOML Reader

File: `_core/live-config-model.mjs`

The validator only needs the hook blocks, so it can use a small parser instead of adding a dependency.

```js
import fs from 'node:fs';

export function parseCodexHookBlocks(tomlText) {
  const hooks = [];
  let current = null;

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const block = line.match(/^\[\[hooks\.([A-Za-z0-9_]+)\]\]$/);
    if (block) {
      current = { event: block[1], raw: [] };
      hooks.push(current);
      continue;
    }
    if (!current || line.startsWith('#') || line === '') continue;
    current.raw.push(line);

    const scalar = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/);
    if (scalar) {
      current[scalar[1]] = scalar[2];
      continue;
    }

    const number = line.match(/^([A-Za-z0-9_]+)\s*=\s*(\d+)$/);
    if (number) {
      current[number[1]] = Number(number[2]);
      continue;
    }
  }

  return hooks;
}

export function readCodexHooks(configPath) {
  return parseCodexHookBlocks(fs.readFileSync(configPath, 'utf8'));
}
```

### Proposed Validator

File: `_core/validate-live-hooks.mjs`

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readCodexHooks } from './live-config-model.mjs';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

function hookMatches(actual, expected) {
  if (actual.event !== expected.event) return false;
  if (expected.matcher !== undefined && expected.matcher !== null && actual.matcher !== expected.matcher) {
    return false;
  }
  const raw = actual.raw.join('\n');
  for (const token of expected.commandContains ?? []) {
    if (!raw.includes(token)) return false;
  }
  if (expected.timeoutSeconds !== undefined && actual.timeout_sec !== expected.timeoutSeconds) {
    return false;
  }
  return true;
}

function validate() {
  const live = config.liveWiring;
  const failures = [];
  if (!live) return ['config.json: liveWiring is missing'];

  const hooks = readCodexHooks(live.codexToml);
  for (const expected of live.hooks ?? []) {
    const matches = hooks.filter((actual) => hookMatches(actual, expected));
    if (expected.mustBeAbsent && matches.length > 0) {
      failures.push(`${expected.id}: must be absent from live Codex config`);
    }
    if (expected.required && matches.length === 0) {
      failures.push(`${expected.id}: required live hook not found`);
    }
    if (!expected.required && !expected.mustBeAbsent && !expected.intentionalDifference) {
      failures.push(`${expected.id}: non-required live hook needs an intentionalDifference note`);
    }
  }
  return failures;
}

const failures = validate();
if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: 'live-hooks' }));
```

### Exact Execution Plan

1. Add parser tests in `_core/test-live-hooks.mjs`.
2. Add live wiring config with the current live differences explicitly documented.
3. Add `_core/live-config-model.mjs`.
4. Add `_core/validate-live-hooks.mjs`.
5. Extend `_core/config-model.mjs` to validate `liveWiring` shape.
6. Extend `_core/validate-runtime-hooks.mjs` to run live validation when the TOML path exists.
7. Add live validation command to the quality manifest.

### Commands I Would Run

```powershell
node _core/test-live-hooks.mjs
node _core/validate-live-hooks.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Acceptance Criteria

- Live Codex hooks are validated against repo expectations.
- Intentional live differences are explicit in `config.json`.
- Draft depcruiser must be absent from live config.
- The validator fails if a required live hook command, matcher, or timeout drifts.
- Live config is not edited unless Jon approves that separate step.

### Risks And Accepted Tradeoffs

- Risk: live TOML parsing can be too narrow and miss a valid hook shape. Mitigation: scope the parser to current Codex hook blocks, test against `C:/Users/jwchu/.codex/config.toml`, and treat unsupported TOML shapes as explicit validation failures.
- Risk: validating a user-local live config can make repo checks machine-specific. Mitigation: run live validation only when the configured TOML path exists and document intentional local differences.
- Risk: a live drift validator can block planned temporary mitigations. Mitigation: require `intentionalDifference` notes for approved divergences such as scoped telemetry.
- Risk: depcruiser can be wired accidentally through live config. Mitigation: `mustBeAbsent` entries fail validation if draft/manual capabilities appear in live hooks.

## Cross-Proposal Implementation Sequence

### Phase 0: Evaluator Approval

No code changes beyond this proposal document.

Evaluator decisions needed:

- Confirm depcruiser must be modeled as draft and not live-wired.
- Confirm live config parity validation can read `C:/Users/jwchu/.codex/config.toml`.
- Confirm telemetry can move from direct SQLite logging to queue plus drain.
- Confirm thinking-gate can move from counter grants to policy leases.
- Confirm injector consolidation can keep two profile directories while sharing one runner.

### Phase 1: Registry And Integrity

Implement proposals 1 and 4 together because integrity validation depends on the registry.

Primary files:

- `capabilities.json`
- `_core/validate-capabilities.mjs`
- `_core/test-capabilities.mjs`
- `quality-completion-gate/validate-integrity.mjs`
- `quality-completion-gate/test-integrity.mjs`
- `quality-completion-gate/quality-verify-manifest.json`
- `skills-catalog.md`

Verification:

```powershell
node _core/test-capabilities.mjs
node quality-completion-gate/test-integrity.mjs
node _core/validate-capabilities.mjs
node quality-completion-gate/validate-integrity.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Phase 2: Live Wiring Parity

Implement proposal 6 after registry exists.

Primary files:

- `_core/live-config-model.mjs`
- `_core/validate-live-hooks.mjs`
- `_core/test-live-hooks.mjs`
- `config.json`
- `_core/config-model.mjs`
- `_core/validate-runtime-hooks.mjs`

Verification:

```powershell
node _core/test-live-hooks.mjs
node _core/validate-live-hooks.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Phase 3: Telemetry Queue

Implement proposal 2 with compatibility wrapper first. Do not change live TOML until tests pass, the Stop-hook drain trigger exists, and evaluator approval is explicit.

Activation guard: live sequential-thinking telemetry must stay on synchronous `hook-telemetry/log-event.py` until Proposal 3 decouples thinking-gate from `hook_events`, or until queue-event proves same-event grant durability with a test that exercises sequential-thinking PostToolUse followed by a gated PreToolUse decision.

Primary files:

- `hook-telemetry/queue-event.py`
- `hook-telemetry/drain-events.py`
- `hook-telemetry/store.py`
- `hook-telemetry/log-event.py`
- `hook-telemetry/test-queue-event.py`
- `hook-telemetry/test-drain-events.py`
- `quality-completion-gate/quality-completion-gate.mjs`
- `quality-completion-gate/test-telemetry-drain-trigger.mjs`
- `config.json`

Verification:

```powershell
python -B hook-telemetry/test-queue-event.py
python -B hook-telemetry/test-drain-events.py
python -B hook-telemetry/drain-events.py
node quality-completion-gate/test-telemetry-drain-trigger.mjs
python -m py_compile hook-telemetry/log-event.py hook-telemetry/queue-event.py hook-telemetry/drain-events.py hook-telemetry/store.py
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Phase 4: Injector Consolidation

Implement proposal 5 after telemetry because injector self-tests are already in the quality surface and should stay stable.

Primary files:

- `inject-protocol/inject-runner.mjs`
- `inject-protocol/inject-protocol.mjs`
- `inject-protocol-complex/inject-protocol-complex.mjs`
- `inject-protocol/test-inject-runner.mjs`
- `quality-completion-gate/quality-verify-manifest.json`

Verification:

```powershell
node inject-protocol/test-inject-runner.mjs
node inject-protocol/test-inject-protocol-core.mjs
node inject-protocol/inject-protocol.mjs --self-test
node inject-protocol-complex/inject-protocol-complex.mjs --self-test
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

### Phase 5: Thinking-Gate Policy Leases

Implement proposal 3 last because it changes enforcement semantics for all tools.

Primary files:

- `thinking-gate/policy.py`
- `thinking-gate/leases.py`
- `thinking-gate/thinking-gate.py`
- `thinking-gate/test-policy.py`
- `thinking-gate/test-leases.py`
- `thinking-gate/test-thinking-gate.py`
- `_core/config-model.mjs`
- `config.json`

Verification:

```powershell
python -B thinking-gate/test-policy.py
python -B thinking-gate/test-leases.py
python -B thinking-gate/test-thinking-gate.py
node quality-completion-gate/test-config-model.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

## Rollback Plan

Each phase must be separately revertible.

- Registry and integrity rollback: remove `capabilities.json`, validators, manifest command, and restore `skills-catalog.md` entries.
- Live wiring rollback: remove `liveWiring` from `config.json` and remove live validators from manifest.
- Telemetry rollback: keep `log-event.py` direct SQLite behavior and leave live TOML unchanged.
- Injector rollback: restore profile scripts from the prior commit and remove runner tests.
- Thinking-gate rollback: restore the counter-based grant logic and the prior config-model validation.

Rollback must not use `git reset --hard` or `git checkout --` while the tree contains unrelated user changes. Use targeted patches only.

## Final Verification Bundle For Full Implementation

After all approved phases are implemented, run:

```powershell
node _core/test-capabilities.mjs
node _core/test-live-hooks.mjs
node _core/validate-capabilities.mjs
node _core/validate-live-hooks.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
node quality-completion-gate/test-quality-gate-core.mjs
node quality-completion-gate/test-integrity.mjs
node quality-completion-gate/test-telemetry-drain-trigger.mjs
node quality-completion-gate/validate-integrity.mjs
node inject-protocol/test-inject-protocol-core.mjs
node inject-protocol/test-inject-runner.mjs
python -B hook-telemetry/test-queue-event.py
python -B hook-telemetry/test-drain-events.py
python -B memory-normalizer/test-memory-runtime.py
python -B thinking-gate/test-policy.py
python -B thinking-gate/test-leases.py
python -B thinking-gate/test-thinking-gate.py
node quality-completion-gate/quality-completion-gate.mjs --self-test
git diff --check
```

## Evaluator Review Checklist

Human evaluators should verify:

- The depcruiser proposal respects the manual workflow and does not wire depcruiser live.
- The telemetry queue preserves the data contract required by thinking-gate and loop-safety.
- The thinking-gate model improves correctness without making read-only repo investigation unnecessarily expensive.
- The quality gate now checks cross-surface integrity, not only command execution.
- The injector consolidation removes duplicated runtime logic without merging policy profiles prematurely.
- The live wiring model documents current live differences instead of pretending repo config and live config are identical.
- Each phase has focused tests, rollback, and explicit acceptance criteria.
