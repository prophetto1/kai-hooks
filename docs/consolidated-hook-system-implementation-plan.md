# Consolidated Hook System Implementation Plan

Status: Draft for review
Author: Codex
Date: 2026-06-01
Source inputs: `E:/hooks/docs/codex-proposal.md`, `E:/hooks/docs/codex-hook-system-proposal.md`, `E:/hooks/claude-proposal.md`, current `E:/hooks` files

## Problem Statement

The current hook system has the right pillars, but not yet a stable implementation spine. `UserPromptSubmit` works as the prompt/memory/skill injector, and `Stop` now uses a deterministic manifest-based quality gate, but configuration validation, hook test fixtures, governance protection, and operator diagnostics are still incomplete.

If we implement the proposals independently, we will create duplicate runtime shapes, duplicate validators, and unclear event ownership. The implementation must consolidate them into one path: shared runtime first, current hooks migrated second, governance and telemetry after the harness proves the event contracts.

## Goals

1. Preserve the live `UserPromptSubmit` injector behavior while moving it onto a shared runtime.
2. Preserve the deterministic `Stop` gate authority: changed surfaces plus manifest commands plus exit codes only.
3. Add a schema-validated configuration and manifest layer before adding more gates.
4. Add a test/doctor harness that proves hook stdin, stdout, exit code, timeout, and loop behavior locally.
5. Protect `E:/hooks/**`, governance files, schemas, and manifests before treating the hook system as locked.

## Non-Goals

1. Do not adopt OPA/Rego in v1. Borrow the policy-as-data boundary, not the engine.
2. Do not replace the current injector from scratch. Migrate it incrementally.
3. Do not make `PostToolUse` telemetry authoritative for completion quality.
4. Do not wire multiple ordered hooks for the same event. Use one command entry per event when ordering matters.
5. Do not vendor OSS reference repos into runtime code. `E:/hooks/references` remains borrow-only source material.

## Current Reality

- `E:/hooks/config.json` exists, is valid JSON, and references missing `E:/hooks/config.schema.json`.
- `E:/hooks/config.proposed.json` does not exist in the current tree.
- `inject-protocol/inject-protocol.mjs` reads `E:/hooks/config.json`, including `shared.projects[]` and `settings.sources.*`, and falls back to defaults.
- `quality-completion-gate/quality-completion-gate.mjs` is wired as the Codex `Stop` hook.
- `quality-gate-core.mjs` already has a local `hookRuntime()` helper; this should be lifted into shared `lib/hook-runtime.mjs`.
- `governance-gate` exists as a directory, but the hook is disabled and the script is not implemented.
- `E:/hooks` is not a git repo, so hook-system self-checks need a non-git `always` mode or `E:/hooks` must become a repo later.

## User Stories

- As Jon, I want every hook to say what it does and why it exists so that hook architecture stays tied to real failures, not abstract automation.
- As an agent, I want a single shared runtime so that every hook parses input, reads config, logs, and emits output consistently.
- As an agent, I want `UserPromptSubmit` to push protocol, memory, and skills so that I cannot silently skip the operating contract.
- As Jon, I want protected writes blocked before execution so that agents cannot weaken `E:/hooks`, governance contracts, schemas, manifests, or secrets workflows without approval.
- As an agent, I want `Stop` to run real declared checks so that completion depends on evidence, not command text or self-reporting.
- As an operator, I want a doctor/console command so that hook wiring, missing schemas, invalid manifests, and recent failures are visible without manual archaeology.

## Architecture Decision

Use the current `E:/hooks/config.json` as the control-plane root and add the missing schema/validator around it.

Chosen file names:

```text
E:/hooks/
  config.json
  config.schema.json
  lib/
    hook-runtime.mjs
    event-normalizer.mjs
    hook-logger.mjs
    hook-state.mjs
    job-runner.mjs
    shell-command-parser.mjs
    path-policy.mjs
  scripts/
    validate-runtime-hooks.mjs
    test-hook.mjs
    doctor.mjs
  inject-protocol/
    inject-protocol.mjs
    per-prompt-protocol.md
  quality-completion-gate/
    quality-completion-gate.mjs
    quality-gate-core.mjs
    quality-verify-manifest.json
    quality-verify-manifest.schema.json
  governance-gate/
    governance-gate.mjs
    governance-policy.json
    governance-policy.schema.json
  telemetry/
    post-tool-audit.mjs
  .state/
    sessions/
    logs/
    fixtures/
```

The decisive consolidation choices:

- Use `config.schema.json`, not both `config.schema.json` and `schemas/hook-config.schema.json`.
- Use `scripts/validate-runtime-hooks.mjs`, not both `validate-config.mjs` and `validate-runtime-hooks.mjs`.
- Use `scripts/doctor.mjs` for operator health checks; defer a broader `hooks-console.mjs` until the basic doctor is useful.
- Keep one event entrypoint per event. Internally dispatch ordered modules through the shared runtime.

## Hook Responsibilities

| Event | Module | P0/P1 Role | Authority |
|---|---|---|---|
| `SessionStart` | deferred `session-start/session-start.mjs` | Later primer: repo, hook health, dirty count, missing schemas. | Advisory |
| `UserPromptSubmit` | `inject-protocol/inject-protocol.mjs` | Keep and migrate: protocol, memory recall, skill suggestions. | Advisory, fail-open |
| `PreToolUse` | `governance-gate/governance-gate.mjs` | Build after substrate: protected paths, shell safety, approval checks. | Blocking gate |
| `PermissionRequest` | deferred | Later approval context only. | Advisory/approval bridge |
| `PostToolUse` | `telemetry/post-tool-audit.mjs` | Later telemetry: exit status, output size, fingerprints. | Non-authoritative telemetry |
| `Stop` | `quality-completion-gate/quality-completion-gate.mjs` | Keep and harden: manifest jobs, exit-code verdicts, loop safety. | Blocking quality gate |
| `PreCompact` | deferred | Later compact-state capture. | Advisory |
| `PostCompact` | deferred | Later compact-state restoration. | Advisory |

## Requirements

### Phase 1 Requirement Lock

Phase 1 is not only "migrate existing hooks." Phase 1 is the first enforcement cutover: make the live hook system prevent the failures that are currently recurring while leaving the Letta-grade backend as the durable target, not the blocker.

Locked Phase 1 requirements:

1. **Memory gate first, tune in parallel.**
   Auto-provided recall is not accurate enough yet. Until recall quality is proven, substantive implementation turns must show an explicit MCP-router `memory_search` result before code/write work proceeds. The hook system must record that evidence in local hook state. In parallel, tune the injector with stricter project/topic scoping and a higher relevance floor.

2. **High-threshold skill recommendations become mandatory.**
   Skill suggestions must fire rarely and only on strong matches. When the injector recommends one or two skills, the agent must load and visibly use them. Proof is both an explicit response marker such as `Using /skill-name for ...` and an evidence signal that the skill file/workflow was actually opened or satisfied. Vague "I used it" text is not sufficient.

3. **Memory/identity backend is in scope, but not a Phase 1 blocker.**
   The durable target is a Letta-derived memory/identity service with per-agent provisioning. Phase 1 enforcement uses what exists now: MCP-router memory tools plus local hook state. The Letta extraction must not block the hookfile/gate cutover.

4. **Protected writes require explicit user grant.**
   A `PreToolUse` gate must block writes to protected surfaces unless the current prompt or short approval window contains a user-typed grant naming the protected path/surface and action. Generic approval such as "go ahead" is not enough for governance, contracts, schemas, manifests, secrets, or `E:/hooks/**`.

5. **Implementation completion requires proof, including visual proof when user-facing.**
   Completion gating must map changed files to proof bundles. Frontend/user-facing changes require Playwright, screenshot capture, and image/vision review against an explicit expected source. Backend/API/database changes require compile/test/API/migration checks and still require Playwright proof for affected user-facing flows. Repeated visual mismatch must force a debugging/hunt loop with a hard loop bound.

Phase 1 build order:

1. Add the hookfile/runtime substrate and local evidence store (`hooks.db` or equivalent state tables).
2. Add memory-search evidence gate and injector tuning.
3. Add high-threshold skill recommendation plus mandatory-use evidence.
4. Add protected-write `PreToolUse` gate.
5. Add completion proof bundles, then Playwright/visual jobs for implementation-complete attempts.

Explicit decisions:

- Memory path: **gate-first now, tune in parallel**.
- Skill proof: **response marker plus observed evidence**, not text alone.
- Letta: **in scope as durable backend target**, not required before Phase 1 gates.
- Protected write grant: **path/surface plus action required**.
- Visual gate timing: **implementation-complete attempts**, not every `Stop`.
- Visual expected source: user request, design/spec contract, baseline screenshot, or generated acceptance text.
- Loop safety: every repeat-until-correct path must have a failure-signature loop breaker.

### P0: Substrate and Safety Net

P0 creates testable infrastructure without changing live behavior.

Requirements:

- Add `config.schema.json` matching the current `config.json` shape.
- Add `quality-completion-gate/quality-verify-manifest.schema.json`.
- Add `scripts/validate-runtime-hooks.mjs`.
- Add `scripts/test-hook.mjs` with fixture-driven tests for current `UserPromptSubmit` and `Stop`.
- Add `scripts/doctor.mjs` that reports live Codex wiring, config validity, missing scripts, missing schemas, and manifest command availability.
- Add shared `lib/hook-runtime.mjs` with config loading, hook lookup by `id`, JSON stdin parsing, output helpers, fail-policy handling, and state path helpers.

Acceptance criteria:

- `node E:/hooks/scripts/validate-runtime-hooks.mjs` exits 0 on current valid config/manifests.
- `node E:/hooks/scripts/test-hook.mjs --suite smoke` proves current `UserPromptSubmit` and `Stop` output valid hook JSON.
- `node E:/hooks/scripts/doctor.mjs` reports the two currently wired Codex hooks and flags `governance-gate` as disabled/planned.
- Existing live hook files continue to run with `--self-test`.
- No hook behavior changes are made before P0 tests exist.

### P1: Runtime Migration and Evidence Substrate

P1 removes duplicated runtime logic from existing hooks and adds the evidence substrate required by the Phase 1 gates.

Requirements:

- Refactor `quality-gate-core.mjs` runtime helpers into `lib/hook-runtime.mjs`.
- Update `quality-completion-gate.mjs` to use the shared runtime.
- Update `inject-protocol.mjs` to use the shared runtime while preserving current behavior.
- Fix `inject-protocol` project detection to read `shared.projects[]`; keep legacy fallback only during the migration.
- Make config parse failures visible in self-test and doctor output.
- Add local hook evidence storage under `.state/` or `hooks.db` for per-turn facts: memory search observed, recommended skills, skill-use evidence, protected-write approvals, and completion proof attempts.
- Add fixture coverage for evidence writes and reads before any gate depends on that evidence.

Acceptance criteria:

- `node E:/hooks/inject-protocol/inject-protocol.mjs --self-test` reports config loaded, protocol exists, memory DB exists or explicit unavailable state, and suggested skills.
- `node E:/hooks/quality-completion-gate/quality-completion-gate.mjs --self-test` emits valid JSON and does not print git fatal errors.
- `test-hook.mjs --suite smoke` still passes.
- Evidence storage can record and retrieve a memory-search fact and a skill-recommendation fact for the same turn/session.
- Diff review confirms no behavior regression in prompt injection or Stop gate decisions.

### P2: Memory and Skill Gates

P2 turns the injector from advisory text into enforceable turn discipline for substantive work.

Requirements:

- Add memory-search evidence detection using MCP-router memory calls when available and local hook state as the enforcement record.
- Gate substantive write/implementation work until memory-search evidence exists for the current turn or short session window.
- Raise the skill recommendation threshold so recommendations fire only on strong matches.
- Record recommended skill ids in hook state.
- Gate substantive write/implementation work when a recommended skill has not been loaded and visibly used.
- Treat proof of use as two signals: a visible response marker and observed evidence that the skill file/workflow was opened or satisfied.
- Keep auto-injection active while tuning recall quality in parallel.

Acceptance criteria:

- A substantive write fixture with no memory-search evidence is denied.
- A fixture with memory-search evidence is allowed to proceed to the next gate.
- A high-confidence skill recommendation creates a mandatory-use record.
- A fixture that only says "I used the skill" without evidence is denied.
- A fixture with a response marker plus observed skill evidence is allowed.

### P3: Governance Gate

P3 prevents the highest-risk writes before they happen.

Requirements:

- Add `governance-gate/governance-gate.mjs`.
- Add `governance-gate/governance-policy.json`.
- Add `shell-command-parser.mjs` for compound Bash decomposition.
- Add `path-policy.mjs` for protected path matching.
- Protect:
  - `E:/hooks/**`
  - `E:/hooks/config.json`
  - schemas and manifests
  - clean repo `governance/**`
  - contract-generation outputs
  - secret-bearing writes
  - repo-local virtualenv creation
  - destructive shell commands
- Require explicit user approval naming the protected path/surface and action for protected writes.

Acceptance criteria:

- A write to `E:/hooks/config.json` is denied without explicit approval.
- A write to `governance/contracts/*.json` is denied unless the user grant names the contract surface and write action.
- Generic "go ahead" does not authorize protected writes.
- A compound Bash command containing a denied subcommand is denied.
- Normal reads/searches are not blocked.
- Policy decision logs include rule id, path or command, decision, and reason.
- The gate is proven by `test-hook.mjs` before it is enabled in live config.

### P4: Completion Proof Gate V2

P4 hardens the deterministic completion gate and adds proof bundles for implementation-complete attempts.

Requirements:

- Replace synchronous multi-command execution with `job-runner.mjs` using bounded parallelism.
- Add total Stop budget below the Codex hook timeout.
- Increase output capture or write large output to files to avoid `ENOBUFS` masking failures.
- Add failure-signature loop state under `.state/sessions` or `.state/quality-gate`.
- Add non-git `always` self-check coverage for `E:/hooks`.
- Validate manifest commands before enablement.
- Keep verdict authority to exit codes only.
- Add domain proof bundles:
  - frontend/user-facing: Playwright run, screenshot capture, and visual review
  - backend/API: compile/test/API smoke plus affected UI flow proof when user-facing
  - database: migration apply/validate plus affected API/UI proof
  - hooks: syntax check, hook fixture test, config/manifest validation
  - docs/contracts: generator/schema/conformance checks
- Require an expected source for visual checks: user request, design/spec contract, baseline screenshot, or generated acceptance text.
- Run visual completion only for implementation-complete attempts, not every `Stop`.
- On repeated mismatch, require debugging/hunt workflow and stop after the configured loop threshold with evidence.

Acceptance criteria:

- `Stop` with `stop_hook_active: true` never re-blocks.
- Repeated identical failures hit a configured loop threshold and yield with a clear system message.
- Dirty `E:/hooks` changes trigger self-check jobs even though `E:/hooks` is not a git repo.
- Manifest command dry-run reports missing commands before runtime gating.
- Independent jobs can run in bounded parallel without exceeding total hook budget.
- A frontend implementation fixture blocks without Playwright screenshot evidence.
- A backend/API fixture requires compile/API proof and, when user-facing, associated Playwright proof.
- A repeated visual mismatch yields after the loop threshold instead of blocking forever.

### P5: Telemetry and Doctor Expansion

P5 adds observability without granting telemetry authority.

Requirements:

- Add `telemetry/post-tool-audit.mjs`.
- Log tool event, command fingerprint, touched path, exit status if available, duration, output size, and error fingerprint.
- Add retry-breaker state for repeated operation failures.
- Expand `doctor.mjs` to show last session failures and recent blocked rules.

Acceptance criteria:

- `PostToolUse` never blocks completion.
- Telemetry can explain repeated failures in doctor output.
- Stop gate does not treat telemetry as verifier proof.

### P6: Session/Compaction Hygiene

P6 is deferred until P0-P5 are stable.

Requirements:

- Add `SessionStart` primer only if P0 doctor checks are reliable.
- Add `PreCompact`/`PostCompact` state preservation only if long-session context loss remains a real issue.

Acceptance criteria:

- Primer output is small and does not duplicate the full per-prompt protocol.
- Compact-state restore does not inject stale gate decisions.

## Implementation Order

1. Add schemas and `scripts/validate-runtime-hooks.mjs`.
2. Add `scripts/test-hook.mjs` with smoke fixtures for current hooks.
3. Add `scripts/doctor.mjs`.
4. Extract `lib/hook-runtime.mjs` and migrate `quality-completion-gate` first.
5. Migrate `inject-protocol` to shared runtime.
6. Add local hook evidence storage (`hooks.db` or `.state` tables) and fixture tests.
7. Add memory-search evidence gate for substantive work.
8. Tighten skill recommendation scoring and add mandatory-use evidence gate.
9. Build and test `governance-gate` for protected writes.
10. Enable governance gate only after tests prove denial shape in current Codex.
11. Upgrade Stop gate runner and loop signature state.
12. Add non-git `E:/hooks` self-check coverage.
13. Add completion proof bundles.
14. Add Playwright screenshot + visual review jobs for implementation-complete attempts.
15. Add `PostToolUse` telemetry if Stop/gov diagnostics need it.
16. Defer `SessionStart`, `PermissionRequest`, `PreCompact`, and `PostCompact` until core gates are stable.

## Verification Commands

Minimum commands before claiming each phase complete:

```powershell
node E:/hooks/scripts/validate-runtime-hooks.mjs
node E:/hooks/scripts/test-hook.mjs --suite smoke
node E:/hooks/scripts/doctor.mjs
node E:/hooks/inject-protocol/inject-protocol.mjs --self-test
node E:/hooks/quality-completion-gate/quality-completion-gate.mjs --self-test
python -m py_compile E:/hooks/scripts/index-skills.py E:/hooks/scripts/normalize-memory-tags.py
```

Additional P3 checks:

```powershell
node E:/hooks/scripts/test-hook.mjs --suite governance
```

Additional P2 checks:

```powershell
node E:/hooks/scripts/test-hook.mjs --suite stop-gate
```

## Success Metrics

Leading indicators:

- Hook doctor reports no missing script/schema/manifest paths.
- Smoke fixtures pass after every hook edit.
- Stop gate produces clean JSON and no stderr pollution.
- Governance gate blocks protected writes in fixtures before live enablement.

Lagging indicators:

- Fewer turns where agents skip memory/skill routing.
- Fewer false completion claims after code/docs/governance edits.
- Fewer stale config or manifest references after hook changes.
- Faster diagnosis when a hook fails in Codex terminal.

## Open Questions

1. Should `E:/hooks` become a git repo, or should non-git self-check mode remain the long-term answer?
2. Should `blockOnUnmatched` flip to true after initial allowlists are written?
3. Should `governance-gate` protect only `E:/hooks/**` and clean repo `governance/**` first, or also memory writes in v1?
4. Should `doctor.mjs` stay a simple CLI, or become the first command of a broader `hooks-console.mjs` later?
5. What exact Codex `PreToolUse` denial shape is current and verified on this machine?

## Risks

- PreToolUse support may not intercept every write path in current Codex. Mitigation: prove with fixtures before enabling and keep Stop self-checks as fallback.
- Schema design can become too broad. Mitigation: validate current config first, then expand only as hooks need fields.
- Governance gate can block legitimate work. Mitigation: start with narrow protected paths and explicit approval flow.
- Stop gate can become too slow. Mitigation: fast checks first, total budget, bounded parallelism, and deferred full builds.
- Telemetry can regress into evidence-sniffing. Mitigation: document and enforce that telemetry is non-authoritative.

## Completion Criteria

The hook system can be considered v1 locked only when:

- `config.json`, quality manifest, and governance policy validate against schemas.
- Current `UserPromptSubmit` and `Stop` hooks use shared runtime.
- `test-hook.mjs` covers success and failure cases for active hooks.
- `doctor.mjs` can identify hook wiring drift and missing files.
- Stop gate is loop-safe, clean-output, and exit-code-only.
- `E:/hooks` self-edits are covered by non-git checks or by making `E:/hooks` a repo.
- Governance gate protects policy surfaces before they can be weakened by agents.
- Jon has explicitly approved enabling any new blocking hook in live Codex config.
