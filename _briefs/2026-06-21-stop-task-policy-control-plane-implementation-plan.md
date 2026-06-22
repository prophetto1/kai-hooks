# Stop Task Policy Control Plane Implementation Plan

**Goal:** Make Stop-time verification and heavy command execution obey the active user task, explicit directives, and task-relative changes without redirecting work into unrelated failures.
**Architecture:** Add one shared in-process task-policy subsystem that extends the existing task-mode state seam into an Active Task Envelope, evaluates gate applicability before Stop executors run, guards explicitly forbidden heavy commands at PreToolUse, and records auditable decisions. Keep `stop-completion-chain` as the sole Stop orchestrator; keep quality and agent-diff components as executors rather than independent policy authorities. Add no daemon, service, database, package, or network dependency.
**Repository profile:** Windows-first script control plane using Node `.mjs`, Python, PowerShell, Git inspection, JSON configuration, generated JSON Schema, local ignored `.state/` files, and user-level Codex, Claude, and Cursor hook wiring.
**Target repository:** `hooks` at `E:/hooks`
**Target branch:** `main`
**Plan lineage:** New plan; revised to v1.1 on 2026-06-21 to disposition evaluation findings PLAN-001–PLAN-005 (see Evaluation Findings Disposition).
**Status:** Revised (v1.1) — findings dispositioned; user authorized implementation
**Author:** Codex (revised by Claude)
**Date:** 2026-06-21

## Objective

Implement a deterministic policy boundary that:

1. captures the current task and latest explicit user directives at `UserPromptSubmit`;
2. computes changes made during that task instead of treating the entire dirty worktree as current work;
3. prevents explicitly forbidden heavy commands at `PreToolUse`;
4. selects only task-relevant Stop executors and manifest commands;
5. distinguishes skipped work, blocking failures, and report-only findings;
6. prevents Stop diagnostics from authorizing edits or unrelated remediation;
7. suppresses unchanged retry loops; and
8. emits a machine-readable decision record and truthful human-readable policy summary for every Stop run.

## Scope, Non-Goals, and Constraints

### Included

- A versioned Active Task Envelope shared by task-mode, planning, PreToolUse, and Stop handling.
- Explicit directive parsing and precedence for read-only work, browser verification, full-suite verification, scope restrictions, route selection, and report-only unrelated findings.
- Task-relative Git change detection that handles pre-existing dirty files and changes committed during the task.
- Central Stop policy evaluation before quality or live browser execution.
- Stable command IDs and command classes in the verification manifest.
- Structured executor results from quality and agent-diff components.
- First-class report-only handling that cannot auto-steer the agent into unrelated work.
- Unchanged-failure fingerprinting so the same blocker is not repeatedly executed.
- Runtime wiring and validation for Codex, Claude, and Cursor.
- Targeted regression coverage for all scenarios requested in the design review.
- Root documentation and changelog updates.

### Non-Goals

- No new local service, daemon, MCP server, database table, hosted system, or background worker.
- No product-repository changes in CareerOps, DBASE, Kai Chattr, JWC, or other managed repositories.
- No attempt to infer arbitrary natural-language intent with an LLM.
- No replacement of repository-native verification commands.
- No weakening of verification-integrity checks. A skipped browser gate must be reported as not run, never as passed.
- No automatic source edits or remediation performed by a Stop hook.
- No cleanup, staging, reverting, or rewriting of unrelated dirty changes already present in `E:/hooks`.

### Constraints

- `config.json` remains the source of truth for runtime tunables and wiring policy.
- `_core/config-model.mjs` remains the hand-maintained config/schema authority.
- `config.schema.json` remains generated output.
- `stop-completion-chain` remains the only managed Stop entry point.
- State remains local under ignored `E:/hooks/.state/`.
- The implementation must preserve current unrelated worktree changes:
  - modified `changelog-hooks.md`;
  - modified `config.json`;
  - modified `memory-harvester/harvest_core.py`;
  - modified `quality-completion-gate/quality-verify-manifest.json`;
  - untracked `auth-slot-lease/`;
  - untracked `memory-harvester/vector_store_bridge.py`.
- Current baseline is branch `main`, HEAD `efea8fe`.
- GitHub issue and pull-request searches found no existing task-policy implementation or open review thread to inherit.

### Assumptions

- Hook payloads continue to provide `session_id`, `cwd`, event name, and tool data as currently normalized by each runtime.
- User-level runtime files remain writable during the rollout task.
- Existing verification commands may be classified without changing what those commands execute.

### Unresolved Blockers

None.

## Investigation File Evidence

Every file listed in this section was read fully from line 1 to EOF.

| File | Why opened | Decision, fact, or constraint verified |
|---|---|---|
| `AGENTS.md` | Repository governance | `config.json` is the live control plane; schema regeneration, targeted tests, manifest coverage, and changelog updates are mandatory. |
| `README.md` | Subsystem ownership and hook flow | `task-mode`, `stop-completion-chain`, quality, agent-diff, adapters, and `.state/` are existing owners to extend. |
| `STACK.md` | Runtime and operational profile | The repository is script-first, Windows-first, Git-dependent, and does not need another service or dependency. |
| `skills-catalog.md` | Task-mode behavior authority | Planning, review, verification, and debugging skills are advisory workflow inputs, not justification for Stop-time scope expansion. |
| `_briefs/2026-06-19-hindsight-harvester-sync.md` | Local brief convention | `_briefs/YYYY-MM-DD-*.md` is the current repository-native location for planning artifacts. |
| `config.json` | Live hook and Stop configuration | Task-mode state, gate settings, agent-diff policy, and Stop chain order are currently configured independently. |
| `quality-completion-gate/quality-verify-manifest.json` | Command and domain authority | Commands lack stable IDs/classes; some domains run browser or full-suite checks that explicit directives must be able to suppress. |
| `task-mode/task-mode-core.mjs` | Existing prompt state precedent | Session-and-repo state, mode classification, telemetry watermarking, and planning checkpoints already exist. |
| `task-mode/task-mode-gate.mjs` | Current state producer | Every prompt overwrites a small mode record but does not capture task baseline, directives, scope, or route selection. |
| `task-mode/planning-start-gate.mjs` | Current PreToolUse consumer | It reads task-mode state and can be migrated to the shared envelope without adding another state authority. |
| `task-mode/test-task-mode-core.mjs` | Current task-mode test style | Temporary Git repositories and Node assertions are the local test precedent. |
| `stop-completion-chain/stop-completion-chain.mjs` | Stop orchestration authority | It currently invokes every enabled chain step and blocks on gate output without a shared policy decision. |
| `stop-completion-chain/test-stop-completion-chain.mjs` | Stop-chain tests | Current coverage validates order and output parsing but not task intent or gate selection. |
| `quality-completion-gate/quality-gate-core.mjs` | Git/manifest execution helpers | Current helpers inspect the full dirty worktree and execute manifest commands using exit codes. |
| `quality-completion-gate/quality-completion-gate.mjs` | Quality executor behavior | It independently decides relevance, owns retry state, and can emit blocking remediation prompts. |
| `quality-completion-gate/test-quality-gate-core.mjs` | Quality test precedent | Existing tests cover report-only mode, repeated blocking, budgets, locks, and temporary repositories. |
| `quality-completion-gate/test-config-model.mjs` | Config validation tests | Config mutations are tested by cloning the live config and asserting explicit validation errors. |
| `quality-completion-gate/verification-integrity.mjs` | Non-overridable safety policy | Mocked/non-live verification remains forbidden and cannot be disabled by task directives. |
| `quality-completion-gate/test-verification-integrity.mjs` | Integrity regression style | Safety rules have direct deterministic unit tests. |
| `agent-diff-completion-gate/agent-diff-completion-gate.mjs` | Browser/large-diff behavior | It currently combines applicability, execution, skill prompting, remediation loops, and blocking decisions in one module. |
| `agent-diff-completion-gate/test-agent-diff-completion-gate.mjs` | Browser gate tests | Temporary repositories and generated live artifact fixtures are the current test pattern. |
| `_core/validate-runtime-hooks.mjs` | Runtime wiring validation | It already enforces chain-only Stop wiring for Codex and Cursor and is the correct place to validate policy-guard wiring and neutral status text. |
| `hook-dev-tools/test-hook.mjs` | Hook payload and output contracts | The repository has reusable sample payload and JSON contract validation utilities. |
| `hook-dev-tools/test-hook-dev-tools.mjs` | Hook tool regression style | Runtime contract changes can be covered without executing arbitrary hooks. |
| `adapters/cursor/run-hook.mjs` | Cross-runtime normalization | Cursor maps prompts, tools, Stop continuation, and deny output into the common hook contract. |
| `examples/codex/stop-hooks.fragment.toml` | Codex example wiring | The current static status text falsely claims quality, Playwright, and review always run. |
| `examples/claude/stop-hooks.fragment.json` | Claude example wiring | Claude uses the same canonical Stop chain. |
| `examples/cursor/hooks.fragment.json` | Cursor Stop example | Cursor can route Stop through the canonical chain. |
| `examples/cursor/hooks.full-stack.fragment.json` | Cursor full hook example | The full example is the correct place to add the PreToolUse policy guard. |
| `.gitignore` | State persistence boundary | `.state/` is already ignored and is the correct local persistence location. |
| `changelog-hooks.md` | Historical decisions and recurrence evidence | Individual gates have repeatedly been narrowed or disabled, but no shared task-intent policy has been introduced. |

## Repository Evidence Matrix

| Concern | Current authority | Evidence | Fact status | Applies to this change? | Plan consequence |
|---|---|---|---|---|---|
| Repository governance | `AGENTS.md` | Config, schema, manifest, tests, and changelog rules | Observed | Yes | Follow native control-plane and verification workflow. |
| Workspace and toolchain | `STACK.md` | Node, Python, PowerShell, Git, JSON, local state | Observed | Yes | Implement in Node with existing built-ins; add no package. |
| User interface or client | None | Hooks produce runtime messages, not a visual UI | Not applicable | No | No page, route, component, or browser UI work. |
| Interfaces and shared contracts | Hook JSON payload/output contracts | `task-mode`, `stop-completion-chain`, Cursor adapter, hook-dev tools | Observed | Yes | Add envelope, decision, and executor-result contracts while preserving host-compatible final output. |
| Application and domain logic | Task-mode and Stop modules | Independent mode, quality, and agent-diff decisions | Observed | Yes | Centralize applicability and disposition in task-policy. |
| Persistence and data lifecycle | Ignored `.state/` JSON files | Existing task-mode and gate state files | Observed | Yes | Replace task-mode state with versioned envelope and append-only bounded decision logs. |
| Identity and access control | Runtime `session_id` plus repo root | State keys are session/repo scoped | Observed | Yes | Preserve session/repo isolation; no user auth or tenancy changes. |
| Background, scheduled, or realtime work | None for gates | Stop and PreToolUse are synchronous hooks | Not applicable | No | No worker or scheduled task. |
| External integrations | Git and runtime hook hosts | Git CLI; Codex, Claude, Cursor config files | Observed | Yes | Update wiring and validate it; no network dependency. |
| Runtime and deployment topology | User-level hook configuration | Codex/Claude/Cursor invoke local scripts | Observed | Yes | Roll out code/config first, then user-level wiring. |
| Configuration and secrets | `config.json`; no secret needed | Command strings may invoke SOPS in managed repos | Observed | Yes | Store command IDs/classes, never expanded secret values or raw outputs in policy logs. |
| Observability and operations | `.state/`, system messages, hooks DB | Gate state is currently fragmented | Observed | Yes | Add decision JSONL and dynamic policy summary. |
| Tests and validation | Repository-native Node tests and runtime validator | Commands listed in `AGENTS.md`, `README.md`, and manifest | Observed | Yes | Add targeted tests before broad runtime validation. |
| Documentation and governance | README, STACK, changelog, examples | Current docs describe unconditional chain | Observed | Yes | Document policy flow and update examples. |

## Nearest Current Precedent

The nearest useful precedent is the current task-mode state flow:

```text
UserPromptSubmit
  -> task-mode/task-mode-gate.mjs
  -> task-mode/task-mode-core.mjs state keyed by session + canonical repo
  -> task-mode/planning-start-gate.mjs at PreToolUse
  -> hook telemetry high-water mark
```

The implementation will evolve this path into:

```text
UserPromptSubmit
  -> task-mode-gate classifies mode
  -> task-policy-core creates or amends Active Task Envelope
  -> planning-start-gate reads the envelope
  -> task-policy-guard enforces explicit command/tool restrictions

Stop
  -> stop-completion-chain loads the envelope
  -> task-policy-core computes task-relative changes
  -> task-policy-core selects gate and command policy
  -> selected executors return structured results
  -> stop-completion-chain applies block/report-only disposition
  -> task-policy-core appends the decision record
```

Conventions to retain:

- canonical repo-root resolution;
- session-and-repo state keys;
- local ignored JSON state;
- config-driven behavior;
- temporary Git repository tests;
- chain-only Stop wiring;
- verification-integrity checks;
- fail-open memory harvesting.

Paths not to copy as architecture:

- per-gate independent relevance decisions;
- full dirty-worktree selection;
- remediation instructions emitted directly by executors;
- static status text claiming gates before policy evaluation;
- repeated reruns of an unchanged failure.

## Current State and Target State

### Current Observable Behavior

1. `task-mode-gate` writes only mode, explicit-mode status, a prompt snippet, telemetry watermark, and checkpoint status.
2. Every substantive or continuation prompt overwrites that state.
3. `planning-start-gate` uses the state only to require a planning skill before broad mutating tools.
4. `stop-completion-chain` invokes memory, quality, and agent-diff steps in configured order.
5. Quality and agent-diff independently inspect the full dirty worktree.
6. Quality commands are selected by manifest domain, but commands have no stable IDs or semantic classes.
7. Agent-diff combines path/LOC applicability, Playwright execution, verification-skill prompting, waza-hunt prompting, retry loops, and blocking output.
8. Codex displays `Running completion gates (quality, Playwright, review)` before any applicability decision.
9. A blocking Stop reason becomes a continuation prompt, so unrelated diagnostics can redirect the agent into new work.

### Target Observable Behavior

1. A prompt creates or amends one Active Task Envelope.
2. The envelope records task identity, baseline commit and dirty fingerprints, mode, sanitized objective, explicit directives, scope, selected routes, and prompt hash.
3. Continuation/directive-only prompts preserve the original task baseline; substantive new prompts start a new task baseline.
4. PreToolUse rejects only tools or heavy commands explicitly forbidden by the active envelope.
5. Stop computes files changed since the task baseline, including committed changes and excluding unchanged pre-existing dirt.
6. The chain runs the existing lightweight verification-integrity audit as a non-overridable invariant before suppression directives are applied.
7. Policy selects gates and allowed command classes before any heavy executor runs.
8. Executors consume the selected file list and return data; they do not authorize remediation.
9. The chain blocks only for integrity fraud or a failed verifier relevant to the active task and selected policy.
10. Unrelated findings are reported without `decision: block`, remediation language, edits, or reruns.
11. An unchanged blocker is executed once per unchanged input fingerprint; subsequent Stop continuations report the known blocker without rerunning it.
12. Codex initially displays `Evaluating Stop policy`; the hook output then states the actual selection.

### Boundaries That Remain Unchanged

- Hook host event names and final host-compatible JSON.
- `stop-completion-chain` as the only Stop entry point.
- Manifest ownership of repository verification commands.
- Existing verification-integrity rules.
- Memory harvester ordering and fail-open behavior.
- Git as the change-inspection authority.
- Local user-level runtime configuration model.

### Drift to Remove

- The quality gate's configured `failureMode` and repeated-block authority.
- The agent-diff gate's configured `failureMode`, remediation loop, and skill-redirection authority.
- Any executor path that recomputes the entire dirty worktree when policy context is present.
- Static status labels that claim unselected gates.

## Change Surface Manifest

| Surface | Status | Current authority | Planned change or verified no-change reason | Detailed section | Task(s) |
|---|---|---|---|---|---|
| User interface or client | Not applicable | No visual client | Runtime text only; no UI files | Runtime Output | 5 |
| Interfaces and shared contracts | Changed | Hook payload/output JSON | Add envelope, decision, and executor-result contracts | Contracts | 1, 3, 4 |
| Application and domain logic | Changed | Task-mode, quality, agent-diff, Stop chain | Centralize applicability and failure disposition | Policy Logic | 1-4 |
| Persistence and data lifecycle | Changed | `.state/` JSON | Versioned envelope, baseline fingerprints, bounded decision JSONL | State Lifecycle | 1 |
| Identity and access control | No change - verified | `session_id` + repo root | Preserve state isolation; no new privilege boundary | Identity | 1 |
| Background, scheduled, or realtime work | Not applicable | Synchronous hooks | No service or worker | Operations | None |
| External integrations | Changed | Git and runtime hook hosts | Add guard wiring and neutral status label | Runtime Wiring | 5 |
| Runtime and deployment topology | Changed | User-level config files | Ordered local cutover; no process deployment | Rollout | 5, 7 |
| Configuration and secrets | Changed | `config.json` and schema model | Add task-policy config and manifest metadata; no secrets | Configuration | 2, 5 |
| Observability and operations | Changed | Fragmented state/system messages | Decision JSONL and policy summary | Decision Records | 1, 4 |
| Tests and validation | Changed | Node tests and validator | Add policy and scope-drift regressions | Tests | 1-6 |
| Documentation and governance | Changed | README, STACK, examples, changelog | Document new authority and rollout | Documentation | 7 |

## Detailed Surface Contracts

### Contracts

#### Active Task Envelope

Owner: `task-policy/task-policy-core.mjs`

Storage: `E:/hooks/.state/task-policy/envelopes/<sha256(sessionId,repoRoot)>.json`

```json
{
  "schemaVersion": 1,
  "taskId": "sha256",
  "turnId": "sha256",
  "sessionId": "runtime session id",
  "repoRoot": "canonical absolute path",
  "mode": "explore|implement|fix|refactor|review|docs",
  "objective": "bounded redacted text",
  "allowedScopes": ["repo-relative prefix"],
  "forbiddenScopes": ["repo-relative prefix"],
  "selectedRoutes": ["/route"],
  "userDirectives": [
    {
      "kind": "read-only|browser-verification|full-suite|scope-lock|failure-scope",
      "value": "normalized value",
      "sourceHash": "sha256",
      "observedAt": "ISO-8601"
    }
  ],
  "baseline": {
    "commit": "git SHA",
    "dirtyFingerprints": {
      "repo/relative/path": "status-and-content sha256"
    }
  },
  "telemetryWatermark": 0,
  "checkpointDone": false,
  "startedAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastUserMessageHash": "sha256"
}
```

Rules:

- Do not persist raw prompt text.
- `objective` is bounded, secret-redacted, and derived from non-directive text.
- `changedFiles` is not stored as user-controlled envelope authority. It is derived at Stop and recorded in the decision.
- Substantive prompts start a new task baseline.
- Recognized continuation or directive-only prompts amend the active task.
- Latest explicit directive for the same kind supersedes the prior directive.
- Missing, malformed, or unsupported envelope versions select no heavy blocking gates and emit an honest policy-uncertainty message.

#### Directive Precedence

1. Non-overridable safety and verification-integrity invariants.
2. Latest explicit user directive in the active envelope.
3. Other active envelope fields.
4. Repository/domain configuration.
5. Task-relative changed-file inference.
6. Conservative default: no heavy command, no fabricated verification claim.

Normalized directive effects:

| Directive | Effect |
|---|---|
| `read-only` | Deny mutation tools and heavy runtime/verifier commands; skip quality and browser completion gates. |
| `bypass/skip/do not run Playwright` | Select browser verification as skipped and record that it was not performed. |
| `do not run the full backend/full test suite` | Deny commands classified `full-suite`; targeted checks remain eligible. |
| `do not change scope` | Findings outside task-relative files, allowed scopes, or selected routes are report-only. |
| `scope:` / `forbid-scope:` | Normalize repo-relative path prefixes and enforce them for mutations and findings. |
| `routes:` | Normalize selected browser routes and limit blocking browser results to those routes. |
| Explicit later allow/lift directive | Clears only the matching prior user restriction; cannot clear integrity policy. |

#### Stop Policy Decision

Owner: `task-policy/task-policy-core.mjs`

```json
{
  "schemaVersion": 1,
  "decisionId": "sha256",
  "taskId": "sha256",
  "repoRoot": "canonical path",
  "taskChangedFiles": ["repo-relative path"],
  "taskChangeFingerprint": "sha256",
  "gates": [
    {
      "gate": "quality-completion-gate",
      "selection": "skip|run",
      "failureDisposition": "none|report-only|block",
      "reasonCodes": ["stable-reason-code"],
      "commandIds": ["stable.command.id"],
      "blocking": false,
      "unrelatedFindings": []
    }
  ],
  "createdAt": "ISO-8601"
}
```

Selection and disposition are separate axes:

- `selection=skip`: the executor is not invoked.
- `selection=run`: the executor may run only the supplied files and command classes.
- `failureDisposition=block`: a relevant failure may block.
- `failureDisposition=report-only`: findings may be surfaced but cannot redirect or authorize edits.

#### Executor Result

Quality and agent-diff executors return:

```json
{
  "gate": "gate id",
  "status": "pass|fail|skipped|error",
  "summary": "bounded neutral text",
  "commandIds": ["stable.command.id"],
  "blockingFindings": [],
  "unrelatedFindings": [],
  "evidence": {},
  "failureFingerprint": "sha256"
}
```

Executors must not return remediation instructions. Only the chain converts a relevant failed result into host `decision: "block"`.

### Policy Logic

#### Task-Relative Change Calculation

The policy core will:

1. capture `git rev-parse HEAD` at task start;
2. capture status plus content/deletion fingerprints for every baseline dirty path;
3. at Stop, compare the current dirty snapshot to the baseline snapshot;
4. include paths changed in commits from `baseline.commit..HEAD`;
5. union and normalize those paths;
6. exclude baseline dirty paths whose current fingerprint is unchanged;
7. include a baseline dirty path if the task changed it further;
8. return policy uncertainty if the baseline commit cannot be related safely to current HEAD.

This replaces the current `git status` equals current-task assumption.

#### Command Classification

Every verification-manifest command must receive:

- stable `id`;
- non-empty `classes`.

Required classes include:

- `quality`;
- `browser`;
- `full-suite`;
- `config`;
- `docs`;
- `security`;
- `targeted`.

The manifest validator must reject commands without IDs/classes and duplicate IDs within a repository entry.

Examples (IDs are assigned to the commands that already exist in `quality-verify-manifest.json`; no new command behavior is introduced):

- `carops.config-contract`: `quality`, `config`, `targeted` — the existing `carops` › `repo` command `pnpm run check:config`.
- `kai-chattr.settings-e2e`: `browser`, `targeted` — the existing `kai-chattr` › `web` command `npx playwright test tests/e2e/settings-page.spec.ts`.
- `kai-chattr.live-ui-snapshot`: `browser` — the existing `kai-chattr` › `web` command `node scripts/dev/ui-snapshot-live.mjs`.
- `kai-chattr.api-all-tests`: `quality`, `full-suite` — the existing `kai-chattr` › `api` command `uv run python -m pytest tests/ -q`.

The `id` is namespaced `<repo>.<command-id>` and is unique within a repo entry; `carops` currently exposes exactly one command, so a CareerOps config-only task selects only `carops.config-contract`. Policy filters commands by explicit directives before execution. A quality domain with all commands filtered returns a structured skipped result; it does not silently substitute another command.

#### Hard Non-Redirect Rule

The chain output must include:

`Stop diagnostics do not authorize new work. Unrelated findings are report-only and must not be edited, rerun, or remediated without a new user directive.`

Enforcement is structural:

- report-only results never produce `decision: "block"`;
- report-only text contains no imperative remediation steps;
- executors never mutate source files;
- PreToolUse continues to enforce active restrictions after Stop diagnostics;
- tests fail if unrelated findings contain redirect language in host-facing output.

#### Non-Overridable Integrity Audit

Before applying browser, quality, or full-suite suppression, the Stop chain runs the existing telemetry-based verification-integrity audit. This audit is lightweight and does not launch product verification. A detected mocked/non-live verification attempt remains a blocking integrity finding even when the associated browser or quality executor is skipped. User directives may suppress work; they may not convert fabricated evidence into a pass.

### State Lifecycle

- Envelope writes are atomic temp-file plus rename operations.
- Decision records are JSONL at `.state/task-policy/decisions/<session-repo-key>.jsonl`.
- Each Stop appends one summary record with all gate decisions and final results.
- Records store hashes, IDs, reason codes, bounded summaries, and sanitized finding metadata.
- Raw prompts, raw command output, environment values, and secret-bearing command expansion are forbidden.
- Retention is bounded by config: maximum records per session/repo file and maximum age.
- Existing task-mode and per-gate state files are compatibility inputs only during cutover, then retired from active writes.
- No migration or backfill is required because `.state/` is disposable runtime state.

### Identity

No change - verified.

State remains isolated by runtime `session_id` plus canonical repository root. No product user identity, authentication, authorization, tenancy, or secret-access boundary changes.

### Runtime Output

Static Codex status:

`Evaluating Stop policy`

Dynamic Stop examples:

- `Stop policy: quality=run, browser=skip, unrelated=report-only`
- `Stop policy: no blocking gates selected for read-only task`
- `Stop policy: unchanged blocker reported without rerun`

The output must state when browser or full-suite verification was skipped. It must never imply skipped verification passed.

### Runtime Wiring

Add `task-policy-guard.mjs` after `planning-start-gate` in PreToolUse wiring for:

- `C:/Users/jwchu/.codex/config.toml`;
- `C:/Users/jwchu/.claude/settings.json`;
- `C:/Users/jwchu/.cursor/hooks.json`;
- repository examples.

Keep a single Stop chain entry.

Extend runtime validation to fail when:

- managed Stop bypasses the chain;
- task-policy guard is missing while task-mode and Stop chain are enabled;
- the Codex static status contains claimed gate names instead of the neutral status;
- example and live managed wiring drift;
- command IDs/classes are invalid.

### Configuration

Add `shared.taskPolicy` to `config.json` and its schema:

- `schemaVersion`;
- `stateDir`;
- `maxObjectiveChars`;
- `maxDecisionRecords`;
- `decisionRetentionDays`;
- continuation phrase patterns;
- directive phrase patterns;
- shell command class patterns;
- default gate dispositions;
- non-overridable integrity policy identifier.

Add hook `task-policy-guard` with event `PreToolUse`, Node runtime, and fail-closed behavior only for its matched mutation/heavy-command tool set. Config validation must require `task-mode-gate`, `planning-start-gate`, and `stop-completion-chain`. Read-only discovery tools remain outside the guard's deny surface.

Remove independent blocking policy from quality and agent-diff settings after the chain owns disposition. Executor-specific timeouts, repo rules, artifact requirements, and single-flight behavior remain.

### Tests

Required named behaviors:

1. `read-only-skips-all-heavy-completion-gates`
2. `bypass-playwright-skips-browser-but-keeps-relevant-quality`
3. `sidebar-layout-task-reports-oauth-api-findings-only`
4. `selected-ui-route-allows-browser-gate`
5. `no-task-relative-delta-skips-heavy-gates`
6. `carops-config-only-selects-config-contract-only`
7. `unchanged-blocker-is-not-rerun`
8. `stale-static-status-label-fails-runtime-validation`
9. `does-not-escalate-unrelated-browser-or-api-errors`
10. `preexisting-dirty-files-are-not-task-changes`
11. `committed-during-task-files-remain-task-changes`
12. `missing-or-stale-envelope-runs-no-heavy-gate`
13. `latest-explicit-directive-wins`
14. `integrity-policy-cannot-be-overridden`
15. `pretool-guard-denies-forbidden-heavy-command`
16. `report-only-output-has-no-remediation-directive`

Fixtures must use temporary repositories and local generated JSON; no live product server, browser, network request, SOPS secret, or product repository mutation is required for these tests.

## Requirement Coverage Matrix

| Requirement | Affected surfaces | Evidence or precedent | Planned task(s) | Acceptance evidence |
|---|---|---|---|---|
| Explicit Active Task Envelope | Contracts, state, task-mode | Existing task-mode session/repo state | 1, 2 | Envelope schema and baseline tests |
| Directive precedence | Policy logic | Explicit mode parsing and config-driven rules | 1, 2 | Latest-directive and integrity tests |
| Gate decision record | Observability | Existing `.state/` gate records | 1, 4 | JSONL schema/retention tests |
| Hard non-redirect rule | Stop output, PreToolUse | Current block reasons auto-steer | 2, 4, 6 | No-remediation and unrelated-finding tests |
| Required behavior tests | Tests | Existing temp-repo test suites | 1-6 | Sixteen named passing scenarios |
| Truthful status text | Runtime wiring | Current misleading Codex `statusMessage` | 5 | Validator rejects stale label |
| First-class report-only | Contracts and chain | Existing report-only response helper | 3, 4 | Separate selection/disposition assertions |
| Scope-drift regression | Browser result handling | Current agent-diff remediation prompts | 3, 6 | Named scope-drift test |
| Separate module, no service | Architecture | Script-first repo and current module layout | 1 | New `task-policy/`, no process/dependency |
| Preserve quality and live verification integrity | Executors and safety | Verification-integrity module | 3, 4 | Integrity cannot be overridden |
| Prevent manual full-suite reruns | PreToolUse guard | Planning gate precedent | 2, 5 | Forbidden-heavy-command test |
| Exclude unrelated dirty work | Git baseline state | Dirty worktrees documented in STACK | 1, 4 | Baseline fingerprint tests |

## Implementation File Inventory

The implementation exceeds eight files because it changes a cross-runtime control plane. This is intentional and must not be collapsed into one large Stop script.

### New files to create - 7

- `task-policy/task-policy-core.mjs` - envelope lifecycle, directives, Git baseline/delta calculation, gate decisions, retry fingerprints, decision records.
- `task-policy/task-policy-guard.mjs` - PreToolUse enforcement of active envelope restrictions.
- `task-policy/test-task-policy-core.mjs` - envelope, directives, task-relative changes, records, and policy tests.
- `task-policy/test-task-policy-guard.mjs` - cross-tool heavy-command and mutation-denial tests.
- `agent-diff-completion-gate/agent-diff-policy.mjs` - pure reusable repo/path/LOC applicability and selected-route helpers.
- `stop-completion-chain/test-stop-policy-integration.mjs` - end-to-end policy/executor regression scenarios.
- `examples/codex/task-policy-hooks.fragment.toml` - Codex prompt, guard, and Stop policy wiring example.

### Existing files to edit - 24

- `task-mode/task-mode-core.mjs`
- `task-mode/task-mode-gate.mjs`
- `task-mode/planning-start-gate.mjs`
- `task-mode/test-task-mode-core.mjs`
- `stop-completion-chain/stop-completion-chain.mjs`
- `stop-completion-chain/test-stop-completion-chain.mjs`
- `quality-completion-gate/quality-completion-gate.mjs`
- `quality-completion-gate/quality-gate-core.mjs`
- `quality-completion-gate/test-quality-gate-core.mjs`
- `quality-completion-gate/quality-verify-manifest.json`
- `agent-diff-completion-gate/agent-diff-completion-gate.mjs`
- `agent-diff-completion-gate/test-agent-diff-completion-gate.mjs`
- `_core/config-model.mjs`
- `_core/validate-runtime-hooks.mjs`
- `quality-completion-gate/test-config-model.mjs`
- `config.json`
- `README.md`
- `STACK.md`
- `examples/codex/stop-hooks.fragment.toml`
- `examples/claude/stop-hooks.fragment.json`
- `examples/cursor/hooks.fragment.json`
- `examples/cursor/hooks.full-stack.fragment.json`
- `hook-dev-tools/test-hook-dev-tools.mjs`
- `changelog-hooks.md`

### External runtime files to edit - 3

- `C:/Users/jwchu/.codex/config.toml`
- `C:/Users/jwchu/.claude/settings.json`
- `C:/Users/jwchu/.cursor/hooks.json`

These are runtime wiring files, not repository source. Do not place secrets in them. Before any edit, each is copied verbatim to an ignored local snapshot under `.state/task-policy/runtime-backup/<timestamp>/` so rollback has a guaranteed restore source.

### Files to move, copy, rename, or delete

- None - 0.

Legacy state files under `.state/task-mode`, `.state/quality-completion-gate`, and `.state/agent-diff-completion-gate` may be ignored after cutover; do not delete them during implementation.

### Generated artifacts - 1

- `config.schema.json` - regenerated only by `node _core/generate-config-schema.mjs`.

### Test files to create or modify - 8

- Create `task-policy/test-task-policy-core.mjs`.
- Create `task-policy/test-task-policy-guard.mjs`.
- Create `stop-completion-chain/test-stop-policy-integration.mjs`.
- Modify `task-mode/test-task-mode-core.mjs`.
- Modify `stop-completion-chain/test-stop-completion-chain.mjs`.
- Modify `quality-completion-gate/test-quality-gate-core.mjs`.
- Modify `agent-diff-completion-gate/test-agent-diff-completion-gate.mjs`.
- Modify `quality-completion-gate/test-config-model.mjs`.

## Locked Decisions and Constraints

1. The implementation is an in-process module, not a daemon or service.
2. The existing task-mode state seam is evolved into the envelope; no parallel canonical task-state store is allowed.
3. `stop-completion-chain` is the only blocking decision authority.
4. Quality and agent-diff modules execute supplied policy; they do not independently authorize scope expansion or remediation.
5. Task changes are computed from a baseline commit plus baseline dirty fingerprints.
6. Explicit directives are deterministic and config-backed; no LLM intent classifier is introduced.
7. Safety/integrity policy outranks user suppression directives.
8. Browser suppression is recorded as not run, not passed.
9. Report-only findings cannot return a blocking host decision.
10. Every manifest command has a stable ID and semantic classes.
11. No command substitution is permitted when policy filters a manifest command.
12. Unchanged failures are not repeatedly executed.
13. Static runtime status is neutral; actual gate selection is emitted after evaluation.
14. Existing unrelated worktree changes must be preserved.

## Locked Acceptance Contract

Implementation passes only when all of the following are true:

- A read-only assessment with unrelated dirty files runs no heavy completion gate.
- An explicit Playwright suppression skips every manifest/browser command classified `browser`, while eligible non-browser quality checks may still run.
- A full-suite suppression prevents both Stop-selected and manually requested full-suite commands.
- A task modifying and committing a file still selects relevant verification even with a clean worktree.
- A pre-existing dirty file unchanged during the task does not select verification.
- CareerOps config-only task changes select only `carops.config-contract`.
- A selected UI route may trigger live browser verification.
- Unrelated OAuth/API findings from a layout task are surfaced report-only and do not contain remediation instructions.
- A relevant selected-route failure may block.
- The same unchanged blocker is not executed again on Stop continuation.
- Missing/stale policy state runs no heavy gate and explicitly says verification was not performed.
- Integrity fraud remains blocking and cannot be suppressed.
- Every Stop writes a valid bounded decision record.
- Codex displays `Evaluating Stop policy` before execution and a truthful computed policy summary afterward.
- Codex, Claude, and Cursor managed wiring validates.

## Pre-Implementation Contract

No worker may improvise:

- a second envelope store;
- a service or database;
- different precedence rules;
- raw prompt persistence;
- automatic remediation;
- unclassified verification commands;
- a default that broadly runs every gate when policy state is missing;
- removal or weakening of live-verification integrity;
- product-repository changes.

Any such need requires plan revision and re-evaluation.

## Frozen Seam Contract

```text
Runtime prompt payload
  -> task-mode classification
  -> Active Task Envelope
  -> PreToolUse task-policy guard
  -> Stop task-policy evaluation
  -> selected quality/browser executors
  -> structured result
  -> chain-owned block/report-only output
  -> bounded decision record
```

Forbidden shortcuts:

- direct runtime wiring to quality or agent-diff;
- executor-created follow-up work;
- full dirty-worktree fallback;
- hidden skip environment variables;
- fabricated pass results;
- raw regex-only file scope when canonical Git-relative paths are available;
- raw command output in decision records.

## Explicit Risks Accepted in This Plan

- Natural-language directive support is intentionally limited to configured deterministic phrases and explicit structured forms.
- Substantive new prompts start a new baseline; users should use continuation language when extending the same task.
- Route-specific blocking is strongest when `selectedRoutes` is explicit or the verifier reports route identifiers.
- Existing product verifier reports may contain unstructured diagnostics; those diagnostics remain report-only unless represented as a failed selected route or executor failure.
- Local state is disposable. A deleted envelope causes conservative no-heavy-gate behavior and an honest unverified status.

## Rollout and Recovery

### Rollout Order

1. Add policy core and tests without changing live wiring.
2. Integrate task-mode and PreToolUse guard behind config.
3. Refactor executors and Stop chain to structured policy flow.
4. Add command IDs/classes and config/schema validation.
5. Run targeted tests.
6. Update examples and user-level runtime wiring.
7. Run runtime validator against live wiring.
8. Update README, STACK, and changelog.

### Compatibility Window

- During implementation, old task-mode state may remain readable but must stop being written once envelope integration lands.
- Runtime wiring changes occur only after scripts and validation pass.
- Stop remains chain-only throughout.

### Rollback

Rollback requires no data migration:

1. restore prior user-level hook wiring from the ignored local backup snapshot taken in Task 5 step 6 (`.state/task-policy/runtime-backup/<timestamp>/`);
2. restore prior repository code/config files;
3. regenerate `config.schema.json` from the restored model;
4. ignore retained `.state/task-policy/` files.

No product data, memory database, or secrets are modified.

## Locked Inventory Counts

- New repository files: 7.
- Existing repository files edited: 24.
- External runtime files edited: 3.
- Generated files: 1.
- Files moved/renamed/deleted: 0.
- Test files created or modified: 8.
- New services: 0.
- New dependencies: 0.
- New credentials or third-party accounts: 0.

Count drift requires plan revision unless an evaluator explicitly classifies it as a non-material correction.

## Task 1: Build the Active Task Envelope and Policy Core

**Outcome:** A tested pure module owns task lifecycle, directives, Git baselines, task-relative deltas, gate decisions, retry fingerprints, and decision records.
**Requirements covered:** Active Task Envelope; precedence; task-relative changes; decision records; unchanged blocker handling.
**Affected surfaces:** Interfaces, application logic, persistence, observability, tests.
**Depends on:** Locked contracts in this plan.

**Modify:**
- `task-mode/task-mode-core.mjs` - retain classification and shared mode constants; retire canonical task-state ownership.
- `task-mode/test-task-mode-core.mjs` - keep mode/repo-root tests and remove assertions for the retired state authority.

**Create:**
- `task-policy/task-policy-core.mjs` - all policy/state functions.
- `task-policy/test-task-policy-core.mjs` - deterministic temporary-repo coverage.

**Steps:**
1. Write failing tests for envelope creation/amendment, latest-directive precedence, secret redaction, atomic persistence, and state-version rejection.
2. Write failing tests for baseline dirty fingerprints, committed-during-task files, unchanged pre-existing dirt, changed pre-existing dirt, deletions, and no delta.
3. Write failing tests for gate selection/disposition, decision-record sanitization/retention, and unchanged failure fingerprints.
4. Implement the versioned contracts exactly as locked.
5. Export narrow functions consumed by task-mode, guard, and Stop chain.
6. Gate selection in the core targets quality/manifest command classes plus a documented `applicability(repoRoot, taskFiles, rule)` interface. The agent-diff implementation of that interface (`agent-diff-completion-gate/agent-diff-policy.mjs`) is created in Task 3 and wired into the core's gate selection at Task 4 integration; Task 1 ships the interface and its quality-side selection, not the agent-diff applicability body.

**Invariants:**
- No raw prompt or raw command output is persisted.
- No product repository is mutated by tests.
- Missing state never broad-runs gates.

**Validation:**
- Command or procedure: `node task-policy/test-task-policy-core.mjs`
- Expected evidence: all envelope, directive, delta, and record assertions pass.

**Rollback or recovery:** Remove the new module and leave existing task-mode state active until later tasks cut over.

**Commit:** `feat: add active task policy core`

## Task 2: Integrate Prompt State and PreToolUse Enforcement

**Outcome:** User prompts create/amend the envelope, planning reads it, and explicitly forbidden mutations/heavy commands are denied before execution.
**Requirements covered:** Read-only behavior; browser/full-suite suppression; scope restriction; prevention of manual full-suite reruns.
**Affected surfaces:** Interfaces, application logic, configuration, runtime.
**Depends on:** Task 1.

**Modify:**
- `task-mode/task-mode-gate.mjs` - call policy core after mode classification.
- `task-mode/planning-start-gate.mjs` - read and update envelope checkpoint fields.
- `config.json` - add shared policy settings and guard hook entry.
- `_core/config-model.mjs` - validate shared policy and guard dependency contract.
- `quality-completion-gate/test-config-model.mjs` - reject invalid/missing policy configuration.

**Create:**
- `task-policy/task-policy-guard.mjs` - common PreToolUse guard.
- `task-policy/test-task-policy-guard.mjs` - tool and command classifications.

**Steps:**
1. Add failing tests for read-only mutation denial, browser-command denial, full-suite denial, targeted-test allowance, scope-prefix denial, missing-envelope heavy-command denial, and integrity-policy precedence.
2. Integrate envelope creation/amendment into the existing UserPromptSubmit hook.
3. Move planning checkpoint persistence to the envelope.
4. Implement tool-input normalization for Codex, Claude, and Cursor-normalized payloads. Command strings are read from `tool_input.command` for shell tools, reusing the existing `loop-safety/loop-guard.py` extraction precedent; the Cursor adapter already passes `tool_input` through and aliases `Shell`→`Bash`, so no new host contract is required.
5. Implement configured command-class detection and neutral deny messages.

**Invariants:**
- Read-only shell discovery commands remain allowed.
- The guard does not treat skipped verification as passed.
- The guard cannot be disabled by prompt text.
- A guard error denies only a matched mutation/heavy command with a neutral policy-unavailable reason; it does not block ordinary read-only tools.

**Validation:**
- Command or procedure: `node task-mode/test-task-mode-core.mjs && node task-policy/test-task-policy-core.mjs && node task-policy/test-task-policy-guard.mjs && node quality-completion-gate/test-config-model.mjs`
- Expected evidence: task-mode and policy tests pass; invalid policy config is rejected.

**Rollback or recovery:** Disable/remove only the new guard hook entry; prompt state can temporarily continue through the envelope without PreToolUse enforcement.

**Commit:** `feat: enforce active task directives before tools`

## Task 3: Convert Completion Gates into Structured Executors

**Outcome:** Quality and live browser modules execute supplied policy context and return neutral structured results without independently redirecting work.
**Requirements covered:** Central policy authority; report-only mode; selected routes; no executor remediation.
**Affected surfaces:** Application logic, interfaces, verification, tests.
**Depends on:** Tasks 1-2.

**Modify:**
- `quality-completion-gate/quality-completion-gate.mjs` - consume policy files/command classes and return executor result.
- `quality-completion-gate/quality-gate-core.mjs` - accept a policy-supplied file list so `changedFiles()` full-worktree selection is bypassed when policy context is present; retire `stopFailureMode()` blocking authority (disposition now owned by the chain). Preserve manifest execution, fingerprinting, and git helpers.
- `quality-completion-gate/test-quality-gate-core.mjs` - replace per-gate blocking-loop expectations with executor-result expectations.
- `agent-diff-completion-gate/agent-diff-completion-gate.mjs` - retain live execution/artifact checks; remove chain policy, skill prompting, and remediation language.
- `agent-diff-completion-gate/test-agent-diff-completion-gate.mjs` - cover selected route failures and unrelated report-only findings.

**Create:**
- `agent-diff-completion-gate/agent-diff-policy.mjs` - pure applicability and route filtering shared with the policy core.

**Steps:**
1. Extract agent-diff applicability without changing its config-defined repo/path/LOC semantics.
2. Require executor input to contain policy decision ID, task files, selected command classes, and route selection.
3. Remove full-worktree fallback from chain-invoked execution.
4. Return neutral blocking and unrelated finding arrays.
5. Preserve live artifact and verification-fraud validation.
6. Remove executor messages instructing the agent to fix, rerun, load skills, or change scope.

**Invariants:**
- Exit codes and live artifacts remain authoritative evidence.
- Fraud remains a blocking finding.
- Executors never write source files.

**Validation:**
- Command or procedure: `node quality-completion-gate/test-quality-gate-core.mjs && node agent-diff-completion-gate/test-agent-diff-completion-gate.mjs && node quality-completion-gate/test-verification-integrity.mjs`
- Expected evidence: structured results pass; live/integrity failures remain represented; unrelated findings are neutral.

**Rollback or recovery:** Restore the prior executor entry points before changing live Stop wiring.

**Commit:** `refactor: make completion gates policy-driven executors`

## Task 4: Make Stop Chain the Sole Policy and Disposition Authority

**Outcome:** Stop evaluates policy once, runs only selected executors, suppresses unchanged reruns, records decisions, and emits host-safe block/report-only output.
**Requirements covered:** Gate decision record; non-redirect rule; dynamic status; repeated blocker; scope drift.
**Affected surfaces:** Interfaces, application logic, observability, tests.
**Depends on:** Tasks 1 and 3.

**Modify:**
- `stop-completion-chain/stop-completion-chain.mjs` - policy evaluation, selected execution, final disposition, record append.
- `stop-completion-chain/test-stop-completion-chain.mjs` - selection/order/output contract tests.

**Create:**
- `stop-completion-chain/test-stop-policy-integration.mjs` - named cross-module acceptance regressions.

**Steps:**
1. Load and validate the envelope before heavy steps.
2. Keep memory harvester as an always-eligible fail-open pre-step.
3. Run the existing verification-integrity telemetry audit as a lightweight non-overridable invariant.
4. Compute task-relative changes and gate decisions once.
5. Invoke only `selection=run` executors with policy context.
6. Apply `block` only to integrity fraud or relevant blocking findings.
7. Emit report-only findings with the hard non-redirect statement.
8. Record every gate decision/result.
9. Detect unchanged failure fingerprints and return the prior blocker without rerunning the executor.
10. Emit a concise computed policy summary.

**Invariants:**
- The chain remains the only managed Stop entry.
- Report-only output never maps to a host follow-up.
- Missing policy state cannot trigger broad verification.

**Validation:**
- Command or procedure: `node stop-completion-chain/test-stop-completion-chain.mjs && node stop-completion-chain/test-stop-policy-integration.mjs`
- Expected evidence: all named policy scenarios pass, including `does-not-escalate-unrelated-browser-or-api-errors`.

**Rollback or recovery:** Restore the prior chain before runtime wiring cutover; executors remain directly testable.

**Commit:** `feat: centralize stop policy and decision records`

## Task 5: Lock Configuration, Manifest Metadata, and Runtime Wiring

**Outcome:** Config/schema enforce the policy architecture, every manifest command is classifiable, and live runtimes use the guard plus neutral status.
**Requirements covered:** Command selection; truthful status; cross-runtime enforcement; CarOps config-only behavior.
**Affected surfaces:** Configuration, integrations, runtime, generated output, tests.
**Depends on:** Tasks 2-4.

**Modify:**
- `quality-completion-gate/quality-verify-manifest.json` - add IDs/classes and task-policy test commands.
- `_core/config-model.mjs` - validate policy settings, command metadata contract where represented in config, and executor ownership.
- `_core/validate-runtime-hooks.mjs` - validate guard and neutral status wiring.
- `quality-completion-gate/test-config-model.mjs` - configuration regressions.
- `config.json` - final policy settings and executor-only gate settings.
- `examples/codex/stop-hooks.fragment.toml` - neutral Stop status.
- `examples/claude/stop-hooks.fragment.json` - canonical Stop chain remains.
- `examples/cursor/hooks.fragment.json` - preserve chain-only Stop.
- `examples/cursor/hooks.full-stack.fragment.json` - add policy guard.
- `hook-dev-tools/test-hook-dev-tools.mjs` - validate new hook payload/output examples.
- `C:/Users/jwchu/.codex/config.toml` - add guard and neutral Stop status.
- `C:/Users/jwchu/.claude/settings.json` - add guard.
- `C:/Users/jwchu/.cursor/hooks.json` - add guard without disturbing unrelated context-mode hooks.

**Create:**
- `examples/codex/task-policy-hooks.fragment.toml` - complete Codex policy wiring example.

**Steps:**
1. Add stable IDs/classes to every existing manifest command (the `carops`/`kai-chattr` IDs follow the Command Classification mapping; assigning IDs must not change any command string) and reject duplicates/missing metadata.
2. Mark browser and full-suite commands accurately.
3. Add hooks-domain commands for new policy tests and Node syntax.
4. Regenerate schema from the model.
5. Extend runtime validation for live/example policy guard and neutral status.
6. Snapshot each external runtime config to an ignored local backup, then update user-level wiring only after repository tests pass.

**Invariants:**
- Preserve all pre-existing unrelated config and manifest edits.
- Do not expose secrets or add plaintext configuration.
- Keep exactly one managed Stop chain per runtime.

**Validation:**
- Command or procedure: `node _core/generate-config-schema.mjs && node quality-completion-gate/test-config-model.mjs && node hook-dev-tools/test-hook-dev-tools.mjs && node _core/validate-runtime-hooks.mjs`
- Expected evidence: generated schema matches model; command metadata and all live wiring validate.

**Rollback or recovery:** Restore user-level configs first, then repository config/model/schema as one unit.

**Commit:** `feat: wire task policy across hook runtimes`

## Task 6: Run the Required Scope and Retry Regression Suite

**Outcome:** Every requested behavior is directly demonstrated without running product stacks or broad repository test suites.
**Requirements covered:** All sixteen named test scenarios.
**Affected surfaces:** Tests and validation.
**Depends on:** Tasks 1-5.

**Modify:**
- Test files listed in the inventory as needed to close coverage gaps.

**Create:**
- None beyond prior tasks.

**Steps:**
1. Run task-policy core and guard tests.
2. Run quality and agent-diff executor tests.
3. Run Stop unit and integration tests.
4. Run config model and runtime wiring tests.
5. Run verification-integrity tests.
6. Confirm the integration suite contains the exact named scope-drift regression.

**Invariants:**
- Do not run CareerOps backend tests.
- Do not run product Playwright.
- Do not start product dev servers.
- Do not substitute mocked product verification as completion evidence.

**Validation:**
- Command or procedure: `node task-policy/test-task-policy-core.mjs && node task-policy/test-task-policy-guard.mjs && node quality-completion-gate/test-quality-gate-core.mjs && node agent-diff-completion-gate/test-agent-diff-completion-gate.mjs && node stop-completion-chain/test-stop-completion-chain.mjs && node stop-completion-chain/test-stop-policy-integration.mjs && node quality-completion-gate/test-verification-integrity.mjs && node quality-completion-gate/test-config-model.mjs && node _core/validate-runtime-hooks.mjs`
- Expected evidence: every command exits zero and prints its passing summary.

**Rollback or recovery:** Not applicable - tests do not modify product state.

**Commit:** Not prescribed - include with the implementation tasks that own each test.

## Task 7: Document and Close the Control-Plane Cutover

**Outcome:** Repository documentation describes the new policy authority, runtime behavior, recovery path, and actual verification evidence.
**Requirements covered:** Operations, governance, rollout, honest status.
**Affected surfaces:** Documentation and governance.
**Depends on:** Tasks 1-6.

**Modify:**
- `README.md` - updated hook flow and task-policy ownership.
- `STACK.md` - state, runtime, test, and recovery details.
- `changelog-hooks.md` - implementation entry with targeted verification evidence.

**Create:**
- None.

**Steps:**
1. Document the Active Task Envelope and Stop policy flow.
2. Document static versus computed status messages.
3. Document decision record location and secret restrictions.
4. Document rollback of user-level wiring and disposable state.
5. Record exact commands run and outcomes in the changelog.
6. Run patch hygiene over only touched files.

**Invariants:**
- Documentation must not claim product Playwright or backend tests ran.
- Documentation must not contain plaintext secrets or raw decision-record content.

**Validation:**
- Command or procedure: `git diff --check -- <all files touched by this implementation>`
- Expected evidence: no whitespace errors; inventory matches the plan or an approved revision.

**Rollback or recovery:** Revert documentation with the implementation if the runtime cutover is rolled back.

**Commit:** `docs: document stop task policy control plane`

## Completion Criteria

- Every requirement maps to implemented files, tests, and acceptance evidence.
- The Active Task Envelope is the sole task-policy state authority.
- Stop chain is the sole gate selection and failure-disposition authority.
- Quality and agent-diff consume policy context and return structured neutral results.
- All manifest commands have stable IDs/classes.
- PreToolUse guard is active in managed Codex, Claude, and Cursor wiring.
- Static status is neutral and dynamic status is truthful.
- All sixteen required regressions pass.
- Runtime validator passes against live wiring.
- Generated schema matches the config model.
- README, STACK, and changelog are updated.
- No unrelated dirty work is reverted, staged, or overwritten.
- No product test suite, product Playwright run, or product server is started for this hooks implementation.
- No unresolved material deviation from this plan remains.

## Plan Revision Triggers

This plan must be revised and re-evaluated if:

- the runtime does not provide a stable session ID or usable PreToolUse command payload;
- Git baseline/fingerprint logic cannot represent committed-during-task changes without another source of truth;
- implementation requires a service, database, dependency, or product-repository change;
- a runtime cannot support the policy guard through current hook wiring;
- command metadata cannot be added without changing command execution semantics;
- a second canonical task-state store would be introduced;
- executor output cannot remain host-compatible through the chain;
- verification-integrity behavior would be weakened;
- the file inventory changes materially;
- scope or acceptance behavior changes.

## Plan Validity Gate

- Requirement fit: Pass - every reviewed suggestion and original architecture decision is represented.
- Repository-reality fit: Pass - paths, owners, commands, and runtime wiring were verified in `E:/hooks`.
- Architecture and surface fit: Pass - the design extends the existing state and chain seams and adds no service.
- Contract completeness: Pass - envelope, decisions, executor results, state, wiring, tests, rollback, and inventory are locked.
- Cross-section consistency: Pass - changed surfaces map to exact files and dependency-ordered tasks.
- Executability: Pass - a zero-context worker can implement and validate without rediscovering architecture.
- Handoff readiness: Pass - no unresolved blocker remains; status is `Ready for evaluation`.

## Evaluation Findings Disposition (v1.1)

Source evaluation: `_briefs/2026-06-21-stop-task-policy-control-plane-plan-evaluation.md` (verdict REVISION_REQUIRED). Each finding was re-verified against plan and repository reality before revision.

- **PLAN-001 (Significant, Confirmed):** `quality-gate-core.mjs` owns `changedFiles()` full-worktree selection (~`:1569`) and `stopFailureMode()` (`:81`) but was absent from the edit inventory. **Resolved:** added to "Existing files to edit" (count 23→24), added to Task 3 Modify list with explicit scope, and Locked Inventory Counts updated to 24.
- **PLAN-002 (downgraded Significant→Minor, Partially accurate):** Three-way verification showed the command *does* exist (`carops` › `repo` → `pnpm run check:config`); the real gap was an unstated ID→command mapping. **Resolved:** Command Classification examples now map each ID to its existing manifest command; Task 5 step 1 states IDs are assigned to existing commands without changing command strings; acceptance criterion remains valid because `carops` exposes exactly one command.
- **PLAN-003 (Minor, Confirmed):** No backup before mutating live external runtime configs. **Resolved:** Task 5 step 6 snapshots each config to `.state/task-policy/runtime-backup/<timestamp>/` before edits; rollback and the external-files note reference the snapshot.
- **PLAN-004 (Minor, Confirmed):** Task 1 claimed complete gate decisions before its Task 3 applicability helper exists. **Resolved:** Task 1 step 6 documents the `applicability()` interface and defers the agent-diff applicability body to Task 3, wired at Task 4.
- **PLAN-005 (Observation):** Scope large for a bug-fix objective. **No action** — user elected full implementation; the prompt-time envelope is required for task-relative change detection, so scope is intrinsic.
- **Residual cross-runtime risk (raised in evaluation chat):** Whether PreToolUse payloads carry the command string. **Resolved by reality:** `loop-safety/loop-guard.py` already extracts `tool_input.command` across runtimes; Task 2 step 4 reuses that precedent. No blocking change.

Cross-reference consistency after revision: inventory list count (24) matches Locked Inventory Counts (24); Task 3 file set matches inventory; acceptance test `carops-config-only-selects-config-contract-only` maps to a real command. No locked decision was altered.
