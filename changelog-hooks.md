# Changelog

Project: hooks

## Update Rule

Every time work changes the hooks codebase, find and update this changelog before the task is considered complete.

A codebase change includes source code edits, migrations, configuration changes, dependency changes, scripts, tests, docs that affect implementation behavior, or store/API/data changes tied to this project.

## Entries

### 2026-06-27 - Merge quality and risk Stop gates

- Added `completion-quality-gate/` as the single Stop-chain gate for required
  quality checks plus implementation-risk/live-verification policy, replacing
  separate `quality-completion-gate` and `agent-diff-completion-gate` Stop-chain
  entries.
- Changed `stop-completion-chain` and `task-policy` to select and run only
  `completion-quality-gate` for the old quality/risk responsibilities while
  preserving the old quality and agent-diff scripts as internal phase executors.
- Changed config validation to require `completion-quality-gate`, reject the old
  quality/agent-diff hooks as direct Stop-chain entries, and ensure the merged
  gate remains fail-closed with expected phase scripts and timeout ordering.
- Changed hooks verification manifest and tests to cover the merged gate,
  updated Stop policy/unit tests for the new single-gate status, and regenerated
  the derived config schema.

### 2026-06-27 - Prohibited fraudulent implementation methods Stop gate

- Added `prohibited-fraud-completion-gate/` as the canonical Stop gate for Jon's
  prohibited fraudulent implementation methods rule. The gate requires the
  configured governance document to exist in JWC, KC, TFO, kai-agent, and DBASE,
  verifies every document contains the prohibited-class phrases, and scans
  current implementation diffs for deterministic fraud/bypass patterns before
  completion.
- Changed `stop-completion-chain` to run
  `prohibited-fraud-completion-gate` before quality and agent-diff gates, while
  keeping `memory-harvester` as the fail-open pre-step.
- Changed `_core/config-model.mjs` and config-model tests so the prohibited
  fraud gate is required, fail-closed, mapped to all five governance documents,
  and present in the Stop chain.
- Changed the hooks verify manifest to classify the new gate directory, run its
  focused self-test, and include it in Python syntax coverage.

### 2026-06-24 - Inject no-fabrication family policy

Adds Jon's canonical no-fabrication rule to the per-prompt protocol injection so
Codex, Claude, Cursor, and related workers receive it as active operating
context. The policy is semantic, not keyword-based: UI, route, API, or
verification behavior that makes unavailable or unproven functionality look real
is forbidden across kai-chattr/KC, JWC, TFO, DBASE, and related repos.

### 2026-06-22 - Require saved implementation plan artifacts

Adds a global injected worker rule requiring implementation plans to be saved as
durable file artifacts with exact hashes before evaluation or execution. This
prevents terminal-only plans from bypassing the artifact needed by auditors and
watchdogs: auditors evaluate a specific saved plan hash, and watchdogs monitor
implementation against the approved hash baseline.

### 2026-06-21 - Stop task-policy hardening pass 2 (re-review findings)

Addresses three re-review findings against the post-review hardening.

- Fixed (F1, read-only git): `task-policy-guard.mjs` removed the mutating-capable
  git subcommands (`branch`, `tag`, `remote`, `config`) from the read-only git
  allowlist and now denies any git segment with `--output` (file write). Verified
  gaps `git branch X` / `git tag v1` / `git remote add` / `git config k v` /
  `git diff --output` are now denied while read-only; `git status|log|diff|show`
  still allowed. (+2 guard tests, 23 total.)
- Fixed (F3, Stop failure sanitization): `stop-completion-chain.mjs`
  `sanitizeFailureDetail` now drops imperative-shaped lines and instruction
  phrases ("Read and follow…", "Run the verification commands…", "Do not skip…",
  "Completion message must cite…", "run.json", "load skill", "waza") while keeping
  factual detail (gate ran N, exit code, file:line). Regression test added
  (integration suite now 17 named scenarios).
- Fixed (F2 / IMPL-003): `examples/cursor/hooks.full-stack.fragment.json` now
  includes the `task-policy-guard` PreToolUse entry, matching the live wiring.
- No change (scoped out): `examples/cursor/hooks.fragment.json` and
  `examples/claude/stop-hooks.fragment.json` are Stop-only fragments (no
  PreToolUse, no task-mode-gate/envelope source); a PreToolUse guard has nothing
  to enforce there and the plan intentionally keeps them Stop-only. Full policy
  wiring is shown by `hooks.full-stack.fragment.json`,
  `examples/codex/task-policy-hooks.fragment.toml`, and the live configs.
- Plan decision: plan v1.1 unchanged — F2 was already in Task 5; F1/F3 are
  hardening beyond the plan's contract. No locked decision altered.
- Verification: full node chain green (task-policy core 29 + guard 23, task-mode,
  quality + verification-integrity + config-model, agent-diff, stop-chain unit +
  17/17 integration, hook-dev-tools, validate-runtime-hooks).

### 2026-06-21 - Stop task-policy hardening (post-review)

Addresses findings from the implementation + blind reviews of the task-policy
control plane.

- Fixed (directive over-match): `task-policy-core.mjs` `parseDirectives` no longer
  treats a bare "read-only" mention as a directive. It now requires directive
  intent (`mode: read-only`, "keep/make/set … read-only", "read-only mode/task",
  "do not modify/edit/change/write"). Discovered by dogfooding — a prompt that
  merely *discussed* read-only enforcement was locking the session.
- Added (read-only shell policy): `task-policy-guard.mjs` now denies non-discovery
  shell commands while read-only is active (not just file-mutating tools and heavy
  commands). Conservative allowlist of read-only binaries + git read-subcommands;
  compound commands and write redirections are parsed and denied; deny-unknown is
  the default. New `shellIsReadOnlySafe` export + 6 guard tests (21 total).
- Changed (cheaper fingerprinting): `task-policy-core.mjs` `fileFingerprint`
  content-hashes only files ≤ 512KB and falls back to a size+mtime fingerprint for
  larger/unreadable paths, so baseline/delta no longer reads full contents of huge
  dirty files on every prompt and Stop. Deletions hash as absent.
- Changed (append-only decision log): `appendDecision` now appends a single JSONL
  line (race-free for concurrent Stops) with amortized rewrite-trim only past 2×
  the cap, instead of read-modify-write on every append.
- Changed (structured Stop failure): `stop-completion-chain.mjs` now emits a
  sanitized, bounded, non-imperative failure summary (gate + command ids +
  redacted detail) instead of a contentless "gate failed" message; extracted
  `runIntegrityAudit`, `sanitizeFailureDetail`, `failureSummary` helpers.
- Deferred (with rationale): separating agent-diff's legacy remediation renderer
  from executor logic — that path is not the live Stop path (the chain owns
  messaging), so the 2.3k-line refactor is high-risk/low-reward for now.
- Verification: full node chain green (task-policy core 29 + guard 21, task-mode,
  quality + verification-integrity + config-model, agent-diff, stop-chain unit +
  16/16 integration, hook-dev-tools, validate-runtime-hooks).

### 2026-06-21 - Stop task-policy control plane (Active Task Envelope)

Adds a shared in-process task-policy subsystem so Stop verification and heavy
commands obey the active user task and explicit directives instead of treating
the whole dirty worktree as current work. Implements plan
`_briefs/2026-06-21-stop-task-policy-control-plane-implementation-plan.md` (v1.1);
execution evidence in the matching `-execution-manifest.md`.

- Added: `task-policy/task-policy-core.mjs` — Active Task Envelope lifecycle,
  deterministic directive parsing + precedence, git baseline + task-relative
  change calculation, command classification, Stop gate selection/disposition,
  bounded decision JSONL, and unchanged-failure fingerprints. Tested by
  `task-policy/test-task-policy-core.mjs` (29 checks).
- Added: `task-policy/task-policy-guard.mjs` — PreToolUse guard that denies only
  what the active task explicitly forbids (read-only mutations, forbidden
  scopes, heavy browser/full-suite commands; conservative on missing policy
  state). Reuses the `loop-safety` `tool_input.command` precedent. Tested by
  `task-policy/test-task-policy-guard.mjs` (15 checks).
- Added: `agent-diff-completion-gate/agent-diff-policy.mjs` — pure
  applicability + selected-route helpers shared by the gate and the policy core.
- Added: `stop-completion-chain/test-stop-policy-integration.mjs` — the 16 named
  acceptance scenarios (read-only skip, browser/full-suite suppression,
  task-relative delta, carops config-only, unchanged-blocker no-rerun,
  integrity non-override, neutral status, guard denial, etc.). 16/16 pass.
- Added: `examples/codex/task-policy-hooks.fragment.toml` — complete Codex
  prompt + guard + Stop policy wiring example with a neutral Stop status.
- Changed: `stop-completion-chain/stop-completion-chain.mjs` is now the sole Stop
  policy + disposition authority — loads the envelope, runs the non-overridable
  verification-integrity audit, computes task-relative changes, selects gates,
  runs only selected executors with policy context, owns block/report-only,
  suppresses unchanged blockers, appends a bounded decision record, and emits a
  truthful dynamic status. Conservative no-heavy-gate on missing/stale envelope;
  top-level fail-safe preserved.
- Changed: `task-mode/task-mode-gate.mjs` creates/amends the envelope (captures
  the git baseline) fail-open; `task-mode/planning-start-gate.mjs` mirrors the
  planning checkpoint onto the envelope.
- Changed: `quality-completion-gate/quality-completion-gate.mjs` and
  `agent-diff-completion-gate/agent-diff-completion-gate.mjs` consume
  `taskPolicy.taskChangedFiles` (task-scoped file set) and quality skips
  command classes a directive forbids. Direct/legacy invocation behavior is
  unchanged (existing gate tests still pass).
- Changed: `_core/config-model.mjs` validates `shared.taskPolicy` and the
  `task-policy-guard` hook (event/script/fail-open + companion dependencies);
  `_core/validate-runtime-hooks.mjs` rejects a stale, gate-claiming Codex Stop
  status in example wiring (neutral status required). Schema regenerated.
- Changed: `config.json` adds the `shared.taskPolicy` block and the
  `task-policy-guard` PreToolUse hook;
  `quality-completion-gate/quality-verify-manifest.json` declares the
  `task-policy/` verify domain + tests and stable ids/classes for the
  carops/kai-chattr commands.
- Changed: `examples/codex/stop-hooks.fragment.toml` Stop status is now neutral
  ("Evaluating Stop policy") instead of falsely claiming quality/Playwright/review.
- Fixed: the flaky single-flight timing assertion in
  `quality-completion-gate/test-quality-gate-core.mjs` (load-sensitive
  `<500ms` proxy) made deterministic; correctness check (`runCount===1`) intact.
- Verification (node, this session): all of test-task-policy-core,
  test-task-policy-guard, test-task-mode-core, test-quality-gate-core,
  test-verification-integrity, test-config-model, test-agent-diff,
  test-stop-completion-chain, test-stop-policy-integration (16/16),
  test-hook-dev-tools, and validate-runtime-hooks pass; config schema
  regenerates clean.
- Runtime cutover (applied): external user-level wiring updated —
  `~/.codex/config.toml` (added `task-policy-guard` PreToolUse + neutral
  "Evaluating Stop policy" status), `~/.claude/settings.json` and
  `~/.cursor/hooks.json` (added the `task-policy-guard` PreToolUse hook). Each
  file was snapshotted to `.state/task-policy/runtime-backup/<timestamp>/` before
  editing; all parse and `node _core/validate-runtime-hooks.mjs` passes.
- Manifest metadata: all 49 verify commands now carry stable `id` + non-empty
  `classes` (0 missing). The flaky single-flight timing assertion in
  `test-quality-gate-core.mjs` was made deterministic.
- Final verification: full node regression chain green under load (task-policy
  core/guard, task-mode, quality gate + verification-integrity + config-model,
  agent-diff, stop-chain unit + 16/16 integration, hook-dev-tools,
  validate-runtime-hooks, schema regen).

### 2026-06-20 - Register skill-perfectionists quality coverage

- Added: `quality-completion-gate/quality-verify-manifest.json` now recognizes
  `E:/skill-perfectionists` and runs a lightweight `git diff --check` gate for
  repo changes.
- Changed: The new repo entry uses `blockOnUnmatched: true` so future local
  changes must stay covered by an explicit verification domain.

### 2026-06-20 - Register TFO quality completion coverage

- Added: `quality-completion-gate/quality-verify-manifest.json` now recognizes
  `E:/tfo` with a docs gate for root planning artifacts and a prototype gate for
  `v0.1` Python, proto, hook, and adapter surfaces.
- Changed: TFO is configured with `blockOnUnmatched: false` while the new repo
  has no committed baseline, so Stop can classify known surfaces without
  blocking unrelated bootstrap files.
- Changed: TFO prototype Stop checks are bootstrap-safe and avoid package
  download or `node_modules` assumptions until the repo has an installed
  dependency baseline.

### 2026-06-19 - Store harvester rows through sqlite_vec

- Fixed: `memory-harvester` now writes production memory rows through a
  `mcp-memory-service` sqlite_vec bridge so new rows receive vector embeddings
  instead of only `memories` and FTS rows.
- Changed: the harvester vector store path uses `BAAI/bge-small-en-v1.5` and
  keeps Hindsight disabled/secondary until a separate cutover is ready.

### 2026-06-19 - Add JWC auth slot lease tool

- Added: `auth-slot-lease/claim-auth-slot.mjs` and
  `auth-slot-lease/release-auth-slot.mjs` so local launchers can claim and
  release SOPS-provisioned JWC synthetic agent identities without storing lease
  state in product repos or Postgres.
- Added: `auth-slot-lease/test-auth-slot-lease.mjs` covering parallel claims,
  exhausted pools, stale lease reclaim, and token-scoped release protection.
- Changed: The quality completion manifest now recognizes the new
  `auth-slot-lease/` root and runs the targeted lease tests.

### 2026-06-19 - Add config-aware hook development QA

- Fixed: Skill indexing now uses the live `E:/_skills` warehouse instead of the
  stale `E:/__skills` path, with config-model and runtime validation to catch
  future scan-root drift.
- Added: `hook-dev-tools/test-hook.mjs` as a Windows-first, config-aware hook
  development utility for sample event payloads, contract linting, and explicit
  selected-hook execution.
- Fixed: `task-mode` state is keyed by canonical git repo root and records a
  prompt-time telemetry high-water mark so old same-session skill/thinking
  events cannot satisfy later planning checkpoints.
- Fixed: `agent-diff-completion-gate` now writes state under configured
  `settings.stateDir` instead of the hardcoded fallback path.
- Changed: `stop-completion-chain` now derives the enabled Stop sequence from
  `scripts[id=stop-completion-chain].settings.chain` while preserving
  memory-harvester as a fail-open pre-step.

### 2026-06-19 - Add operation-based memory harvest admission

- Added: deterministic `memory-harvester/eval-harvest-quality.py` replay harness
  with labeled garbage, durable insert, duplicate, and correction/supersede
  cases.
- Changed: Spark harvester extraction now accepts operation-shaped rows
  (`insert`, `skip`, `supersede`) with confidence, reason, evidence, and
  `supersedes_id` fields instead of content-only candidates.
- Added: `memory-harvester` retrieves related active SQLite memories before LLM
  extraction and injects that context into the configured Spark prompt so the
  model can choose skip or supersede instead of blindly appending.
- Changed: Supersede operations insert the replacement memory and mark the old
  active row with `superseded_by=<new_id>` in the same SQLite transaction.
- Changed: Completion-gate manifest now compiles and runs the memory harvest
  eval harness test.

### 2026-06-19 - Quality gate locks before preflight

- Fixed: `quality-completion-gate` now acquires its per-repo single-flight lock
  immediately after resolving the git root, instead of waiting until after git
  status, manifest matching, and fraud preflight work.
- Fixed: concurrent Stop hooks can no longer miss the first runner and rerun the
  same manifest command set just because the first runner finished before the
  second reached the late lock site.
- Added: the core single-flight regression now creates a heavier dirty repo and
  asserts the slow manifest command runs exactly once, not just that the second
  gate returns quickly.

### 2026-06-19 - Add long transcript harvester probe

- Added: `memory-harvester/probe-long-transcript.py` builds a temporary
  100-exchange transcript from local Codex session JSONL files and runs the
  harvester against an isolated SQLite DB/state directory.
- Safety: The probe does not write to the production memory DB, disables
  Hindsight unless explicitly requested, and reports hashes/lengths instead of
  raw past-session transcript text by default.
- Changed: Probe output is compact by default and requires `--full-output` for
  per-row hash details.

### 2026-06-19 - Count harvester cadence from full transcript

- Fixed: `memory-harvester` now counts exchange cadence from the full transcript
  stream while still reviewing only the configured transcript tail, preventing
  long sessions from making `exchangeCount` drop after the tail window rolls.
- Added: Regression coverage for a long transcript with a tiny tail window so
  the fourth and eighth exchanges both run on the intended cadence.

### 2026-06-19 - Gate memory harvester cadence on exchange count

- Fixed: `memory-harvester` now uses intuitive cadence names:
  `reviewLastExchanges` is the scan window and `runAfterNewExchanges` is the
  run cadence, so the Stop hook can fire after every assistant response while
  extraction runs only every configured four exchanges.
- Added: Harvester state now records `lastHarvestExchangeCount` and skips with
  `harvest_interval_not_reached` until enough new assistant exchanges exist.
- Removed: Ambiguous live config keys `maxExchanges` and
  `harvestEveryExchanges`; validation now rejects them in favor of the
  operator-readable names.
- Added: Regression coverage for the first three exchanges skipping, the fourth
  exchange harvesting, and the fifth exchange skipping again.
- Changed: README/STACK docs now call out the Stop-vs-cadence split explicitly.

### 2026-06-19 - Force all Hindsight LLM startup paths to Codex Spark

- Fixed: `hindsight/ensure-hindsight.ps1` now forces both default and retain
  Hindsight LLM env to the configured Codex Spark proxy, preventing stale
  SOPS/OpenAI/Mistral env from surviving process restarts.
- Added: Config-model validation now fails when
  `memory-harvester.settings.hindsight.retainLlm` drifts from
  `memory-harvester.settings.extraction.llm`.
- Changed: Hindsight README now documents Codex Spark as the single local LLM
  target for Hindsight startup and retain extraction.
- Fixed: `memory-sync/purge-backfill-documents.py` now rescans after delete
  passes and reports dry-run matches as `wouldDelete`, not fake deletions.
- Removed: orphan retain-specific Codex proxy helper; Hindsight now uses the
  canonical `ensureScript` from `config.json`.
- Runtime cleanup: Force-restarted Hindsight onto Codex Spark, deleted the bad
  TFO retain-test document, purged stale `sqlite-memory:*` Hindsight backfill
  documents, and removed queued SQLite-backfill async retain operations while
  leaving `E:/_memory/memory-sqlite.db` untouched.

### 2026-06-19 - Hindsight sync uses strategy=exact (no second LLM on copy)

- Changed: harvester → Hindsight and SQLite backfill pass `strategy: exact` so Postgres
  gets the same memory text Spark already wrote to SQLite — retain LLM does not re-extract.

### 2026-06-19 - Purge bad backfill; Hindsight retain LLM → Codex Spark

- Added: `memory-sync/purge-backfill-documents.py` deletes `sqlite-memory:*` Hindsight documents.
- Changed: `ensure-hindsight.ps1` retain LLM now uses Codex Spark via `http://127.0.0.1:8787/v1`
  (same contract as harvester), not Mistral.
- Changed: `memory-harvester` hindsight sync stays disabled until verbatim backfill is ready.

### 2026-06-19 - Revert Hindsight-primary recall; SQLite primary again

- Changed: Restored `inject-protocol` memory `provider: sqlite` with fallback off.
  Hindsight recall cutover stays deferred until backfill completes and is explicitly requested.

### 2026-06-19 - Cover memory-sync utilities in hooks docs and verification

- Changed: Added `memory-sync/` to the hooks runtime verify domain so Stop
  classifies the new SQLite-to-Hindsight backfill utilities instead of blocking
  them as unmatched files.
- Changed: Root docs now describe `memory-sync/` as a manual migration utility,
  including a safe dry-run command for local operators.

### 2026-06-19 - Add hooks root docs package

- Added: root `AGENTS.md`, `README.md`, `STACK.md`, and
  `WORKER-ACCESS.example.md` so `hooks` now has the same repo-entry docs package
  used in the other local repos.
- Changed: `.gitignore` now ignores local `WORKER-ACCESS.md` notes.
- Changed: `quality-completion-gate/quality-verify-manifest.json` now classifies
  the new root docs under the hooks runtime verify domain so Stop does not block
  them as unmatched paths.

### 2026-06-19 - Cover hooks brief artifacts in verification manifest

- Fixed: Added `_briefs/` to the hooks runtime verify domain so Stop-gate
  planning and implementation brief artifacts are classified instead of
  blocking completion as unmatched files.

### 2026-06-19 - Auto-sync memory-harvester stores to Hindsight

- Added: `memory-harvester/harvest_hindsight.py` calls Hindsight MCP `retain`
  (async, default) after new SQLite harvest rows are stored on Stop.
- Changed: `memory-harvester` settings now include `hindsight.enabled` (default
  on) with `document_id=sqlite-memory:{content_hash}` for cross-store linkage.
- Note: Hindsight retain failures are fail-open; SQLite harvest still completes.

### 2026-06-19 - Repo-root changelog protocol

- Changed: Updated the injected per-prompt protocol to point changelog updates
  at repo-root files (`changelog-hooks.md` / `CHANGELOG.md`) instead of the
  Planned store.

### 2026-06-19 - Cover harvester/proxy files in hooks verification manifest

- Fixed: Added `codex-proxy/` and `memory-harvester/` to the hooks runtime
  verify domain so the quality completion gate classifies the new Stop-time
  memory capture files instead of blocking them as unmatched paths.

### 2026-06-19 - Codex proxy logon task for Spark harvester

- Added: `codex-proxy/ensure-codex-proxy.ps1`, `verify-codex-proxy.ps1`, and
  `install-startup-task.ps1` to keep `127.0.0.1:8787` available for
  `memory-harvester` LLM extraction (`gpt-5.3-codex-spark`).
- Added: `JWC-Codex-Proxy-8787` logon task and harvester `autoEnsureProxy` for on-demand recovery.
- Removed: `JWC-Codex-Proxy-8787-Watchdog` (5-minute polling flashed a console; replaced by silent logon + Stop-time ensure).

### 2026-06-19 - memory-normalizer toolGroup shrinks config.json

- Changed: `memory-normalizer` uses `match.toolGroup: memoryMutation` instead of
  duplicating 50 tool names in `match.tools` and `settings.sourceTools`.
- Added: `_core/hook_runtime.py` expands built-in tool groups for match filtering.


- Changed: `memory-harvester` default extraction is `settings.extraction.mode=llm`
  using `settings.extraction.llm` (model, proxy baseUrl, prompts, timeouts) — all
  tunables live in `config.json`, not hidden in code.
- Added: `memory-harvester/harvest_llm.py` OpenAI-compatible client for local Codex
  subscription proxy (`gpt-5.3-codex-spark` by default).
- Added: heuristic fallback via `settings.extraction.fallbackMode=heuristic` when
  the proxy is unavailable; readonly LLM parse/prompt tests.

### 2026-06-19 - Stop memory harvester for SQLite capture

- Added: `memory-harvester/harvest-stop.py` Stop hook scans recent transcript
  exchanges for durable facts and writes new rows into
  `E:/_memory/memory-sqlite.db` with FTS indexing.
- Added: deterministic harvest heuristics, per-session idempotency under
  `.state/memory-harvester`, and readonly fixture tests.
- Changed: `stop-completion-chain` now runs `memory-harvester` as a fail-open
  pre-step before blocking completion gates.

### 2026-06-19 - SQLite-primary memory recall until Hindsight backfill

- Changed: `inject-protocol` memory provider is `sqlite` again so prompt recall
  uses `E:/_memory/memory-sqlite.db`, which still holds the live memory corpus.
- Changed: Hindsight fallback is disabled (`fallbackProvider: none`) until
  Hindsight is backfilled from the vector/SQLite store and can become primary.
- Changed: per-prompt protocol section A now documents vector/SQLite as the
  active recall and retain path during the migration gap.

### 2026-06-19 - Hindsight Mistral retain LLM

- Changed: SOPS-backed Hindsight startup now maps `MISTRAL_API_KEY` into the
  retain-only LLM path without printing key material.
- Changed: Hindsight retain defaults now use `litellm` with
  `mistral/mistral-small-latest`, retain concurrency capped to one, and retain
  batch mode disabled for local/free-tier operation.
- Added: `ensure-hindsight.ps1 -ForceRestart` so config changes can be applied
  to the running native Hindsight process.
- Added: `verify-hindsight.ps1 -RetainSmoke` to prove the live `sync_retain`
  path, not just MCP tool availability.

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
