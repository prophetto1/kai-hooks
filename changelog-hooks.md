# Changelog

Project: hooks

## Update Rule

Every time work changes the hooks codebase, find and update this changelog before the task is considered complete.

A codebase change includes source code edits, migrations, configuration changes, dependency changes, scripts, tests, docs that affect implementation behavior, or store/API/data changes tied to this project.

## Entries

### 2026-06-19 - Hindsight-primary inject-protocol memory provider

- Changed: `inject-protocol` now treats Hindsight as the primary memory recall
  provider via `http://127.0.0.1:10003/mcp/collective/`.
- Changed: SQLite/vector memory remains as an explicit compatibility fallback
  and skill index, with diagnostics emitted whenever fallback recall is used.
- Added: Hindsight provider config validation and runtime smoke coverage for
  required Hindsight MCP tools.
- Changed: `memory-normalizer` config text now marks the old row normalizer as
  legacy SQLite/vector behavior, not the durable Hindsight memory path.

### 2026-06-19 - Memory DB path and deleted-doc reference cleanup

- Changed: `shared.paths.memoryDb` now points at the live
  `E:/_memory/memory-sqlite.db` store, and memory-normalizer fallback defaults
  use the same `_memory` path.
- Changed: task-mode, planning-start, protocol, and runtime config text now
  point agents at `E:/hooks/skills-catalog.md` or `config.json` instead of
  deleted docs files.
- Changed: hooks quality manifest no longer declares the removed docs directory
  as an active runtime path.

### 2026-06-18 - ADCG policy refactor and browser gate removal

- Changed: `agent-diff-completion-gate` now reads per-repo `settings.repos[]`
  policies from `config.json` instead of using hardcoded repo rules.
- Added: ADCG policies support `rules[]` with path matchers and
  `files-or-loc` trigger thresholds, plus disabled repo policies for deferred
  adoption.
- Removed: `browser-verify-gate` from active config, Stop-chain defaults,
  runtime validation, quality-manifest commands, active runtime docs, and
  tracked source files.

### 2026-06-18 - Browser verification Stop gate disabled

- Changed: Disabled `browser-verify-gate` in `config.json` and removed it from
  the Stop completion chain metadata, so Stop no longer redirects agents into
  MCP browser verification after browser-relevant turns.
- Preserved: The gate implementation and tests remain in the repo for future
  re-enable work; `quality-completion-gate` and `agent-diff-completion-gate`
  remain in the Stop chain.

### 2026-06-18 - kai-agent dated architecture note domain

- Changed: `quality-completion-gate/quality-verify-manifest.json` now maps the
  root `kai-agent` architecture note `0618.txt` to the existing `kai-agent`
  repo verification domain, so the Stop gate runs the normal architecture,
  unit, compile, and whitespace checks instead of blocking it as unmatched.

### 2026-06-18 - Hindsight startup owner

- Added: `hindsight/` now owns native Hindsight recovery for MCP Router with
  `ensure-hindsight.ps1`, `verify-hindsight.ps1`, `install-startup-task.ps1`,
  and a runbook README.
- Changed: Registered the current-user Windows scheduled task
  `JWC-Hindsight-10003` to run the ensure script at logon and keep
  `http://127.0.0.1:10003/mcp/collective/` available after restarts.
- Verification: Ran the live MCP initialize and `tools/list` check; Hindsight
  returned 29 tools including `recall`, `list_memories`, `reflect`, and
  `sync_retain`.

### 2026-06-18 - Apache license standardization

- Changed: Root `LICENSE` now uses Apache License 2.0 for the public hooks repo.


### 2026-06-18 - kai-agent quality gate registration

- Added: `quality-completion-gate/quality-verify-manifest.json` now registers
  `E:/kai-agent` and runs its architecture guard, unit discovery, compile
  check, and diff whitespace check for touched repo files.


### 2026-06-18

- Fixed: `quality-completion-gate` single-flight contention now exits quietly with
  `continue: true` instead of emitting a blocking "already running" Stop prompt
  that can recursively retrigger itself.
- Tests: Updated the single-flight regression to cover block-mode contention
  without duplicate manifest execution or repeated Stop messages.
- Fixed: `quality-completion-gate` now ignores dirty nested reference git repos
  under managed parent repos when the nested root lives below `_extract_ref/`,
  `_references/`, `_sources/`, or `vendor/`. This prevents unrelated Stop turns
  from repeatedly reporting missing manifest entries for paths such as
  `E:/kai-chattr/_extract_ref/pydantic-ai`.
- Added: Regression coverage proving a dirty nested `_extract_ref/pydantic-ai`
  git repo under a manifest-managed parent returns `{"continue":true}` instead
  of a report-only missing-repo-entry failure.
- Changed: `inject-protocol/per-prompt-protocol_original.md` now names the Hindsight-native MCP Router memory tools (`recall`, `list_memories`, `reflect`, `sync_retain`) instead of the stale `memory_search`/`memory_store` vector-memory wrapper wording.

### 2026-06-17

- Changed: `browser-verify-gate` now blocks only large browser-relevant turns, using edit/write tool patterns and frontend runtime command patterns from config. Long read-only research, docs, and handoff turns no longer force a Playwright browser verification when there is no affected route to render.
- Tests: Added browser-verify regression coverage for large read-only turns allowing, while edit-backed large turns still require navigate plus snapshot/screenshot evidence.
- Changed: `browser-verify-gate` relevance is now target-driven instead of mutator-tool-name driven, so hooks/config patches do not trigger browser Stop interruptions while `apps/web/` and frontend runtime commands still do.
- Fixed: `apply_patch` relevance now inspects only patch file headers, preventing diff body text like `apps/web/`, `playwright`, or `ui-snapshot` from making hooks/config edits look browser-relevant.

- Changed: Added `jwc-global` to `config.json` shared project taxonomy so `E:/jwc-global` resolves to a real project scope in runtime detection and memory/project-set flows.
- Changed: Added `dbase` to hook memory project taxonomy/project sets so `E:/dbase` resolves to a real recall scope without enabling rebuild/governance handling.
- Fixed: `inject-protocol` memory recall now quotes FTS query terms in `recall.py`, so hyphenated project/tool names like `jwc-global` and `full-stack-ai-agent-template` no longer crash recall with FTS column-parse errors.

- Changed: `thinking-gate` exempts Cursor browser MCP tools (`browser_*`, `CallMcpTool`→cursor-ide-browser) so live localhost verification is not blocked by planning grants.

### 2026-06-16 (c)

- Added: `quality-completion-gate/verification-integrity.mjs` — explicit verification fraud policy, telemetry detection of mocked snapshot scripts, and session fraud-strike consequences on Stop.
- Changed: `agent-diff-completion-gate` and `quality-completion-gate` block Stop when mocked verification is detected or when verification artifacts lack `liveApi:true`.
- Changed: Injected per-prompt protocol section F documents verification fraud consequences; task-mode STOP docs mirror the policy.

### 2026-06-16 (b)

- Changed: Stop gates now require **live** Playwright verification for kai-chattr — `ui-snapshot-live.mjs` replaces mocked `ui-snapshot.mjs` in `quality-verify-manifest.json` and `agent-diff-completion-gate`.
- Changed: `agent-diff-completion-gate` rejects verification runs unless `run.json` has `liveApi: true` (mocked Playwright intercepts fail the gate).
- Changed: `quality-completion-gate`, `agent-diff-completion-gate`, and `stop-completion-chain` default `failureMode` to `block` so failed verification stops completion instead of report-only pass-through.

### 2026-06-16

- Changed: `quality-completion-gate` now uses a per-repo single-flight lock so concurrent Codex/Cursor Stop chains do not launch duplicate manifest commands against shared state.
- Changed: Single-flight locks whose owner PID is no longer running are cleared immediately, so force-killed gates do not block later Stop hooks until timeout.
- Tests: Added regression coverage that a second concurrent quality gate blocks immediately while the first owns the manifest run, and that dead-owner locks are cleared.
- Changed: Cursor Stop wiring is now chain-only. Removed the unsafe per-gate Cursor fragment and documented that Stop must route through `stop-completion-chain`.
- Changed: Runtime hook validation now rejects Cursor Stop hooks that call `quality-completion-gate`, `agent-diff-completion-gate`, or `browser-verify-gate` directly, and rejects project-level Cursor Stop when user-level Cursor Stop is already wired.
- Changed: Runtime hook validation now checks live Codex Stop wiring and the Codex example fragment, including chain-only wiring and a minimum 360s outer timeout.
- Changed: Codex/Claude Stop examples now use a 360s outer timeout so the runtime timeout exceeds the chain's configured per-step timeout.

### 2026-06-15 (d)

- Fixed: Cursor `thinking-gate` sequential-thinking deadlock by accepting `MCP:sequentialthinking`, narrowly recognizing `CallMcpTool` only when `toolName` is sequentialthinking, and normalizing Cursor MCP sequential-thinking telemetry to the canonical MCP-router tool name.
- Changed: Cursor adapter now maps raw Cursor sequential-thinking tool names before hooks see them so the same successful ST call opens the bounded grant window used by Codex/Claude.
- Tests: Added regression coverage for Cursor MCP ST exemption, `CallMcpTool` ST exemption, grant activation from raw/canonical ST telemetry, non-ST `CallMcpTool` denial, and Cursor-callable deny guidance.

### 2026-06-15 (c)

- Added: `task-mode/` — UserPromptSubmit mode classification + PreToolUse planning checkpoint before mutators; expanded skills table includes `refactor`, `code-review`, `receiving-code-review`, `requesting-code-review`, `review-bugbot`.
- Changed: `thinking-gate` read-only tool exemption; canonical mode/skill map; full three-layer stack.
- Changed: Wired live Cursor (`~/.cursor/hooks.json`), Codex, Claude, and kai-chattr project hooks for inject → task-mode → planning → thinking → telemetry → Stop chain.
- Verification: `node _core/validate-runtime-hooks.mjs`; `node task-mode/test-task-mode-core.mjs`; `node task-mode/task-mode-gate.mjs --self-test`.

### 2026-06-15 (b)

- Changed: LOC-tiered Stop flow — 1–500 LOC: Playwright → verification-before-completion; 501+: adds waza-hunt + 3 remediation loops.
- Changed: Removed blind-review requirement; sequential phase enforcement with git diff LOC counting.

### 2026-06-15

- Changed: `agent-diff-completion-gate` now triggers only on diffs under `apps/`, `services/`, or `scripts/` with operational file extensions; Playwright saves timestamped evidence to `docs/verification/<timestamp>/`.
- Changed: `scripts/dev/ui-snapshot.mjs` writes run folders with `report.json`, `run.json`, and `VERIFICATION_RUN_SUMMARY` for gate verification.
- Verification: `node _core/validate-runtime-hooks.mjs`; `node agent-diff-completion-gate/test-agent-diff-completion-gate.mjs`.

### 2026-06-14

- Added: `stop-completion-chain/stop-completion-chain.mjs` — canonical Stop orchestrator running quality → agent-diff → browser gates in sequence for Codex and Claude Code.
- Added: `agent-diff-completion-gate/test-agent-diff-completion-gate.mjs` smoke test and Codex/Claude/Cursor runtime wiring instructions.
- Added: `examples/codex/stop-hooks.fragment.toml` and `examples/claude/stop-hooks.fragment.json` templates.
- Changed: Wired live `~/.codex/config.toml` Stop hook to the completion chain (was quality-only).
- Changed: Wired live `~/.claude/settings.json` Stop hook to the completion chain (was missing).
- Changed: `config-model.mjs` validators for `agent-diff-completion-gate` and `stop-completion-chain`; quality-verify-manifest hooks domain updated.
- Verification: `node _core/validate-runtime-hooks.mjs`; `node stop-completion-chain/stop-completion-chain.mjs --self-test`.

### 2026-06-11

- Created this changelog in Planned/hooks.
- Established the rule that future hooks changes must update this file.
### 2026-06-11

- Changed: Moved detailed Planned Store worker instructions out of the injected per-prompt protocol and into `planned/hooks/planned-store-worker-guide.md`.
- Changed: Shortened `E:/hooks/inject-protocol/per-prompt-protocol_original.md` to point workers to the Planned guide and keep only the minimum endpoints/changelog rule in the injected message.
- Verification: Verified the guide document exists in the live Planned tree and ran `git diff --check -- inject-protocol/per-prompt-protocol_original.md`.
### 2026-06-11

- Changed: Created root-level `planned-store-worker-guide.md` for shared Planned store instructions that apply to all projects.
- Changed: Updated the injected per-prompt protocol to call it the shared Planned store and point to the root guide instead of a hooks-local guide.
- Verification: Verified the root guide exists in the live Planned tree and `git diff --check -- inject-protocol/per-prompt-protocol_original.md` passes.
### 2026-06-11

- Changed: Pushed hooks commit `81d87ad1e1172a1ee25424055f55b471b7c2939e` with updated hook audit/actionable docs, ST enforcement notes, Planned changelog protocol injection, thinking-gate MCP-router sequential-thinking alias support, and bounded grant max-tool-use tuning.
- Verification: `git diff --check`; `git diff --cached --check`; raw key-format scan of staged files; `node _core/validate-runtime-hooks.mjs`; `python thinking-gate/test-thinking-gate.py`; `python -m py_compile thinking-gate/thinking-gate.py`; post-push `HEAD == origin/main` and `git rev-list --left-right --count '@{u}...HEAD'` returned `0 0`.
