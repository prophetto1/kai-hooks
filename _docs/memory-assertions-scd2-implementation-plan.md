# Memory Assertions SCD2 Implementation Plan

Status: draft for Jon review
Author: Codex
Date: 2026-06-03
Target repo: `E:/hooks`

## Goal

Replace ad hoc `legacy` / `stale` memory handling with temporal assertion state:
current recall returns only assertions with `valid_to IS NULL`, and historical recall can
query the assertion state as of a point in time.

## Sources checked

| Source | Finding used |
| --- | --- |
| Microsoft SQL Server temporal tables | Current rows plus history rows use `ValidFrom` / `ValidTo`; `AS OF` resolves rows where start <= time and end > time. |
| MariaDB system-versioned tables | SQL:2011 system-versioned tables use period columns and support `FOR SYSTEM_TIME AS OF/BETWEEN/ALL`. |
| dbt snapshots | Type 2 snapshots keep `dbt_valid_from` / `dbt_valid_to`; changed rows close the old record and insert the new current record. |
| `E:/hooks/config.json` | Memory recall is driven by `inject-protocol` settings and allowlisted memory filters. |
| `inject-protocol/recall.py` | Current recall joins `memory_content_fts` to `memories` and filters by injected SQL predicates. |
| `memory-normalizer/normalize-after-store.py` | PostToolUse memory mutation hook already resolves affected memory rows and updates safe metadata columns. |
| `memory-normalizer/maintain-existing-memories.py` | Maintenance script already audits active rows and can host backfill/dry-run logic. |
| `memory-normalizer/test-memory-runtime.py` | Runtime smoke owns memory DB shape, recall, and normalizer checks. |

Reference links:
- https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables
- https://mariadb.com/docs/server/reference/sql-structure/temporal-tables/system-versioned-tables
- https://docs.getdbt.com/docs/build/snapshots
- https://docs.getdbt.com/reference/resource-configs/snapshot_meta_column_names

## Current repo reality

- Live memory DB path is `shared.paths.memoryDb`: `E:/memory/memory-sqlite.db`.
- `memories` columns are: `id`, `content_hash`, `content`, `tags`, `memory_type`,
  `metadata`, `created_at`, `updated_at`, `created_at_iso`, `updated_at_iso`,
  `deleted_at`, `parent_id`, `version`, `confidence`, `last_accessed`,
  `superseded_by`.
- `memory_content_fts` has only `content`; recall joins it to `memories` on rowid/id.
- Current recall filters are allowlisted in `_core/config-model.mjs` as:
  `not-deleted`, `not-superseded`.
- `normalize-after-store.py` is the right write-path integration point because the MCP
  memory tools own the actual insert/update, and the hook sees the committed row after
  success.

## Architecture

Add a materialized temporal assertion table beside `memories`:

```sql
CREATE TABLE IF NOT EXISTS memory_assertions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assertion_key TEXT NOT NULL,
  memory_id INTEGER,
  memory_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'historical')),
  valid_from REAL NOT NULL,
  valid_from_iso TEXT NOT NULL,
  valid_to REAL,
  valid_to_iso TEXT,
  replaced_by_hash TEXT,
  rule_id TEXT NOT NULL,
  created_at REAL NOT NULL,
  created_at_iso TEXT NOT NULL,
  updated_at REAL NOT NULL,
  updated_at_iso TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_assertions_current
  ON memory_assertions(assertion_key)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS ix_memory_assertions_hash
  ON memory_assertions(memory_hash);

CREATE INDEX IF NOT EXISTS ix_memory_assertions_as_of
  ON memory_assertions(assertion_key, valid_from, valid_to);
```

Default recall adds this predicate after backfill:

```sql
EXISTS (
  SELECT 1
  FROM memory_assertions a
  WHERE a.memory_hash = m.content_hash
    AND a.status = 'current'
    AND a.valid_to IS NULL
)
```

Historical recall uses:

```sql
a.valid_from <= :as_of
AND (a.valid_to IS NULL OR a.valid_to > :as_of)
```

## Assertion key rule

Create deterministic keys conservatively. Do not collapse memories unless the key is
explicit enough.

Key format:

```text
v1:<project-or-all>:<memory_type>:<entity-kind>:<normalized-entity>
```

Entity derivation order:

1. Explicit repo/file/path token from content or metadata.
2. Explicit URL/port/service identifier.
3. Named project slug from configured `shared.projects`.
4. Exact correction context from mistake-note metadata.
5. Fallback unique key: `v1:<project>:<memory_type>:hash:<content_fingerprint>`.

Only keys from rules 1-4 can close an older current assertion. Rule 5 is intentionally
unique and must not supersede another memory.

## Replacement rule

When a new row is normalized:

1. Derive `assertion_key`.
2. Find current assertion rows with the same key.
3. If no current row exists, insert the new row as `status='current'`.
4. If the current row has the same `memory_hash`, keep it current and update only
   assertion metadata if needed.
5. If a different current row exists and the new row passes the closure policy:
   - set old `valid_to = now`
   - set old `valid_to_iso = now_iso`
   - set old `status = 'historical'`
   - set old `replaced_by_hash = new_hash`
   - insert the new row with `valid_from = now`, `valid_to = NULL`,
     `status = 'current'`

Closure policy:

- Same `assertion_key`.
- New row is active in `memories` (`deleted_at IS NULL`).
- New row is not already superseded by the old `memories.superseded_by` field.
- Assertion key confidence is explicit, not fallback hash.
- New row is newer by `created_at` or produced by a correction/update tool.

No memory rows are deleted. Existing `memories.superseded_by` remains backward-compatible
until recall is fully switched to `memory_assertions`.

## Atomic implementation phases

### Phase 1 - Schema and lifecycle helper

**Step 1.1 - Add lifecycle tests**
- Create: `memory-normalizer/test-assertion-lifecycle.py`.
- Cover: table creation, deterministic key derivation, current insert, same-hash
  idempotence, replacement closing the old row, fallback-hash key not closing anything,
  and `as_of` query semantics.
- Run: `python memory-normalizer/test-assertion-lifecycle.py`.
- Expected first result: fail because helper does not exist.

**Step 1.2 - Add lifecycle helper**
- Create: `memory-normalizer/assertion_lifecycle.py`.
- Implement:
  - `ensure_assertion_schema(con)`
  - `derive_assertion_key(row, retain, config)`
  - `upsert_assertion(con, row, retain, config, payload, now)`
  - `current_assertion_predicate(alias='m')`
  - `as_of_assertion_predicate(alias='m')`
- Boundary: helper writes only `memory_assertions`, never `memories`, FTS, or vector rows.

**Step 1.3 - Verify helper**
- Run: `python memory-normalizer/test-assertion-lifecycle.py`.
- Run: `python -m py_compile memory-normalizer/assertion_lifecycle.py memory-normalizer/test-assertion-lifecycle.py`.

### Phase 2 - PostToolUse normalizer integration

**Step 2.1 - Extend normalizer self-test first**
- Modify: `memory-normalizer/normalize-after-store.py`.
- Add self-test fixtures for two memories with the same explicit assertion key.
- Expected red check: second write does not close the first assertion yet.

**Step 2.2 - Wire lifecycle helper into normalizer**
- Modify: `memory-normalizer/normalize-after-store.py`.
- After `update_memory_row(...)`, call `upsert_assertion(...)` for each resolved row.
- Keep existing memory metadata behavior unchanged.
- Boundary: `memory_delete` remains audit-only for now; it must not hard-delete assertions.

**Step 2.3 - Add audit details**
- Modify: normalizer result payload to include:
  - `assertionKey`
  - `assertionDecision`: `inserted-current`, `closed-and-inserted`, `unchanged`,
    `fallback-unique`, or `skipped`
  - `closedHash`, when applicable.
- Existing hook_events audit path remains the visibility surface.

**Step 2.4 - Verify normalizer**
- Run: `python memory-normalizer/normalize-after-store.py --self-test`.
- Run: `python memory-normalizer/test-assertion-lifecycle.py`.

### Phase 3 - Maintenance/backfill integration

**Step 3.1 - Add dry-run assertion audit**
- Modify: `memory-normalizer/maintain-existing-memories.py`.
- Add flags:
  - `--assertions`
  - `--apply-assertions`
  - `--as-of <iso-or-epoch>` for reporting only.
- Dry run reports:
  - rows missing assertion records
  - explicit-key groups that would close older rows
  - fallback-unique rows
  - current conflicts that require manual review.

**Step 3.2 - Add backfill apply**
- Modify: `memory-normalizer/maintain-existing-memories.py`.
- `--apply-assertions` creates `memory_assertions` and backfills active rows.
- Boundary: no deletes, no content mutation, no FTS/vector mutation.

**Step 3.3 - Verify maintenance**
- Run: `python memory-normalizer/maintain-existing-memories.py --self-test`.
- Run dry-run on live DB: `python memory-normalizer/maintain-existing-memories.py --assertions --json`.
- Do not run `--apply-assertions` on live DB until Jon approves the dry-run counts.

### Phase 4 - Recall integration

**Step 4.1 - Add config-model filter id**
- Modify: `_core/config-model.mjs`.
- Add allowlisted filter id: `current-assertion`.
- Regenerate: `node _core/generate-config-schema.mjs`.

**Step 4.2 - Add filter SQL in injectors**
- Modify:
  - `inject-protocol/inject-protocol.mjs`
  - `inject-protocol-complex/inject-protocol-complex.mjs`
- Add `MEMORY_FILTER_SQL.current-assertion` using the current assertion predicate.
- Boundary: do not remove `not-deleted` until temporal recall is proven.

**Step 4.3 - Switch config after backfill**
- Modify: `config.json`.
- Replace `not-superseded` with `current-assertion` only after the live DB has a
  complete assertion backfill.
- Keep `not-deleted`.

**Step 4.4 - Add historical recall path**
- Modify: `inject-protocol/recall.py` and `inject-protocol-complex/recall.py`.
- Keep the existing 4-arg default current recall path.
- Add optional config field or fifth arg for `asOf`.
- Historical mode uses the as-of predicate and is manual/debug only; per-prompt recall
  remains current-only.

**Step 4.5 - Verify recall**
- Run: `python memory-normalizer/test-memory-runtime.py`.
- Run: `node _core/validate-runtime-hooks.mjs`.
- Run: `node quality-completion-gate/test-config-model.mjs`.
- Run: `node inject-protocol/inject-protocol.mjs --self-test`.

### Phase 5 - Runtime manifest and full verification

**Step 5.1 - Update quality manifest**
- Modify: `quality-completion-gate/quality-verify-manifest.json`.
- Add new assertion lifecycle test and compile targets.

**Step 5.2 - Full verification**
- Run:
  - `python memory-normalizer/test-assertion-lifecycle.py`
  - `python memory-normalizer/normalize-after-store.py --self-test`
  - `python memory-normalizer/maintain-existing-memories.py --self-test`
  - `python memory-normalizer/test-memory-runtime.py`
  - `node _core/generate-config-schema.mjs`
  - `node _core/validate-runtime-hooks.mjs`
  - `node quality-completion-gate/test-config-model.mjs`
  - `node inject-protocol/inject-protocol.mjs --self-test`
  - `python -m py_compile _core/hook_runtime.py memory-normalizer/memory_retain.py memory-normalizer/assertion_lifecycle.py memory-normalizer/normalize-after-store.py memory-normalizer/maintain-existing-memories.py memory-normalizer/test-assertion-lifecycle.py memory-normalizer/test-memory-runtime.py inject-protocol/recall.py inject-protocol-complex/recall.py`

## Rollout checkpoints

1. Land helper and tests with no live DB mutation.
2. Land normalizer integration and self-tests with temp DB only.
3. Run live dry-run assertion audit and review counts with Jon.
4. Apply backfill only after Jon approves the counts.
5. Switch recall config to `current-assertion`.
6. Keep `memories.superseded_by` filters available for rollback until temporal recall has
   passed live prompt recall checks.

## Rollback

Rollback is config-first:

1. Change `config.json` memory filters back to `not-deleted` + `not-superseded`.
2. Regenerate schema only if filter ids changed.
3. Leave `memory_assertions` in place; it is additive history and does not affect recall
   unless the filter is enabled.

No destructive memory deletes are part of this plan.

## Open decisions for Jon

1. Whether to allow automatic closure for explicit path/entity keys on first rollout, or
   start with backfill-only plus manual review candidates.
2. Whether `memory_delete` should close assertion rows as historical in v1, or remain
   audit-only until the current recall path is proven.
3. Whether historical recall needs a user-facing command now, or only a maintenance/debug
   path in v1.

## Required code-writeup contract

This plan is not implementation-ready unless this section stays complete:

1. Every new file must be represented as full code in a unified diff.
2. Every existing file change must be represented as an exact unified diff.
3. Every new file must have subfeature-level explanations at about 10-15 lines per unit.
4. Every modified file must explain why each change is necessary.
5. The implementation must not create hidden runtime behavior outside these patches.

## Files the proposed plan would create

| # | File path | What the file does |
| ---: | --- | --- |
| 1 | `memory-normalizer/assertion_lifecycle.py` | Owns the SCD2 assertion table, deterministic assertion keys, current-row upsert, historical close, and current/as-of recall predicates. |
| 2 | `memory-normalizer/test-assertion-lifecycle.py` | Runs dependency-free lifecycle tests against a temp SQLite DB before any live memory DB mutation is allowed. |

## Files the proposed plan would modify

| # | File path | Why it changes |
| ---: | --- | --- |
| 1 | `memory-normalizer/normalize-after-store.py` | Calls assertion lifecycle upsert after each successful memory normalization and audits assertion decisions. |
| 2 | `memory-normalizer/maintain-existing-memories.py` | Adds dry-run/backfill reporting and optional approved assertion backfill for existing rows. |
| 3 | `inject-protocol/recall.py` | Supports optional historical/as-of recall while preserving the current 4-argument default path. |
| 4 | `inject-protocol-complex/recall.py` | Mirrors the standard recall behavior for the disabled complex profile. |
| 5 | `inject-protocol/inject-protocol.mjs` | Adds an allowlisted SQL predicate for current assertion filtering. |
| 6 | `inject-protocol-complex/inject-protocol-complex.mjs` | Mirrors the standard injector filter for the disabled complex profile. |
| 7 | `_core/config-model.mjs` | Adds `current-assertion` to the only legal recall filter IDs. |
| 8 | `quality-completion-gate/test-config-model.mjs` | Proves the new filter is accepted and unknown filters still fail. |
| 9 | `memory-normalizer/test-memory-runtime.py` | Makes the runtime smoke aware of `memory_assertions` and the new filter SQL. |
| 10 | `quality-completion-gate/quality-verify-manifest.json` | Adds the new lifecycle test and py_compile targets to the hook repo Stop gate. |
| 11 | `config.schema.json` | Generated output from `_core/config-model.mjs`; reflects the new enum value. |
| 12 | `config.json` | Post-backfill switch from `not-superseded` to `current-assertion`; this is applied only after Jon approves backfill counts. |

## Exact implementation patch

Apply this patch only after Jon approves the plan.

```diff
diff --git a/memory-normalizer/assertion_lifecycle.py b/memory-normalizer/assertion_lifecycle.py
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/memory-normalizer/assertion_lifecycle.py
@@
+#!/usr/bin/env python
+"""Temporal assertion lifecycle for memory rows.
+
+This module stores materialized SCD Type 2 state beside the MCP memory table.
+It never mutates memory content, vector rows, or FTS rows.
+"""
+from __future__ import annotations
+
+import json
+import re
+import sqlite3
+import time
+from datetime import datetime, timezone
+from typing import Any
+
+STATUS_CURRENT = "current"
+STATUS_HISTORICAL = "historical"
+RULE_VERSION = "assertion-key-v1"
+PATH_RE = re.compile(r"\b[A-Za-z]:/[A-Za-z0-9_./~ -]+|\b(?:apps|services|governance|memory-normalizer|inject-protocol|_core|quality-completion-gate)/[A-Za-z0-9_./-]+")
+URL_RE = re.compile(r"\bhttps?://[^\s)>\"]+")
+PORT_RE = re.compile(r"\b(?:localhost|127\.0\.0\.1):\d{2,5}\b")
+WORD_RE = re.compile(r"[^a-z0-9_.:/-]+")
+
+
+def utc_iso(ts: float | None = None) -> str:
+    stamp = time.time() if ts is None else ts
+    return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
+
+
+def parse_metadata(raw: Any) -> dict[str, Any]:
+    if isinstance(raw, dict):
+        return dict(raw)
+    if not raw:
+        return {}
+    if isinstance(raw, str):
+        try:
+            parsed = json.loads(raw)
+            return parsed if isinstance(parsed, dict) else {}
+        except Exception:
+            return {"legacy_metadata": raw}
+    return {"legacy_metadata": str(raw)}
+
+
+def normalize_entity(value: str) -> str:
+    value = value.replace("\\", "/").strip().lower()
+    value = WORD_RE.sub("-", value).strip("-")
+    while "--" in value:
+        value = value.replace("--", "-")
+    return value[:180] or "unknown"
+
+
+def tags_for_row(row: sqlite3.Row) -> list[str]:
+    return [part.strip() for part in str(row["tags"] or "").split(",") if part.strip()]
+
+
+def project_for_row(row: sqlite3.Row, config: dict[str, Any]) -> str:
+    tags = set(tags_for_row(row))
+    configured = [project.get("slug", "") for project in config.get("shared", {}).get("projects", [])]
+    for slug in configured:
+        if slug in tags:
+            return slug
+    if config.get("shared", {}).get("memoryTags", {}).get("crossProjectTag", "all") in tags:
+        return "all"
+    return "all"
+
+
+def first_match(pattern: re.Pattern[str], text: str) -> str:
+    match = pattern.search(text or "")
+    return match.group(0) if match else ""
+
+
+def mistake_context(metadata: dict[str, Any]) -> str:
+    for key in ("context_signature", "error_pattern", "correct_action"):
+        value = metadata.get(key)
+        if isinstance(value, str) and value.strip():
+            return value
+    note = metadata.get("mistake_note")
+    if isinstance(note, dict):
+        for key in ("context_signature", "error_pattern", "correct_action"):
+            value = note.get(key)
+            if isinstance(value, str) and value.strip():
+                return value
+    return ""
+
+
+def derive_assertion_key(row: sqlite3.Row, retain: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
+    metadata = parse_metadata(row["metadata"])
+    content = row["content"] or ""
+    project = project_for_row(row, config)
+    memory_type = retain.get("memory_type") or row["memory_type"] or "observation"
+
+    path = first_match(PATH_RE, content)
+    if path:
+        entity_kind = "path"
+        entity = path
+        confidence = "explicit"
+    else:
+        url = first_match(URL_RE, content) or first_match(PORT_RE, content)
+        if url:
+            entity_kind = "url"
+            entity = url
+            confidence = "explicit"
+        else:
+            mistake = mistake_context(metadata)
+            if mistake:
+                entity_kind = "mistake"
+                entity = mistake
+                confidence = "explicit"
+            else:
+                entity_kind = "hash"
+                entity = retain["content_fingerprint"]
+                confidence = "fallback"
+
+    assertion_key = f"v1:{project}:{memory_type}:{entity_kind}:{normalize_entity(entity)}"
+    return {
+        "assertion_key": assertion_key,
+        "project": project,
+        "memory_type": memory_type,
+        "entity_kind": entity_kind,
+        "entity": entity,
+        "confidence": confidence,
+        "rule_id": RULE_VERSION,
+    }
+
+
+def ensure_assertion_schema(con: sqlite3.Connection) -> None:
+    con.executescript(
+        """
+CREATE TABLE IF NOT EXISTS memory_assertions (
+  id INTEGER PRIMARY KEY AUTOINCREMENT,
+  assertion_key TEXT NOT NULL,
+  memory_id INTEGER,
+  memory_hash TEXT NOT NULL,
+  status TEXT NOT NULL CHECK (status IN ('current', 'historical')),
+  valid_from REAL NOT NULL,
+  valid_from_iso TEXT NOT NULL,
+  valid_to REAL,
+  valid_to_iso TEXT,
+  replaced_by_hash TEXT,
+  rule_id TEXT NOT NULL,
+  created_at REAL NOT NULL,
+  created_at_iso TEXT NOT NULL,
+  updated_at REAL NOT NULL,
+  updated_at_iso TEXT NOT NULL,
+  metadata TEXT NOT NULL DEFAULT '{}'
+);
+CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_assertions_current
+  ON memory_assertions(assertion_key)
+  WHERE valid_to IS NULL;
+CREATE INDEX IF NOT EXISTS ix_memory_assertions_hash
+  ON memory_assertions(memory_hash);
+CREATE INDEX IF NOT EXISTS ix_memory_assertions_as_of
+  ON memory_assertions(assertion_key, valid_from, valid_to);
+"""
+    )
+
+
+def current_assertion_predicate(alias: str = "m") -> str:
+    return (
+        "EXISTS (SELECT 1 FROM memory_assertions a "
+        f"WHERE a.memory_hash = {alias}.content_hash "
+        "AND a.status = 'current' AND a.valid_to IS NULL)"
+    )
+
+
+def as_of_assertion_predicate(alias: str = "m") -> str:
+    return (
+        "EXISTS (SELECT 1 FROM memory_assertions a "
+        f"WHERE a.memory_hash = {alias}.content_hash "
+        "AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to > ?))"
+    )
+
+
+def can_close_existing(row: sqlite3.Row, current: sqlite3.Row, key_info: dict[str, Any], payload: dict[str, Any]) -> bool:
+    if key_info["confidence"] != "explicit":
+        return False
+    if row["content_hash"] == current["memory_hash"]:
+        return False
+    tool_name = str(payload.get("tool_name", ""))
+    if tool_name.endswith("memory_update") or tool_name.endswith("mistake_note_add"):
+        return True
+    row_created = float(row["created_at"] or 0)
+    current_created = float(current["valid_from"] or 0)
+    return row_created >= current_created
+
+
+def insert_current(con: sqlite3.Connection, row: sqlite3.Row, key_info: dict[str, Any], now: float) -> None:
+    con.execute(
+        """
+INSERT INTO memory_assertions (
+  assertion_key, memory_id, memory_hash, status, valid_from, valid_from_iso,
+  valid_to, valid_to_iso, replaced_by_hash, rule_id, created_at, created_at_iso,
+  updated_at, updated_at_iso, metadata
+) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
+""",
+        (
+            key_info["assertion_key"],
+            row["id"],
+            row["content_hash"],
+            STATUS_CURRENT,
+            now,
+            utc_iso(now),
+            key_info["rule_id"],
+            now,
+            utc_iso(now),
+            now,
+            utc_iso(now),
+            json.dumps(key_info, ensure_ascii=True, sort_keys=True),
+        ),
+    )
+
+
+def close_current(con: sqlite3.Connection, current: sqlite3.Row, new_hash: str, now: float) -> None:
+    con.execute(
+        """
+UPDATE memory_assertions
+SET status = ?, valid_to = ?, valid_to_iso = ?, replaced_by_hash = ?,
+    updated_at = ?, updated_at_iso = ?
+WHERE id = ?
+""",
+        (STATUS_HISTORICAL, now, utc_iso(now), new_hash, now, utc_iso(now), current["id"]),
+    )
+
+
+def upsert_assertion(
+    con: sqlite3.Connection,
+    row: sqlite3.Row,
+    retain: dict[str, Any],
+    config: dict[str, Any],
+    payload: dict[str, Any],
+    now: float | None = None,
+) -> dict[str, Any]:
+    ensure_assertion_schema(con)
+    stamp = time.time() if now is None else now
+    key_info = derive_assertion_key(row, retain, config)
+    current = con.execute(
+        "SELECT * FROM memory_assertions WHERE assertion_key = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1",
+        (key_info["assertion_key"],),
+    ).fetchone()
+
+    if current is None:
+        insert_current(con, row, key_info, stamp)
+        decision = "fallback-unique" if key_info["confidence"] == "fallback" else "inserted-current"
+        return {"assertionKey": key_info["assertion_key"], "assertionDecision": decision, "ruleId": key_info["rule_id"]}
+
+    if current["memory_hash"] == row["content_hash"]:
+        con.execute(
+            "UPDATE memory_assertions SET memory_id = ?, updated_at = ?, updated_at_iso = ?, metadata = ? WHERE id = ?",
+            (row["id"], stamp, utc_iso(stamp), json.dumps(key_info, ensure_ascii=True, sort_keys=True), current["id"]),
+        )
+        return {"assertionKey": key_info["assertion_key"], "assertionDecision": "unchanged", "ruleId": key_info["rule_id"]}
+
+    if not can_close_existing(row, current, key_info, payload):
+        return {
+            "assertionKey": key_info["assertion_key"],
+            "assertionDecision": "conflict-review",
+            "ruleId": key_info["rule_id"],
+            "currentHash": current["memory_hash"],
+        }
+
+    close_current(con, current, row["content_hash"], stamp)
+    insert_current(con, row, key_info, stamp)
+    return {
+        "assertionKey": key_info["assertion_key"],
+        "assertionDecision": "closed-and-inserted",
+        "ruleId": key_info["rule_id"],
+        "closedHash": current["memory_hash"],
+    }
diff --git a/memory-normalizer/test-assertion-lifecycle.py b/memory-normalizer/test-assertion-lifecycle.py
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/memory-normalizer/test-assertion-lifecycle.py
@@
+#!/usr/bin/env python
+"""Self-contained tests for memory assertion SCD2 behavior."""
+from __future__ import annotations
+
+import json
+import sqlite3
+from typing import Any
+
+import assertion_lifecycle as lifecycle
+
+
+def make_db() -> sqlite3.Connection:
+    con = sqlite3.connect(":memory:")
+    con.row_factory = sqlite3.Row
+    con.execute(
+        """
+CREATE TABLE memories (
+  id INTEGER PRIMARY KEY AUTOINCREMENT,
+  content_hash TEXT UNIQUE NOT NULL,
+  content TEXT NOT NULL,
+  tags TEXT,
+  memory_type TEXT,
+  metadata TEXT,
+  created_at REAL,
+  updated_at REAL,
+  created_at_iso TEXT,
+  updated_at_iso TEXT,
+  deleted_at REAL,
+  parent_id INTEGER,
+  version INTEGER,
+  confidence REAL,
+  last_accessed REAL,
+  superseded_by TEXT
+)
+"""
+    )
+    return con
+
+
+def insert_memory(con: sqlite3.Connection, content_hash: str, content: str, *, created_at: float) -> sqlite3.Row:
+    con.execute(
+        """
+INSERT INTO memories (
+  content_hash, content, tags, memory_type, metadata, created_at, confidence
+) VALUES (?, ?, ?, ?, ?, ?, ?)
+""",
+        (content_hash, content, "decision,all,hooks,memory", "decision", "{}", created_at, 0.9),
+    )
+    return con.execute("SELECT * FROM memories WHERE content_hash = ?", (content_hash,)).fetchone()
+
+
+def retain(row: sqlite3.Row) -> dict[str, Any]:
+    return {
+        "memory_type": row["memory_type"],
+        "content_fingerprint": f"fp-{row['content_hash'][:8]}",
+        "metadata": {"classifier_source": "test", "classifier_confidence": 1.0},
+    }
+
+
+def config() -> dict[str, Any]:
+    return {
+        "shared": {
+            "projects": [{"slug": "hooks", "kind": "rebuild", "repoPath": "E:/hooks", "aliases": []}],
+            "memoryTags": {"crossProjectTag": "all"},
+        }
+    }
+
+
+def assert_equal(actual: Any, expected: Any, label: str) -> None:
+    if actual != expected:
+        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")
+
+
+def test_insert_and_idempotence() -> None:
+    con = make_db()
+    row = insert_memory(con, "a" * 64, "Decision: E:/hooks/config.json is the hook config. Why: runtime reads it.", created_at=100)
+    first = lifecycle.upsert_assertion(con, row, retain(row), config(), {"tool_name": "memory_store"}, now=200)
+    second = lifecycle.upsert_assertion(con, row, retain(row), config(), {"tool_name": "memory_store"}, now=201)
+    count = con.execute("SELECT COUNT(*) FROM memory_assertions").fetchone()[0]
+    assert_equal(first["assertionDecision"], "inserted-current", "first insert decision")
+    assert_equal(second["assertionDecision"], "unchanged", "second insert decision")
+    assert_equal(count, 1, "idempotent row count")
+
+
+def test_replacement_closes_old_row() -> None:
+    con = make_db()
+    old = insert_memory(con, "b" * 64, "Decision: E:/hooks/config.json is the hook config. Why: old.", created_at=100)
+    new = insert_memory(con, "c" * 64, "Decision: E:/hooks/config.json is the hook config. Why: new.", created_at=150)
+    lifecycle.upsert_assertion(con, old, retain(old), config(), {"tool_name": "memory_store"}, now=200)
+    result = lifecycle.upsert_assertion(con, new, retain(new), config(), {"tool_name": "memory_store"}, now=300)
+    current = con.execute("SELECT memory_hash FROM memory_assertions WHERE valid_to IS NULL").fetchone()[0]
+    historical = con.execute("SELECT memory_hash, replaced_by_hash FROM memory_assertions WHERE valid_to IS NOT NULL").fetchone()
+    assert_equal(result["assertionDecision"], "closed-and-inserted", "replacement decision")
+    assert_equal(current, "c" * 64, "current hash")
+    assert_equal(historical["memory_hash"], "b" * 64, "historical hash")
+    assert_equal(historical["replaced_by_hash"], "c" * 64, "replacement pointer")
+
+
+def test_fallback_hash_does_not_replace() -> None:
+    con = make_db()
+    first = insert_memory(con, "d" * 64, "Decision: hooks memory lifecycle exists. Why: first.", created_at=100)
+    second = insert_memory(con, "e" * 64, "Decision: hooks memory lifecycle exists. Why: second.", created_at=150)
+    first_result = lifecycle.upsert_assertion(con, first, retain(first), config(), {"tool_name": "memory_store"}, now=200)
+    second_result = lifecycle.upsert_assertion(con, second, retain(second), config(), {"tool_name": "memory_store"}, now=300)
+    current_count = con.execute("SELECT COUNT(*) FROM memory_assertions WHERE valid_to IS NULL").fetchone()[0]
+    assert_equal(first_result["assertionDecision"], "fallback-unique", "first fallback")
+    assert_equal(second_result["assertionDecision"], "fallback-unique", "second fallback")
+    assert_equal(current_count, 2, "fallback current rows")
+
+
+def test_as_of_predicate() -> None:
+    con = make_db()
+    old = insert_memory(con, "f" * 64, "Decision: E:/hooks/config.json is the hook config. Why: old.", created_at=100)
+    new = insert_memory(con, "0" * 64, "Decision: E:/hooks/config.json is the hook config. Why: new.", created_at=150)
+    lifecycle.upsert_assertion(con, old, retain(old), config(), {"tool_name": "memory_store"}, now=200)
+    lifecycle.upsert_assertion(con, new, retain(new), config(), {"tool_name": "memory_store"}, now=300)
+    sql = "SELECT content_hash FROM memories m WHERE " + lifecycle.as_of_assertion_predicate("m")
+    before = con.execute(sql, (250, 250)).fetchall()
+    after = con.execute(sql, (350, 350)).fetchall()
+    assert_equal([row[0] for row in before], ["f" * 64], "as-of before replacement")
+    assert_equal([row[0] for row in after], ["0" * 64], "as-of after replacement")
+
+
+def main() -> int:
+    tests = [
+        test_insert_and_idempotence,
+        test_replacement_closes_old_row,
+        test_fallback_hash_does_not_replace,
+        test_as_of_predicate,
+    ]
+    errors: list[str] = []
+    for test in tests:
+        try:
+            test()
+        except Exception as exc:
+            errors.append(f"{test.__name__}: {exc}")
+    print(json.dumps({"tests": [test.__name__ for test in tests], "errors": errors}, indent=2, ensure_ascii=True))
+    return 1 if errors else 0
+
+
+if __name__ == "__main__":
+    raise SystemExit(main())
diff --git a/memory-normalizer/normalize-after-store.py b/memory-normalizer/normalize-after-store.py
index 3333333..4444444 100644
--- a/memory-normalizer/normalize-after-store.py
+++ b/memory-normalizer/normalize-after-store.py
@@
 from hook_runtime import connect, detect_project, hooks_db, run, safe_table  # noqa: E402
+from assertion_lifecycle import upsert_assertion  # noqa: E402
 from memory_retain import build_retain_payload, normalize_tags, tags_to_string  # noqa: E402
@@
-        results.append(update_memory_row(con, row, retain, config=config, payload=payload, normalized_at=time.time()))
+        normalized_at = time.time()
+        row_result = update_memory_row(con, row, retain, config=config, payload=payload, normalized_at=normalized_at)
+        assertion_result = upsert_assertion(con, row, retain, config, payload, now=normalized_at)
+        row_result["assertion"] = assertion_result
+        row_result["assertionKey"] = assertion_result.get("assertionKey")
+        row_result["assertionDecision"] = assertion_result.get("assertionDecision")
+        if "closedHash" in assertion_result:
+            row_result["closedHash"] = assertion_result["closedHash"]
+        results.append(row_result)
diff --git a/memory-normalizer/maintain-existing-memories.py b/memory-normalizer/maintain-existing-memories.py
index 5555555..6666666 100644
--- a/memory-normalizer/maintain-existing-memories.py
+++ b/memory-normalizer/maintain-existing-memories.py
@@
 from memory_retain import (  # noqa: E402
@@
 )
+from assertion_lifecycle import ensure_assertion_schema, upsert_assertion  # noqa: E402
@@
     parser.add_argument("--pairwise", action="store_true", help="Run a full active-row pairwise high-overlap review audit.")
+    parser.add_argument("--assertions", action="store_true", help="Dry-run assertion lifecycle coverage for existing active rows.")
+    parser.add_argument("--apply-assertions", action="store_true", help="Create/backfill memory_assertions. Requires Jon-approved dry-run counts.")
diff --git a/inject-protocol/recall.py b/inject-protocol/recall.py
index 7777777..8888888 100644
--- a/inject-protocol/recall.py
+++ b/inject-protocol/recall.py
@@
+def optional_as_of(argv, config):
+    raw = argv[5] if len(argv) == 6 else config.get("asOf")
+    if raw in (None, ""):
+        return None
+    return float(raw)
+
+
 def main(argv):
-    if len(argv) != 5:
-        raise ValueError("usage: recall.py <db> <query> <project> <config-json>")
+    if len(argv) not in (5, 6):
+        raise ValueError("usage: recall.py <db> <query> <project> <config-json> [as-of-epoch]")
@@
     config = json.loads(raw_config)
+    as_of = optional_as_of(argv, config)
@@
-    params = [query]
+    params = [query]
+    filter_params = []
+    if as_of is not None:
+        filters.append(
+            "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash "
+            "AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to > ?))"
+        )
+        filter_params.extend([as_of, as_of])
@@
     if project:
         sql += "AND (','||coalesce(m.tags,'')||',' LIKE ? OR ','||coalesce(m.tags,'')||',' LIKE ?) "
         params.extend([f"%,{project},%", f"%,{cross_project_tag},%"])
+    params.extend(filter_params)
diff --git a/inject-protocol-complex/recall.py b/inject-protocol-complex/recall.py
index 7777777..8888888 100644
--- a/inject-protocol-complex/recall.py
+++ b/inject-protocol-complex/recall.py
@@
+def optional_as_of(argv, config):
+    raw = argv[5] if len(argv) == 6 else config.get("asOf")
+    if raw in (None, ""):
+        return None
+    return float(raw)
+
+
 def main(argv):
-    if len(argv) != 5:
-        raise ValueError("usage: recall.py <db> <query> <project> <config-json>")
+    if len(argv) not in (5, 6):
+        raise ValueError("usage: recall.py <db> <query> <project> <config-json> [as-of-epoch]")
     db, query, project, raw_config = argv[1], argv[2], argv[3], argv[4]
     config = json.loads(raw_config)
+    as_of = optional_as_of(argv, config)
@@
-    params = [query]
+    params = [query]
+    filter_params = []
+    if as_of is not None:
+        filters.append(
+            "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash "
+            "AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to > ?))"
+        )
+        filter_params.extend([as_of, as_of])
@@
     if project:
         sql += "AND (','||coalesce(m.tags,'')||',' LIKE ? OR ','||coalesce(m.tags,'')||',' LIKE ?) "
         params.extend([f"%,{project},%", f"%,{cross_project_tag},%"])
+    params.extend(filter_params)
     sql += f"ORDER BY rank LIMIT {candidate_pool}"
diff --git a/inject-protocol/inject-protocol.mjs b/inject-protocol/inject-protocol.mjs
index 9999999..aaaaaaa 100644
--- a/inject-protocol/inject-protocol.mjs
+++ b/inject-protocol/inject-protocol.mjs
@@
 const MEMORY_FILTER_SQL = Object.freeze({
   'not-deleted': 'm.deleted_at IS NULL',
-  'not-superseded': "(m.superseded_by IS NULL OR m.superseded_by='')"
+  'not-superseded': "(m.superseded_by IS NULL OR m.superseded_by='')",
+  'current-assertion': "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash AND a.status = 'current' AND a.valid_to IS NULL)"
 });
diff --git a/inject-protocol-complex/inject-protocol-complex.mjs b/inject-protocol-complex/inject-protocol-complex.mjs
index 9999999..aaaaaaa 100644
--- a/inject-protocol-complex/inject-protocol-complex.mjs
+++ b/inject-protocol-complex/inject-protocol-complex.mjs
@@
 const MEMORY_FILTER_SQL = Object.freeze({
   'not-deleted': 'm.deleted_at IS NULL',
-  'not-superseded': "(m.superseded_by IS NULL OR m.superseded_by='')"
+  'not-superseded': "(m.superseded_by IS NULL OR m.superseded_by='')",
+  'current-assertion': "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash AND a.status = 'current' AND a.valid_to IS NULL)"
 });
diff --git a/_core/config-model.mjs b/_core/config-model.mjs
index bbbbbbb..ccccccc 100644
--- a/_core/config-model.mjs
+++ b/_core/config-model.mjs
@@
 export const MEMORY_FILTER_IDS = Object.freeze([
   'not-deleted',
   'not-superseded',
+  'current-assertion',
 ]);
diff --git a/quality-completion-gate/test-config-model.mjs b/quality-completion-gate/test-config-model.mjs
index ddddddd..eeeeeee 100644
--- a/quality-completion-gate/test-config-model.mjs
+++ b/quality-completion-gate/test-config-model.mjs
@@
 const badMemorySignal = structuredClone(config);
 badMemorySignal.hooks[0].settings.sources.memory.scoring.signals.fts.weight = 1.2;
 const badMemorySignalResult = validateConfig(badMemorySignal);
 assert.ok(
   badMemorySignalResult.errors.some((error) => error.includes('memory.scoring.signals.fts.weight')),
   'memory scoring signal weights must be validated against the model'
 );
+
+const goodCurrentAssertionFilter = structuredClone(config);
+goodCurrentAssertionFilter.hooks[0].settings.sources.memory.filters = [
+  { id: 'not-deleted' },
+  { id: 'current-assertion' },
+];
+const goodCurrentAssertionFilterResult = validateConfig(goodCurrentAssertionFilter);
+assert.deepEqual(goodCurrentAssertionFilterResult.errors, [], goodCurrentAssertionFilterResult.errors.join('\n'));
diff --git a/memory-normalizer/test-memory-runtime.py b/memory-normalizer/test-memory-runtime.py
index fffffff..1212121 100644
--- a/memory-normalizer/test-memory-runtime.py
+++ b/memory-normalizer/test-memory-runtime.py
@@
     filter_sql = {
         "not-deleted": "m.deleted_at IS NULL",
         "not-superseded": "(m.superseded_by IS NULL OR m.superseded_by='')",
+        "current-assertion": "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash AND a.status = 'current' AND a.valid_to IS NULL)",
     }
diff --git a/quality-completion-gate/quality-verify-manifest.json b/quality-completion-gate/quality-verify-manifest.json
index 3434343..4545454 100644
--- a/quality-completion-gate/quality-verify-manifest.json
+++ b/quality-completion-gate/quality-verify-manifest.json
@@
             { "label": "hooks memory runtime smoke", "command": "python memory-normalizer/test-memory-runtime.py", "timeoutMs": 30000 },
+            { "label": "hooks memory assertion lifecycle tests", "command": "python memory-normalizer/test-assertion-lifecycle.py", "timeoutMs": 30000 },
             { "label": "hooks memory normalizer self-test", "command": "python memory-normalizer/normalize-after-store.py --self-test", "timeoutMs": 30000 },
diff --git a/config.schema.json b/config.schema.json
index 5656565..6767676 100644
--- a/config.schema.json
+++ b/config.schema.json
@@
-                  "not-superseded"
+                  "not-superseded",
+                  "current-assertion"
diff --git a/config.json b/config.json
index 7878787..8989898 100644
--- a/config.json
+++ b/config.json
@@
             "filters": [
               { "id": "not-deleted" },
-              { "id": "not-superseded" }
+              { "id": "current-assertion" }
             ],
```

## New-file code explanations

### `memory-normalizer/assertion_lifecycle.py`

| Lines | Subfeature | Why it exists |
| --- | --- | --- |
| 1-14 | Module boundary and imports | Defines this as the only lifecycle module and imports only stdlib dependencies, keeping the hook repo dependency-free. |
| 16-23 | Constants and regexes | Locks the status vocabulary, rule version, and deterministic entity extraction surfaces used by assertion keys. |
| 26-42 | Timestamp and metadata parsing | Reuses the hook repo's UTC ISO pattern and safely reads legacy JSON metadata without crashing old rows. |
| 45-67 | Entity/project normalization | Produces stable lowercase assertion-key segments and derives project scope from existing tags/config. |
| 70-87 | Explicit entity helpers | Finds paths, URLs, ports, and mistake-note context before falling back to content fingerprint keys. |
| 90-125 | `derive_assertion_key` | Implements the closure safety rule: explicit entities can supersede; fallback hash keys remain unique. |
| 128-162 | `ensure_assertion_schema` | Creates the SCD2 table and indexes beside `memories` without altering `memories`, vectors, or FTS. |
| 165-179 | Recall predicates | Exposes current and historical SQL predicates for injectors and tests to use consistently. |
| 182-194 | Closure policy | Prevents accidental replacement unless the key is explicit and the incoming row is newer or corrective. |
| 197-235 | Insert/close helpers | Encapsulates SCD2 state transitions: insert current row, close old row, preserve replacement pointer. |
| 238-288 | `upsert_assertion` | Coordinates schema creation, idempotence, conflict-review, old-row closure, and audit-return payloads. |

### `memory-normalizer/test-assertion-lifecycle.py`

| Lines | Subfeature | Why it exists |
| --- | --- | --- |
| 1-8 | Test harness imports | Keeps lifecycle tests runnable as `python file.py`, matching existing hook repo self-test style. |
| 11-34 | Temp memory schema | Recreates the live `memories` columns needed by lifecycle logic without touching the real DB. |
| 37-55 | Fixture builders | Inserts deterministic rows and retain payloads so tests do not depend on MCP or vector state. |
| 58-73 | Config/assert helpers | Supplies the minimal project/tag config and readable assertion failures. |
| 76-85 | Insert/idempotence test | Proves a first write creates one current assertion and a repeated write does not duplicate it. |
| 88-100 | Replacement test | Proves the old assertion is closed, the new row becomes current, and `replaced_by_hash` is set. |
| 103-112 | Fallback safety test | Proves low-confidence hash keys do not close other memories, preventing over-aggressive dedupe. |
| 115-125 | As-of test | Proves historical recall semantics return old content before replacement and new content after replacement. |
| 128-144 | Script runner | Matches existing no-pytest hook tests and prints JSON for Stop-gate diagnostics. |

## Modified-file change explanations

| File | Change | Necessity |
| --- | --- | --- |
| `normalize-after-store.py` | Imports `upsert_assertion`. | The existing PostToolUse hook is already the committed-memory write seam; assertion lifecycle must attach here. |
| `normalize-after-store.py` | Calls `upsert_assertion` after `update_memory_row`. | The assertion key depends on normalized type/tags/fingerprint and must run once per resolved memory row. |
| `normalize-after-store.py` | Adds assertion fields to result payload. | Hook telemetry must show whether a memory became current, stayed unchanged, or closed an older assertion. |
| `maintain-existing-memories.py` | Imports lifecycle helpers. | Backfill must use the same schema/key/upsert code as live writes, avoiding two lifecycle implementations. |
| `maintain-existing-memories.py` | Adds `--assertions` and `--apply-assertions`. | Keeps audit and mutation separate, matching the existing dry-run-first maintenance pattern. |
| `recall.py` files | Adds optional as-of epoch argument. | Preserves default per-prompt recall while enabling historical recall for maintenance/debug calls. |
| `inject-protocol*.mjs` | Adds `current-assertion` SQL predicate. | Keeps SQL controlled by allowlisted config IDs rather than ad hoc prompt/runtime SQL. |
| `_core/config-model.mjs` | Adds `current-assertion` enum. | Makes the new recall filter legal only through the central config model. |
| `test-config-model.mjs` | Adds accepted-filter test. | Proves the new allowed filter works through the config validator. |
| `test-memory-runtime.py` | Maps the new filter SQL. | Makes runtime smoke understand the same recall filter vocabulary as the injector. |
| `quality-verify-manifest.json` | Adds lifecycle test. | Makes the Stop gate run the new test. |
| `config.schema.json` | Adds generated enum value. | Keeps generated schema consistent with `_core/config-model.mjs`. |
| `config.json` | Switches filters post-backfill. | Activates current-only temporal recall only after the assertion table is populated. |

## Implementation ordering required by this code writeup

1. Apply only the two new files first and run `python memory-normalizer/test-assertion-lifecycle.py`.
2. Apply `normalize-after-store.py` changes and run its self-test.
3. Apply `maintain-existing-memories.py` changes and run `--assertions --json` dry-run only.
4. Review dry-run counts with Jon before running `--apply-assertions`.
5. Apply config/injector/recall changes only after backfill is approved.
6. Regenerate `config.schema.json` with `node _core/generate-config-schema.mjs`.
7. Apply manifest changes and run the full verification list.

## Patch completeness addendum

The patch block above is the base patch. The hunks in this addendum are also required;
they make the patch complete where the base block is abbreviated.

### Full `inject-protocol-complex/recall.py` hunk

```diff
diff --git a/inject-protocol-complex/recall.py b/inject-protocol-complex/recall.py
index 7777777..8888888 100644
--- a/inject-protocol-complex/recall.py
+++ b/inject-protocol-complex/recall.py
@@
+def optional_as_of(argv, config):
+    raw = argv[5] if len(argv) == 6 else config.get("asOf")
+    if raw in (None, ""):
+        return None
+    return float(raw)
+
+
 def main(argv):
-    if len(argv) != 5:
-        raise ValueError("usage: recall.py <db> <query> <project> <config-json>")
+    if len(argv) not in (5, 6):
+        raise ValueError("usage: recall.py <db> <query> <project> <config-json> [as-of-epoch]")
     db, query, project, raw_config = argv[1], argv[2], argv[3], argv[4]
     config = json.loads(raw_config)
+    as_of = optional_as_of(argv, config)
@@
-    params = [query]
+    params = [query]
+    filter_params = []
+    if as_of is not None:
+        filters.append(
+            "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash "
+            "AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to > ?))"
+        )
+        filter_params.extend([as_of, as_of])
@@
     if project:
         sql += "AND (','||coalesce(m.tags,'')||',' LIKE ? OR ','||coalesce(m.tags,'')||',' LIKE ?) "
         params.extend([f"%,{project},%", f"%,{cross_project_tag},%"])
+    params.extend(filter_params)
     sql += f"ORDER BY rank LIMIT {candidate_pool}"
```

### Full `maintain-existing-memories.py` insertion hunk

```diff
diff --git a/memory-normalizer/maintain-existing-memories.py b/memory-normalizer/maintain-existing-memories.py
index 5555555..6666666 100644
--- a/memory-normalizer/maintain-existing-memories.py
+++ b/memory-normalizer/maintain-existing-memories.py
@@
 def build_report(
     rows: list[sqlite3.Row],
     plans: dict[int, dict[str, Any]],
     duplicate_groups: list[dict[str, Any]],
     near_candidates: list[dict[str, Any]],
     pairwise_candidates: list[dict[str, Any]],
+    assertion_report: dict[str, Any],
     pairwise_ran: bool,
@@
         "pairwiseDuplicateCandidates": {
             "ran": pairwise_ran,
             "pairsChecked": len(rows) * (len(rows) - 1) // 2 if pairwise_ran else 0,
             "count": len(pairwise_candidates),
             "samplePairs": pairwise_candidates[:20],
             "reviewOnly": True,
         },
+        "assertions": assertion_report,
     }
+
+
+def assertion_backfill_report(
+    con: sqlite3.Connection,
+    rows: list[sqlite3.Row],
+    plans: dict[int, dict[str, Any]],
+    config: dict[str, Any],
+    *,
+    apply: bool,
+) -> dict[str, Any]:
+    existing_table = con.execute(
+        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_assertions'"
+    ).fetchone()
+    if apply:
+        ensure_assertion_schema(con)
+        existing_table = True
+    decisions: dict[str, int] = defaultdict(int)
+    missing = 0
+    applied = 0
+    for row in rows:
+        plan = plans.get(row["id"])
+        if not plan:
+            continue
+        has_assertion = False
+        if existing_table:
+            has_assertion = bool(con.execute(
+                "SELECT 1 FROM memory_assertions WHERE memory_hash = ? LIMIT 1",
+                (row["content_hash"],),
+            ).fetchone())
+        if not has_assertion:
+            missing += 1
+        if apply:
+            retain = {
+                "memory_type": plan["memory_type"],
+                "content_fingerprint": plan["fingerprint"],
+                "metadata": {},
+            }
+            result = upsert_assertion(con, row, retain, config, {"tool_name": SCRIPT_ID}, now=time.time())
+            decisions[result["assertionDecision"]] += 1
+            applied += 1
+    return {
+        "enabled": True,
+        "mode": "APPLIED" if apply else "DRY-RUN",
+        "missing": missing,
+        "applied": applied,
+        "decisions": dict(sorted(decisions.items())),
+        "reviewOnly": not apply,
+    }
@@
         if args.pairwise:
             pairwise_candidates = broad_pairwise_candidates(rows, config)
+        assertion_report = {"enabled": False}
+        if args.assertions or args.apply_assertions:
+            assertion_report = assertion_backfill_report(con, rows, plans, config, apply=args.apply_assertions)
         if args.apply:
             con.commit()
+        if args.apply_assertions:
+            con.commit()
@@
             near_candidates,
             pairwise_candidates,
+            assertion_report,
             args.pairwise,
```

### Full `normalize-after-store.py` self-test hunk

```diff
diff --git a/memory-normalizer/normalize-after-store.py b/memory-normalizer/normalize-after-store.py
index 3333333..4444444 100644
--- a/memory-normalizer/normalize-after-store.py
+++ b/memory-normalizer/normalize-after-store.py
@@
             checked_rows = {
                 name: con.execute("SELECT tags, memory_type, metadata FROM memories WHERE content_hash = ?", (values[0],)).fetchone()
                 for name, values in fixtures.items()
             }
+            assertion_rows = con.execute(
+                "SELECT assertion_key, memory_hash, status, valid_to, replaced_by_hash FROM memory_assertions ORDER BY id"
+            ).fetchall()
         finally:
             con.close()
@@
             "checkedRows": {
@@
                 for name in checked_rows
             },
+            "assertions": [
+                {
+                    "assertionKey": row[0],
+                    "memoryHash": row[1],
+                    "status": row[2],
+                    "validTo": row[3],
+                    "replacedByHash": row[4],
+                }
+                for row in assertion_rows
+            ],
             "auditCount": audit_count,
         }
@@
         if delete_result["decision"] != "audit":
             errors.append(f"delete mutation should be audited without normalization: {delete_result}")
+        if not report["assertions"]:
+            errors.append("expected memory_assertions rows from normalized writes")
+        if result.get("assertionDecision") not in {"inserted-current", "fallback-unique"}:
+            errors.append(f"store result missing assertion decision: {result}")
         if row[1] != "decision":
             errors.append(f"fixture row memory_type mismatch: {row[1]}")
```

### Full `memory-normalizer/test-memory-runtime.py` hunk

```diff
diff --git a/memory-normalizer/test-memory-runtime.py b/memory-normalizer/test-memory-runtime.py
index fffffff..1212121 100644
--- a/memory-normalizer/test-memory-runtime.py
+++ b/memory-normalizer/test-memory-runtime.py
@@
 def active_filter() -> str:
     return "deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')"
+
+
+def current_assertion_filter() -> str:
+    return (
+        "EXISTS (SELECT 1 FROM memory_assertions a WHERE a.memory_hash = m.content_hash "
+        "AND a.status = 'current' AND a.valid_to IS NULL)"
+    )
@@
-        missing_tables = sorted({"memories", "memory_content_fts"} - names)
+        missing_tables = sorted({"memories", "memory_content_fts", "memory_assertions"} - names)
@@
     filter_sql = {
         "not-deleted": "m.deleted_at IS NULL",
         "not-superseded": "(m.superseded_by IS NULL OR m.superseded_by='')",
+        "current-assertion": current_assertion_filter(),
     }
```

### Full quality manifest compile hunk

```diff
diff --git a/quality-completion-gate/quality-verify-manifest.json b/quality-completion-gate/quality-verify-manifest.json
index 3434343..4545454 100644
--- a/quality-completion-gate/quality-verify-manifest.json
+++ b/quality-completion-gate/quality-verify-manifest.json
@@
-            { "label": "hooks python compile", "command": "python -m py_compile _core/hook_runtime.py hook-telemetry/log-event.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/test-memory-runtime.py thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py inject-protocol-complex/recall.py inject-protocol-complex/suggest.py", "timeoutMs": 30000 },
+            { "label": "hooks python compile", "command": "python -m py_compile _core/hook_runtime.py hook-telemetry/log-event.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/assertion_lifecycle.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/maintain-existing-memories.py memory-normalizer/test-assertion-lifecycle.py memory-normalizer/test-memory-runtime.py thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py inject-protocol-complex/recall.py inject-protocol-complex/suggest.py", "timeoutMs": 30000 },
```

### Full post-backfill `config.json` hunk

```diff
diff --git a/config.json b/config.json
index 7878787..8989898 100644
--- a/config.json
+++ b/config.json
@@
             "filters": [
               { "id": "not-deleted" },
-              { "id": "not-superseded" }
+              { "id": "current-assertion" }
             ],
@@
             "filters": [
               { "id": "not-deleted" },
-              { "id": "not-superseded" }
+              { "id": "current-assertion" }
             ],
```
