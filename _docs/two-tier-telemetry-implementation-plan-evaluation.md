# Two-Tier Hook Telemetry Implementation Plan — Evaluation

Reviews: `_docs/two-tier-telemetry-implementation-plan.md` (Draft, 2026-06-06)
Date: 2026-06-05
Reviewer: Claude (independent pre-implementation gate)
Modes used: `evaluating-plan-before-implementation` (structural audit + quality) + `code-review` lens (security / performance / correctness / maintainability)
Status: advisory gate — not an approval

## Ground-truth verification

Checked the plan's claims against the live repo, not just the plan text:

- `loop-safety/loop-guard.py:consecutive_failures` — reads `hook_events` (`SELECT … FROM hook_events WHERE session_id=? ORDER BY ts DESC`) at **PreToolUse** time.
- `thinking-gate/thinking-gate.py` — reads successful sequential-thinking rows from `hook_events` and consumes by row id at **PreToolUse** time.
- `hook-telemetry/log-event.py` (current) — synchronous `hook_events` writer; docstring states it is "the substrate loop-safety counts."
- `_core/config-model.mjs:validateTelemetry` — current expected `script.path === 'hook-telemetry/log-event.py'`; telemetry `settings` is schema-generic (only inject hooks + skill-indexer have typed settings schemas), so the plan's "Generated files: 0" claim for `config.schema.json` is **correct**.
- `quality-completion-gate/quality-verify-manifest.json` — the `hooks` repo `runtime` domain compile/test command list the plan edits.

---

## Phase 1 — Structural Verdict: **Structurally Complete**

This is one of the most complete plans in the repo. Every Required-Plan-Contract section is present and specific; the Supabase-oriented sections (Platform API, Migrations, Edge Functions, Frontend) are correctly zero-cased with justification appropriate to a hooks-infra change. The plan ships the **full code for all 5 new files**, exact diffs for all 5 modified files, an 8-task execution sequence with commit messages, a rollback section, and a final contract check.

Inventory + cross-reference checks pass:
- New: 5, Modified repo: 5, Live: 1, Generated: 0 — all match the bodies provided.
- `config.json` script path → `queue-event.py` is consistently reflected in the `config-model.mjs` validator diff and the `test-config-model.mjs` additions.
- "Generated: 0" is verified correct (semantic-only validation change; JSON Schema unchanged).

No structural deficiencies. Proceed to quality.

---

## Phase 2 — Quality Findings

### 🔴 Critical

**C1 — Queuing ordinary telemetry blinds `loop-safety` during the session.**
The plan freezes the **thinking-gate** seam (sequential-thinking stays on the synchronous `log-event.py`) but misses the **symmetric `loop-safety` seam**. `loop-safety` is a PreToolUse circuit breaker that counts *consecutive same-operation failures in the current session* from `hook_events` and denies at `hardMax`. Under this plan, ordinary tool events (Bash/Edit/…) — exactly the failures `loop-safety` counts — are written to the **queue**, and the queue is drained **only on `Stop`** (plan Decision #5; TOML `[[hooks.Stop.hooks]]` drain, lines 1254-1258). A retry loop happens *within a turn*, before any `Stop`. So at the moment `loop-safety` reads `hook_events`, the in-turn failures are still sitting in queue files → the breaker counts 0 → **it never trips on the loop it exists to stop.**

This contradicts the plan's own stated intent: the Observability table (line 48) says the durable row shape is "consumed by `thinking-gate` and `loop-safety`," and acceptance criterion #9 asserts "`loop-safety` can read drained Bash failures from `hook_events`." That criterion is *technically* satisfiable (the row exists after the Stop drain) but **masks the timing regression** — it is never visible in-session.

The plan must make an explicit decision for `loop-safety` the way it did for `thinking-gate`. Options, best first:
1. **Queue successes, write failures synchronously** (`status=="error"` → `store.write_payload`; `ok` → queue). Failures are rarer than successes, so this removes nearly all hot-path SQLite cost *and* preserves `loop-safety`. Cleanest resolution.
2. Explicitly declare `loop-safety` deferred/dormant until reworked, and record it as an accepted limitation (mirrors the plan's Option-3 treatment of thinking-gate). Acceptable **only** if Jon does not intend `loop-safety` to run.
3. Drain at PreToolUse before `loop-safety` reads — rejected: reintroduces SQLite to the hot path, defeating the plan's purpose.

Severity is Critical *if `loop-safety` is intended to function as a live breaker* (the codebase and this plan both assert it consumes the substrate). If `loop-safety` is permanently disabled, downgrade to Significant — but the plan should say so.

### 🟠 Significant

**S1 — Drain re-opens the DB and re-runs full schema DDL per event (performance).**
`store.write_payload` (plan lines 358-376) does `connect → ensure_schema → insert → commit → close` for **one** event, and `drain-events.py` calls it **once per event** in the loop (lines 646-653). Draining N events = N connection opens, N×`executescript` (CREATE TABLE + 2 CREATE INDEX) + N×3 `DROP INDEX IF EXISTS` + N commits/fsyncs. Under the `--max-ms 1000` Stop budget, this caps real throughput well below `--max-events 500`, so a heavy session's queue can grow faster than a Stop drain clears it (compounding Risk #2). Fix: a drain-specific path that opens once, `ensure_schema` once, inserts many, commits once (or in batches), closes once.

**S2 — 128 KB payload cap discards the real event identity.**
`queue-event.read_payload` (lines 433-463) reads `maxEventBytes+1` and, if exceeded, **replaces the payload** with a synthetic `__telemetry_payload_too_large__` record. A large *failing* Bash command (big stderr in `tool_response`) exceeds 131072 bytes and is recorded with no real `tool_name`/`target`/`status` → invisible to `loop-safety` fingerprinting even after drain. The current `log-event.py` has no such cap. Mitigation: cap by trimming `tool_response`/`detail` while preserving `tool_name`, `tool_input` target, and structural `status`, rather than dropping the whole payload.

### 🟡 Minor

- **M1 — Unused `import os`** in `store.py` (line 223).
- **M2 — Test gaps vs acceptance contract.** No test exercises `--max-ms` budget stop (acceptance #5), the size-cap path (S2), or the empty-payload path. `test-drain-events.py` covers ordering, recovery, and bad-events well, but acceptance #5/#9 are unverified by the suite the Completion Criteria rely on.
- **M3 — Duplication.** `resolve_path` and `queue_settings` are defined identically in both `queue-event.py` and `drain-events.py`; candidates for `store.py` or a small shared module.
- **M4 — Synthetic malformed payloads become `hook_events` rows.** Parse-error/empty/non-object inputs are queued and later drained as real rows (`__telemetry_*__`), adding noise to the durable table. Arguably belongs in `bad-events`, not `hook_events`.
- **M5 — `directScript`/`drainScript` existence not validated.** `config-model.mjs` checks the strings equal the expected paths, but nothing verifies those files exist on disk (the manifest `py_compile` command is the only backstop). Minor drift risk since `log-event.py`/`drain-events.py` are wired only in the live TOML, not as `config.json` hooks the validator path-checks.

### Code-review dimension summary

| Dimension | Result |
|---|---|
| Security | No injection (table via `safe_table` identifier check; values parameterized). Note: tool payloads now persist as plaintext queue files under `.state/` until drained — same data class as the DB, but a second at-rest copy. |
| Performance | Hot path improved (no SQLite) ✅; drain path regressed (S1); queue glob is O(n) per drain under backlog. |
| Correctness | Atomic `.tmp`→`os.replace` write ✅; `claim()` race-safe ✅; `ts=queuedAt` preserves event order ✅; status/envelope parity preserved ✅. The loop-safety timing (C1) and size-cap identity loss (S2) are the real correctness issues. |
| Maintainability | `store.py` DRY across direct + drain ✅; clear naming; minor dup (M3) and unused import (M1). |

## What the plan does well

- **Addresses the prior Round-2 evaluation's drain concerns:** orphan recovery (`recover_draining_files`), bounds parsing (`argparse --max-ms/--max-events`), and one-file-per-event (eliminates the JSONL partial-line interleave risk flagged earlier).
- **Correctly protects the thinking-gate seam:** synchronous grant path + `directTools` skip + double-record avoidance under a `.*` broad matcher.
- Atomic writes, race-safe claim, event-time preservation, exact schema preservation, and an honest risk section with a real rollback.

## Alternative Approach (recommended)

Split by **status, not just by tool**: failures (`status=="error"`) and grant events stay synchronous via `store.write_payload`; successful ordinary events go to the queue and drain on Stop. This keeps `loop-safety` fully functional in-session, keeps `thinking-gate` synchronous, and still removes SQLite from the hot path for the common (success) case — directly resolving C1 with minimal added complexity.

---

## Approval Recommendation: **Revise — Quality**

Structurally complete and well-built, and the architecture is fundamentally sound — this is not a Rethink. But it must not be executed until **C1** is resolved with an explicit, recorded decision (mirror the thinking-gate seam treatment) and **S1** is addressed so the Stop-bounded drain can keep up. S2 and the test gaps should be folded into the revision.

**Bottom line:** A strong, unusually complete plan that correctly fixes the hot-path stall and learns from the prior evaluation — but it protects only one of the two `hook_events` consumers. As written it would be executed faithfully and silently defeat `loop-safety`. Decide the loop-safety seam (recommend: keep failures synchronous), fix the per-event drain connection, and it's ready.
