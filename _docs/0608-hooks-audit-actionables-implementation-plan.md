# Hooks Audit Actionables Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the confirmed actionables from `_docs/0608_hooks_repo_review.md` into a staged hardening implementation that makes the live hooks system safer, more portable, and easier to verify without rewriting the control plane.

**Architecture:** Keep `config.json` as the control-plane registry and add shared path/runtime/wiring primitives around the existing hook entrypoints. The first slices are low-risk validation, manifest, and test fixes; shared runtime and portability changes come only after baseline tests protect the active Codex hook flow.

**Tech Stack:** Python hook entrypoints, Node ESM hook entrypoints, SQLite, `config.json` and generated `config.schema.json`, Codex/Claude hook wiring templates, PowerShell/Windows local development.

---

## Plan Status

Status: draft for approval.

Source audit: `_docs/0608_hooks_repo_review.md`.

Plan location: `_docs/0608-hooks-audit-actionables-implementation-plan.md`.

Plan storage decision: this repo stores implementation plans in `_docs/`, so this plan intentionally uses `_docs/` rather than the generic `docs/plans/` path from the planning skill.

Mode: `address-evaluation-results` Mode 1. This plan updates the implementation contract only. It does not remediate code until explicitly approved for execution.

## Current State Snapshot

Observed branch: `main`.

Observed recent commits:

- `6a6c373 feat: harden hooks control plane gates`
- `b88ae97 chore: update hooks control plane`
- `87bc835 refactor: harden hook runtime and memory normalization`
- `f3a2668 fix: harden hooks config validation`
- `a50d271 refactor: reorganize hooks control plane`

Observed worktree before this plan: only `_docs/0608_hooks_repo_review.md` was untracked.

No runtime code is changed by this plan.

## Evaluation Disposition

The audit is useful to implement, with two important adjustments.

| Audit item | Disposition | Implementation stance |
|---|---|---|
| Hardcoded `E:/hooks` makes the repo non-portable | Confirmed | Fix with shared path resolution and portable tests. |
| Missing committed Claude/Codex runtime wiring | Confirmed, with Codex correction | Add first-class Codex and Claude wiring templates plus a doctor. |
| Python runtime does not enforce `hooks[].event` | Confirmed | Add event matching to `_core/hook_runtime.py` before broader runtime changes. |
| Missing hook config silently enables defaults | Confirmed | Missing hook config must no-op with a clear debug warning, not run as enabled. |
| Telemetry dependency validation incomplete | Partially accurate | Validator already catches missing telemetry globally; strengthen enabled-dependency and event/match breadth checks. |
| `memory-normalizer.settings.writes.memoryTable` ignored | Confirmed | Make table setting real via safe SQL identifier and tests; keep columns fixed and validated. |
| Quality manifest omits implemented hook dirs | Confirmed | Add `browser-verify-gate/` and `frontend-design-gate/` to the hooks repo runtime domain. |
| Node runtime semantics differ from Python | Confirmed | Add `_core/hook-runtime.mjs` and migrate Node hooks onto it after tests exist. |
| `hooks[].scope` not enforced | Confirmed but low current blast radius | Implement shared scope filtering while current scopes are still wildcard. |
| Tests useful but not portable | Confirmed | Convert hardcoded tests to repo-root/temp-config driven tests after runtime seams are stable. |
| Quality gate executes command strings through shell | Confirmed | Add argv command support with shell strings only behind explicit `shell: true`. |
| Frontend design gate ignores shared git timeout | Confirmed | Pass `shared.runtime.gitTimeoutMs` into git helper calls. |
| Browser verify state collides without `session_id` | Confirmed | Use a fallback key from repo/cwd/transcript when no session id exists. |
| Duplicate project detection exists in Python/Node | Confirmed | Add conformance fixtures first, then centralize what can be centralized safely. |

## Codex Parity Correction

Treat Codex as a first-class hook runtime for this plan.

The earlier uncertainty in the audit about Codex support is corrected by current local and schema evidence from the assessment: Codex hooks are enabled locally and Codex has generated lifecycle hook input/output schemas for core events. The plan must not treat Codex wiring as speculative.

Important caveat: do not assume Codex has a distinct `PostToolUseFailure` event unless current Codex schemas prove it during implementation. For Codex, failure classification must work from `PostToolUse.tool_response` structural failure fields. Claude can still use `PostToolUseFailure` where supported.

## Options Considered

### Option A: Minimal audit patch

Summary: Fix only event matching, manifest drift, and memory-normalizer write drift.

Effort: low.

Risk: leaves runtime wiring, portability, shell execution, and Node/Python parity unresolved.

Builds on: existing `_core/hook_runtime.py`, `_core/config-model.mjs`, and quality manifest.

Verdict: too narrow for the user's objective because it does not take all actionables forward.

### Option B: Recommended staged hardening

Summary: Implement all confirmed audit actionables in ordered slices, with low-risk contract/test fixes first and runtime refactors after coverage is in place.

Effort: medium-high.

Risk: more files change, but each slice has a rollback point and test command.

Builds on: current control-plane registry, existing Python runtime, quality gate core, config model, and hook-specific test files.

Verdict: adopt.

### Option C: Control-plane rewrite

Summary: Replace the current hook scripts with a new unified framework.

Effort: high.

Risk: unnecessary blast radius for a live hook system that already works on the current machine.

Builds on: little existing code.

Verdict: reject.

## Recommended Architecture

```
Agent runtime: Codex or Claude
  |
  v
Runtime wiring template or live local config
  |
  v
Hook entrypoint: Python or Node
  |
  v
Shared runtime: config, path, event, match, scope, failPolicy
  |
  v
Hook behavior: telemetry, gates, injection, memory normalization
  |
  v
SQLite state plus quality manifest plus doctor checks
```

More than three components exchange data here, and the approved implementation will touch more than eight files. Keep execution slice-based and commit after each verified slice.

## Locked Decisions

1. Do not rewrite the hook system. Harden the existing repo shape.
2. Do not enable disabled Stop gates (`quality-completion-gate`, `browser-verify-gate`, `frontend-design-gate`) as part of the first implementation pass.
3. Codex is a supported runtime. Runtime wiring templates and the doctor must cover Codex and Claude.
4. Never commit live user config, tokens, API keys, or machine secrets. Wiring examples must be templates.
5. `HOOKS_CONFIG_PATH` remains the highest-priority config override.
6. Add `HOOKS_HOME` and repo-root-derived defaults under `HOOKS_CONFIG_PATH`; do not remove support for the current `E:/hooks` install.
7. The memory normalizer may use `settings.writes.memoryTable`, but column names remain the fixed memory-store schema unless a separate migration plan approves dynamic columns.
8. `hooks[].scope` is enforceable runtime metadata. Because current scopes are wildcard, enforcement should introduce no behavior change in the existing config.
9. Quality gate command strings remain supported only with explicit `shell: true` after argv support lands.
10. No database migration is planned. Tests that need alternate memory tables must use temp SQLite databases.
11. The doctor must redact tokens and secret-like values from local config output.
12. Every slice must pass its local tests before the next slice begins.

## Surface Area

Platform API: none.

Frontend UI: none.

Database: existing SQLite only. No schema migration. Temp DBs are allowed in tests.

Observability: existing `hook_events` rows, stderr diagnostics, doctor output, and quality gate command output.

Secrets: none required. The doctor may read local Codex/Claude config files if present, but must never print token values.

External services: none required for implementation. Git, Node, Python, and SQLite are the only local toolchain dependencies.

## Phase 0: Baseline and Safety Net

### Task 0.1: Capture baseline state

**Files:**

- Read: `git status`
- Read: `_docs/0608_hooks_repo_review.md`
- Read: `config.json`
- Read: `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Run `git status --short --branch`.
2. Confirm only approved uncommitted files are present.
3. Run `node _core/validate-runtime-hooks.mjs`.
4. Run `node quality-completion-gate/test-config-model.mjs`.
5. Run `python _core/test-hook-runtime.py`.
6. Record results in the implementation notes or commit message.

**Expected result:** current validation and tests pass before code changes.

**Commit:** no commit required if this is read-only.

### Task 0.2: Add an audit action ledger

**Files:**

- Modify: `_docs/0608-hooks-audit-actionables-implementation-plan.md`

**Steps:**

1. During execution, add a small completion ledger to this plan or a sibling implementation log after each phase.
2. Record phase status, commit hash, commands run, and any plan drift.

**Expected result:** the implementation has a durable trace without relying on chat history.

**Commit:** include with the first code slice.

## Phase 1: Low-Risk Contract Fixes

### Task 1.1: Add missing hook directories to quality manifest

**Files:**

- Modify: `quality-completion-gate/quality-verify-manifest.json`
- Test: `quality-completion-gate/test-quality-gate-core.mjs`

**Steps:**

1. Write a failing test in `quality-completion-gate/test-quality-gate-core.mjs` that marks these files as matched by the hooks repo runtime domain:
   - `browser-verify-gate/browser-verify-gate.py`
   - `frontend-design-gate/frontend-design-gate.py`
2. Run `node quality-completion-gate/test-quality-gate-core.mjs`.
3. Confirm the new test fails because the manifest does not match both directories.
4. Add `browser-verify-gate/` and `frontend-design-gate/` to the hooks repo runtime domain prefixes in `quality-completion-gate/quality-verify-manifest.json`.
5. Run `node quality-completion-gate/test-quality-gate-core.mjs`.
6. Run `node _core/validate-runtime-hooks.mjs`.

**Expected result:** changed files under both gate directories map to the runtime domain instead of becoming unmatched.

**Commit:** `fix: cover stop gate dirs in hooks manifest`

### Task 1.2: Enforce Python hook event matching and missing-hook no-op

**Files:**

- Modify: `_core/hook_runtime.py`
- Modify: `_core/test-hook-runtime.py`
- Test: `python _core/test-hook-runtime.py`

**Steps:**

1. Add tests in `_core/test-hook-runtime.py` for:
   - configured event matches string event
   - configured event matches array event
   - wrong event exits allow and does not call the handler
   - missing hook id exits allow and does not call the handler
   - empty `hook_event_name` is allowed for compatibility with hand-run payloads
2. Run `python _core/test-hook-runtime.py`.
3. Confirm the event/missing-hook tests fail before implementation.
4. Add `matches_event(hcfg, event_name)` to `_core/hook_runtime.py`.
5. Change `hook_cfg` behavior so a missing hook entry cannot look enabled. Accept either returning `None` or returning `{ "enabled": false }`; update callers/tests consistently.
6. In `run()`, after stdin parsing and before tool matching, skip the hook when `payload.hook_event_name` is present and does not match `hooks[].event`.
7. Keep config-load failure fail-open.
8. Run `python _core/test-hook-runtime.py`.
9. Run representative Python hook tests:
   - `python hook-telemetry/test-log-event.py`
   - `python thinking-gate/test-thinking-gate.py`
   - `python loop-safety/test-loop-guard.py`
   - `python memory-normalizer/test-memory-runtime.py`
   - `python browser-verify-gate/test-browser-verify-gate.py`
   - `python frontend-design-gate/test-frontend-design-gate.py`

**Expected result:** Python hooks no-op on wrong lifecycle events and missing config entries.

**Commit:** `fix: enforce python hook event contracts`

### Task 1.3: Strengthen telemetry dependency validation

**Files:**

- Modify: `_core/config-model.mjs`
- Modify: `quality-completion-gate/test-config-model.mjs`
- Modify: `config.schema.json` after regeneration
- Test: `node quality-completion-gate/test-config-model.mjs`
- Test: `node _core/validate-runtime-hooks.mjs`

**Steps:**

1. Add tests in `quality-completion-gate/test-config-model.mjs` for enabled telemetry consumers:
   - `thinking-gate.enabled = true` and missing `hook-telemetry` fails validation.
   - `thinking-gate.enabled = true` and `hook-telemetry.enabled = false` fails validation.
   - `loop-safety.enabled = true` and telemetry missing/disabled fails validation.
   - `browser-verify-gate.enabled = true` and telemetry missing/disabled fails validation.
   - telemetry must include `PostToolUse`.
   - telemetry must have broad enough `match.tools` for enabled consumers.
2. Do not require `PostToolUseFailure` for Codex. Keep `PostToolUseFailure` allowed for Claude compatibility.
3. Add a shared validation helper in `_core/config-model.mjs`, for example `validateTelemetryConsumer(config, errors, hook, consumerId, requiredTools)`.
4. Make enabled consumers require an existing enabled telemetry hook.
5. Make telemetry breadth validation accept `match.tools: ["*"]`; for non-star tool lists, require every consumer-critical tool or explicitly document why the consumer is safe.
6. Run `node quality-completion-gate/test-config-model.mjs`.
7. Run `node _core/generate-config-schema.mjs`.
8. Run `node _core/validate-runtime-hooks.mjs`.

**Expected result:** impossible telemetry-dependent gate setups fail at config validation with precise messages.

**Commit:** `fix: validate telemetry consumer dependencies`

### Task 1.4: Resolve memory-normalizer write-table drift

**Files:**

- Modify: `memory-normalizer/normalize-after-store.py`
- Modify: `memory-normalizer/test-memory-runtime.py`
- Modify: `_core/config-model.mjs`
- Modify: `quality-completion-gate/test-config-model.mjs`
- Modify: `config.schema.json` after regeneration
- Test: `python memory-normalizer/test-memory-runtime.py`
- Test: `python memory-normalizer/normalize-after-store.py --self-test`

**Steps:**

1. Add a temp-DB test in `memory-normalizer/test-memory-runtime.py` that configures `settings.writes.memoryTable` to a safe alternate table name with the same columns as `memories`.
2. Confirm the normalizer resolves and updates rows in the configured table.
3. Add a validator test that rejects invalid SQL identifiers for `settings.writes.memoryTable`.
4. Add a validator test that requires `settings.writes.columns` to exactly equal:
   - `tags`
   - `memory_type`
   - `metadata`
   - `updated_at`
   - `updated_at_iso`
5. In `memory-normalizer/normalize-after-store.py`, derive the table name from `settings.writes.memoryTable` with `safe_table`.
6. Use that table name in every query/update currently hardcoded to `memories`:
   - `SELECT * FROM memories WHERE id = ?`
   - `SELECT * FROM memories WHERE content_hash = ?`
   - `SELECT * FROM memories WHERE content_hash LIKE ?`
   - `SELECT * FROM memories WHERE content = ?`
   - `UPDATE memories SET tags = ?, memory_type = ?, metadata = ?, updated_at = ?, updated_at_iso = ? WHERE id = ?`
7. Do not make configured column names dynamically executable SQL. Keep fixed writes and validate the column contract.
8. Run `python memory-normalizer/test-memory-runtime.py`.
9. Run `python memory-normalizer/normalize-after-store.py --self-test`.
10. Run `node quality-completion-gate/test-config-model.mjs`.
11. Run `node _core/generate-config-schema.mjs`.
12. Run `node _core/validate-runtime-hooks.mjs`.

**Expected result:** the table setting is real, safe, and tested; the column setting becomes an enforced contract.

**Commit:** `fix: honor memory normalizer write table`

## Phase 2: Runtime Wiring Templates and Doctor

### Task 2.1: Add runtime wiring templates

**Files:**

- Create: `examples/codex/config.toml`
- Create: `examples/claude/settings.json`
- Create: `_docs/runtime-wiring.md`
- Modify: `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Create `examples/codex/config.toml` with template hook entries for:
   - `UserPromptSubmit` -> `node <HOOKS_HOME>/inject-protocol/inject-protocol.mjs`
   - `PreToolUse` -> `python <HOOKS_HOME>/thinking-gate/thinking-gate.py`
   - `PreToolUse` -> `python <HOOKS_HOME>/loop-safety/loop-guard.py`
   - `PostToolUse` -> `python <HOOKS_HOME>/hook-telemetry/log-event.py`
   - memory mutation `PostToolUse` -> `python <HOOKS_HOME>/memory-normalizer/normalize-after-store.py`
   - optional disabled Stop gates as commented examples only
2. Create `examples/claude/settings.json` with equivalent hook wiring in Claude's settings shape.
3. Keep template variables generic: `<HOOKS_HOME>`, `<PYTHON>`, and `<NODE>`.
4. Do not include user-specific paths under `C:/Users/...`.
5. Do not include tokens or live MCP config.
6. Add `_docs/runtime-wiring.md` explaining:
   - supported runtimes
   - where to copy templates
   - how to set `HOOKS_CONFIG_PATH`
   - how Codex and Claude failure events differ
   - how to run the doctor
7. Add `examples/` to the hooks repo quality manifest runtime domain prefixes.
8. Run `node _core/validate-runtime-hooks.mjs`.

**Expected result:** a new operator can wire Codex or Claude without reading private local config.

**Commit:** `docs: add hook runtime wiring templates`

### Task 2.2: Add a runtime wiring doctor

**Files:**

- Create: `scripts/doctor.mjs`
- Create: `scripts/test-doctor.mjs`
- Modify: `config.json`
- Modify: `_core/config-model.mjs`
- Modify: `config.schema.json` after regeneration
- Modify: `quality-completion-gate/quality-verify-manifest.json`
- Test: `node scripts/test-doctor.mjs`

**Steps:**

1. Add a `runtime-wiring-doctor` script entry to `config.json`.
2. Add config-model validation for the new script entry.
3. Implement `scripts/doctor.mjs` as read-only.
4. Doctor checks:
   - config loads from `HOOKS_CONFIG_PATH` or default path
   - generated schema matches `_core/config-model.mjs`
   - enabled hook script paths exist
   - required Node/Python commands are runnable
   - hooks DB path parent exists or can be reported clearly
   - memory DB path exists when memory features are enabled
   - examples exist
   - local Codex config exists when requested with `--codex-config <path>`
   - local Claude settings exists when requested with `--claude-settings <path>`
   - enabled hook ids have corresponding wiring entries in supplied local runtime config
5. Redact secret-like values before printing. Redact keys or values containing:
   - `token`
   - `secret`
   - `password`
   - `api_key`
   - `authorization`
6. `scripts/test-doctor.mjs` must use temp config files and temp runtime wiring files.
7. Add doctor tests for:
   - all-good config passes
   - missing hook script fails
   - missing runtime wiring reports a clear failure
   - token-like values are redacted from output
8. Add doctor test command to the quality manifest.
9. Run:
   - `node scripts/test-doctor.mjs`
   - `node _core/generate-config-schema.mjs`
   - `node _core/validate-runtime-hooks.mjs`
   - `node quality-completion-gate/test-config-model.mjs`

**Expected result:** runtime wiring becomes verifiable without exposing live config.

**Commit:** `feat: add hooks runtime doctor`

## Phase 3: Portable Path Resolution

### Task 3.1: Add shared path resolution helpers

**Files:**

- Create: `_core/paths.py`
- Create: `_core/paths.mjs`
- Modify: `_core/hook_runtime.py`
- Modify: `quality-completion-gate/quality-gate-core.mjs`
- Modify: `_core/validate-runtime-hooks.mjs`
- Modify: `_core/generate-config-schema.mjs`
- Modify: `inject-protocol/inject-protocol.mjs`
- Modify: `config.json`
- Modify: `config.schema.json` after regeneration

**Steps:**

1. In `_core/paths.py`, implement:
   - repo root detection from `Path(__file__).resolve().parents[...]`
   - `HOOKS_HOME` override
   - `HOOKS_CONFIG_PATH` override for config file
   - path normalization for Windows and POSIX separators
   - `resolve_config_path()`
   - `resolve_hooks_home()`
   - `resolve_under_hooks(relative_path)`
2. In `_core/paths.mjs`, implement equivalent helpers for Node ESM.
3. Keep `HOOKS_CONFIG_PATH` highest priority.
4. Keep current `E:/hooks` paths valid when config explicitly says `E:/hooks`.
5. Replace default `E:/hooks/config.json` constants with path helper calls.
6. Replace default schema output path in `_core/generate-config-schema.mjs` with repo-root `config.schema.json`.
7. Replace hardcoded schema path in `_core/validate-runtime-hooks.mjs` with config-adjacent or repo-root `config.schema.json`.
8. Update `config.json` only where the stable committed config should remain canonical. Do not remove live Windows paths until tests prove portable overrides work.
9. Regenerate `config.schema.json`.

**Expected result:** tests can run from a cloned repo path without depending on `E:/hooks`, while the current install keeps working.

**Commit:** `refactor: add portable hooks path helpers`

### Task 3.2: Convert tests to portable roots

**Files:**

- Modify: `_core/test-hook-runtime.py`
- Modify: `hook-telemetry/test-log-event.py`
- Modify: `thinking-gate/test-thinking-gate.py`
- Modify: `loop-safety/test-loop-guard.py`
- Modify: `browser-verify-gate/test-browser-verify-gate.py`
- Modify: `frontend-design-gate/test-frontend-design-gate.py`
- Modify: `inject-protocol/test-index-skills.py`
- Modify: `quality-completion-gate/test-config-model.mjs`
- Modify: `quality-completion-gate/test-quality-gate-core.mjs`

**Steps:**

1. Replace `Path("E:/hooks")` and `readFileSync("E:/hooks/config.json")` test constants with repo-root detection.
2. Make tests write temp `HOOKS_CONFIG_PATH` configs when they mutate settings.
3. Make tests use temp SQLite DBs unless the test is explicitly a live smoke test.
4. Keep one optional live smoke command documented, not required for normal test runs.
5. Run all touched tests.

**Expected result:** the suite can run from the repository root on another path.

**Commit:** `test: make hooks tests portable`

## Phase 4: Shared Node Runtime Parity

### Task 4.1: Create `_core/hook-runtime.mjs`

**Files:**

- Create: `_core/hook-runtime.mjs`
- Create: `_core/test-hook-runtime.mjs`
- Modify: `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Add Node runtime helpers equivalent to Python behavior:
   - load config
   - find hook by id
   - missing hook no-op
   - enabled check
   - event match
   - tool match
   - scope match
   - fail policy
   - JSON stdin parsing
   - debug logging behind `HOOK_DEBUG=1`
2. Add tests for wrong event, wrong tool, disabled hook, missing hook, fail-open error, and fail-closed error.
3. Add `node _core/test-hook-runtime.mjs` to the quality manifest.
4. Run:
   - `node _core/test-hook-runtime.mjs`
   - `node --check _core/hook-runtime.mjs`
   - `node _core/validate-runtime-hooks.mjs`

**Expected result:** Node hooks have a common runtime contract before migration.

**Commit:** `feat: add shared node hook runtime`

### Task 4.2: Migrate Node hooks onto shared runtime

**Files:**

- Modify: `inject-protocol/inject-protocol.mjs`
- Modify: `quality-completion-gate/quality-gate-core.mjs`
- Modify: `quality-completion-gate/quality-completion-gate.mjs`
- Modify: `inject-protocol/test-inject-protocol-core.mjs`
- Modify: `inject-protocol/test-inject-protocol-self-test.mjs`
- Modify: `quality-completion-gate/test-quality-gate-core.mjs`

**Steps:**

1. Add tests that send wrong-event payloads to Node hooks and assert no-op behavior.
2. Add tests that set Node hook `failPolicy` to `closed` and trigger a controlled runtime error.
3. Migrate `inject-protocol/inject-protocol.mjs` config loading and event/match checks to `_core/hook-runtime.mjs`.
4. Migrate `quality-completion-gate/quality-completion-gate.mjs` and shared gate core runtime setup to `_core/hook-runtime.mjs`.
5. Preserve existing output contracts exactly:
   - `UserPromptSubmit` additional context output remains unchanged.
   - `Stop` block output remains unchanged.
6. Run:
   - `node inject-protocol/test-inject-protocol-core.mjs`
   - `node inject-protocol/test-inject-protocol-self-test.mjs`
   - `node quality-completion-gate/test-quality-gate-core.mjs`
   - `node _core/test-hook-runtime.mjs`
   - `node _core/validate-runtime-hooks.mjs`

**Expected result:** Node hooks enforce the same control-plane contract as Python hooks.

**Commit:** `refactor: use shared node hook runtime`

## Phase 5: Scope Enforcement

### Task 5.1: Implement shared scope matching

**Files:**

- Modify: `_core/hook_runtime.py`
- Modify: `_core/hook-runtime.mjs`
- Modify: `_core/test-hook-runtime.py`
- Modify: `_core/test-hook-runtime.mjs`
- Modify: `_core/config-model.mjs`
- Modify: `quality-completion-gate/test-config-model.mjs`
- Modify: `config.schema.json` after regeneration

**Steps:**

1. Define scope semantics:
   - `scope.projects: ["*"]` matches all projects.
   - `scope.paths: ["**"]` matches all paths.
   - project names compare against `detect_project` output and configured project slugs.
   - path globs compare against cwd relative to the detected repo root when available.
2. Add tests for wildcard scope, matching project scope, nonmatching project scope, matching path scope, and nonmatching path scope.
3. Implement Python scope check in `_core/hook_runtime.py`.
4. Implement Node scope check in `_core/hook-runtime.mjs`.
5. Add config-model validation that `scope.projects` and `scope.paths` are non-empty string arrays.
6. Regenerate schema.
7. Run Python and Node runtime tests.
8. Run `node _core/validate-runtime-hooks.mjs`.

**Expected result:** scope fields become enforceable and current wildcard config remains behaviorally unchanged.

**Commit:** `feat: enforce hook scope metadata`

## Phase 6: Quality Command Execution Hardening

### Task 6.1: Add argv command support

**Files:**

- Modify: `quality-completion-gate/quality-gate-core.mjs`
- Modify: `quality-completion-gate/test-quality-gate-core.mjs`
- Modify: `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Add tests for command objects shaped as:
   - `{ "cmd": "node", "args": ["--version"] }`
   - `{ "command": "node --version", "shell": true }`
   - `{ "command": "node --version" }` rejected or treated as legacy with a warning during the transition
2. Update `commandsForDomains()` de-duplication to include `cmd`, `args`, `command`, and `shell`.
3. Update `runVerifyCommand()` to use `execFileSync(cmd, args)` when `cmd` exists.
4. Keep shell execution only when `shell: true`.
5. Convert the hooks repo manifest commands to `cmd` plus `args` arrays where practical.
6. Leave complex chained commands as explicit `shell: true` only until Phase 6.2 splits them.
7. Run `node quality-completion-gate/test-quality-gate-core.mjs`.

**Expected result:** the quality gate no longer depends on shell parsing for ordinary commands.

**Commit:** `fix: support argv quality commands`

### Task 6.2: Split chained manifest commands

**Files:**

- Modify: `quality-completion-gate/quality-verify-manifest.json`
- Modify: `quality-completion-gate/test-quality-gate-core.mjs`

**Steps:**

1. Split chained `&&` commands into separate command objects.
2. Convert every split command to `cmd` plus `args`.
3. Keep no `shell: true` commands in the hooks repo runtime domain unless a command truly requires shell behavior.
4. Run:
   - `node quality-completion-gate/test-quality-gate-core.mjs`
   - `node _core/validate-runtime-hooks.mjs`

**Expected result:** hooks repo verification commands run without shell metacharacter exposure.

**Commit:** `chore: split hooks manifest commands`

## Phase 7: Gate Cleanup and Conformance

### Task 7.1: Use shared git timeout in frontend design gate

**Files:**

- Modify: `frontend-design-gate/frontend-design-gate.py`
- Modify: `frontend-design-gate/test-frontend-design-gate.py`

**Steps:**

1. Add a test that configures `shared.runtime.gitTimeoutMs` to a distinct value and asserts `_git()` receives that value.
2. Change `_git(repo, *args)` to accept `timeout_ms`.
3. Pass `shared.runtime.gitTimeoutMs` from `handler()` into `_repo_root()`, `_added_lines()`, and other git callers.
4. Keep standalone `--repo` behavior using the same default from config when available or 5000ms otherwise.
5. Run `python frontend-design-gate/test-frontend-design-gate.py`.

**Expected result:** frontend gate git calls honor shared timeout.

**Commit:** `fix: honor shared git timeout in frontend gate`

### Task 7.2: Fix browser verify no-session state key collision

**Files:**

- Modify: `browser-verify-gate/browser-verify-gate.py`
- Modify: `browser-verify-gate/test-browser-verify-gate.py`

**Steps:**

1. Add a test invoking Stop payloads with empty `session_id` from two different cwd/repo inputs.
2. Confirm both payloads currently map to the same state path.
3. Change `_state_path` to use `session_id` when present.
4. When `session_id` is missing, hash a fallback object containing:
   - cwd
   - git repo root if available
   - transcript path if present in payload
5. Keep the hash bounded to the existing filename length style.
6. Run `python browser-verify-gate/test-browser-verify-gate.py`.

**Expected result:** no-session Stop invocations do not share one state file across unrelated repos/sessions.

**Commit:** `fix: isolate browser gate no-session state`

### Task 7.3: Add project detection conformance fixtures

**Files:**

- Create: `_core/project-detection-fixtures.json`
- Modify: `_core/hook_runtime.py`
- Modify: `_core/hook-runtime.mjs`
- Modify: `_core/test-hook-runtime.py`
- Modify: `_core/test-hook-runtime.mjs`
- Modify: `memory-normalizer/memory_retain.py` if its behavior differs
- Modify: `inject-protocol/inject-core.mjs` if its behavior differs

**Steps:**

1. Create fixture cases for:
   - exact repo path
   - repo child path
   - alias path segment
   - substring that must not match
   - unknown project
2. Add Python conformance tests that run `detect_project` against the fixture.
3. Add Node conformance tests that run the Node project detector against the same fixture.
4. Compare `memory-normalizer/memory_retain.py` and `inject-protocol/inject-core.mjs` behavior against the fixture.
5. If behavior matches, leave implementation duplicated and protected by fixtures.
6. If behavior differs, centralize only the differing project-detection logic into shared helpers.
7. Run:
   - `python _core/test-hook-runtime.py`
   - `node _core/test-hook-runtime.mjs`
   - `node inject-protocol/test-inject-protocol-core.mjs`
   - `python memory-normalizer/test-memory-runtime.py`

**Expected result:** project detection cannot silently drift across Python and Node.

**Commit:** `test: add project detection conformance`

## Phase 8: Hermetic Fixture Runner

### Task 8.1: Add cross-runtime payload fixtures

**Files:**

- Create: `tests/fixtures/payloads/user-prompt-submit.codex.json`
- Create: `tests/fixtures/payloads/pre-tool-use.codex.json`
- Create: `tests/fixtures/payloads/post-tool-use.codex-success.json`
- Create: `tests/fixtures/payloads/post-tool-use.codex-failure.json`
- Create: `tests/fixtures/payloads/stop.codex.json`
- Create: `tests/fixtures/payloads/user-prompt-submit.claude.json`
- Create: `tests/fixtures/payloads/pre-tool-use.claude.json`
- Create: `tests/fixtures/payloads/post-tool-use.claude-success.json`
- Create: `tests/fixtures/payloads/post-tool-use-failure.claude.json`
- Create: `tests/fixtures/payloads/stop.claude.json`
- Modify: `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Build fixtures from non-secret representative payload shapes.
2. Include only bounded sample fields needed by the hooks.
3. Include Codex failure as `PostToolUse` with structural failure response.
4. Include Claude failure as `PostToolUseFailure`.
5. Add fixture validation tests in the relevant hook test files.
6. Add `tests/fixtures/` to the quality manifest runtime domain.

**Expected result:** hook contracts are tested against stable payload examples for both runtimes.

**Commit:** `test: add hook payload fixtures`

### Task 8.2: Add a portable all-hooks test runner

**Files:**

- Create: `tests/run-all.mjs`
- Modify: `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Create `tests/run-all.mjs` that runs the standard test suite from repo root.
2. Use `spawnSync` or `execFileSync` with argv arrays.
3. Print command labels, exit codes, and short output tails.
4. Stop on first failure unless `--continue` is supplied.
5. Add the runner to the quality manifest.
6. Run `node tests/run-all.mjs`.

**Expected result:** one portable command verifies the hooks repo without live machine assumptions.

**Commit:** `test: add portable hooks test runner`

## Phase 9: Optional Audit Suggestions as Separate Follow-Up Plans

The following audit suggestions are not part of the first implementation because they add policy surface or false-positive risk. They are not ignored; each has a promotion trigger.

| Suggestion | Disposition | Promotion trigger |
|---|---|---|
| AST frontend scanning | Separate plan | Frontend gate false positives/negatives remain after regex cleanup. |
| Telemetry duration extraction | Separate plan | Live payload fixtures include reliable timing fields. |
| Dry-run modes for all hooks | Separate plan | Doctor and tests show operator need for bulk dry-run probes. |
| `HOOK_DEBUG` across every hook | Separate plan | Shared runtime migration is complete and debug output format can be consistent. |
| Config migrations | Separate plan | Config version changes require automated upgrade from older local installs. |
| Generated docs | Separate plan | Runtime wiring and doctor stabilize. |
| Source-grounding gate | Separate plan | Need emerges for claim/evidence enforcement and acceptable false-positive policy is defined. |
| Repo-context-loader hook | Separate plan | Injection output needs repo-specific runtime summaries beyond current protocol/skill/memory injection. |
| Dangerous-shell gate | Separate plan | Safety policy is approved for destructive command prevention. |
| Handoff audit hook | Separate plan | Multi-turn handoff failures recur after plan/verification discipline is applied. |
| Multi-agent edit lock | Separate plan | Concurrent agent file conflicts are observed in the same repo. |

## Full Verification Suite

Run this suite before claiming the implementation is complete:

```powershell
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
node quality-completion-gate/test-quality-gate-core.mjs
node _core/test-hook-runtime.mjs
node inject-protocol/test-inject-protocol-core.mjs
node inject-protocol/test-inject-protocol-self-test.mjs
node scripts/test-doctor.mjs
node tests/run-all.mjs
python _core/test-hook-runtime.py
python hook-telemetry/test-log-event.py
python thinking-gate/test-thinking-gate.py
python loop-safety/test-loop-guard.py
python memory-normalizer/test-memory-runtime.py
python memory-normalizer/normalize-after-store.py --self-test
python inject-protocol/test-recall-readonly.py
python inject-protocol/test-suggest-readonly.py
python inject-protocol/test-index-skills.py
python browser-verify-gate/test-browser-verify-gate.py
python frontend-design-gate/test-frontend-design-gate.py
python -m py_compile _core/hook_runtime.py hook-telemetry/log-event.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/maintain-existing-memories.py thinking-gate/thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py browser-verify-gate/browser-verify-gate.py frontend-design-gate/frontend-design-gate.py
```

For final verification, also run:

```powershell
git diff --check
```

## Acceptance Criteria

Implementation is complete only when all criteria are true:

1. Runtime config validation passes.
2. Python runtime skips wrong-event payloads.
3. Python runtime skips missing hook ids.
4. Node runtime has equivalent event/match/scope/enabled/failPolicy behavior.
5. Codex wiring template exists and is first-class.
6. Claude wiring template exists.
7. Doctor verifies wiring without printing secrets.
8. Hooks repo manifest matches `browser-verify-gate/` and `frontend-design-gate/`.
9. Telemetry-dependent enabled hooks require enabled telemetry.
10. Memory normalizer honors safe `settings.writes.memoryTable` and validates fixed write columns.
11. Tests no longer require the repo to live at `E:/hooks`.
12. Quality gate supports argv commands and does not shell ordinary commands.
13. Frontend gate honors `shared.runtime.gitTimeoutMs`.
14. Browser gate isolates no-session state.
15. Project detection has cross-language conformance coverage.
16. All commands in the full verification suite pass.
17. No live local runtime config, token, or secret is committed.
18. Disabled Stop gates remain disabled unless a separate approval enables them.

## Rollback Plan

Each phase is independently revertible by commit.

If a runtime slice breaks active hook behavior:

1. Revert only the latest phase commit.
2. Run the pre-phase focused tests again.
3. Run `node _core/validate-runtime-hooks.mjs`.
4. Leave wiring templates and docs in place unless they are the breaking change.

If portability changes break the current `E:/hooks` install:

1. Revert the path helper integration commit.
2. Keep test changes only if they still pass.
3. Restore `E:/hooks` defaults as explicit config values.
4. Re-run the live smoke tests.

If doctor output risks exposing secrets:

1. Stop using the doctor.
2. Revert `scripts/doctor.mjs`.
3. Keep runtime templates only if they contain no live values.

## Execution Notes

Execute in order. Do not batch phases.

Before each phase:

1. Run `git status --short --branch`.
2. Confirm only expected files are dirty.
3. Run the focused baseline command for the files being touched.

After each phase:

1. Run the phase-specific tests.
2. Run `node _core/validate-runtime-hooks.mjs`.
3. Run `git diff --check`.
4. Commit with the phase commit message.
5. Record verification in this plan or a sibling implementation log.

Do not enable new gates, change live Codex config, change live Claude settings, or mutate live memory data during this implementation without a separate explicit approval.
