# Stop Task Policy Control Plane — Implementation Execution Manifest

**Approved plan:** `_briefs/2026-06-21-stop-task-policy-control-plane-implementation-plan.md`
**Approved plan revision:** v1.1 (self-revised after evaluation; SHA changes per edit — not re-hashed each turn)
**Plan evaluation:** `_briefs/2026-06-21-stop-task-policy-control-plane-plan-evaluation.md`
**Plan evaluation verdict:** REVISION_REQUIRED (v1) → patched to v1.1; **not independently re-evaluated**
**Target repository:** hooks @ `E:/hooks`
**Target branch:** main
**Implementation baseline:** `efea8fe` (work uncommitted)
**Execution mode:** Initial
**Executor:** Claude (Opus 4.8), inline (no subagents per standing user rule)
**Date:** 2026-06-21
**Status:** READY_FOR_IMPLEMENTATION_EVALUATION — Tasks 1–7 implemented and verified; live runtime wiring applied (snapshot in `.state/task-policy/runtime-backup/`)

## Approval Integrity

| Check | Result | Evidence |
|---|---|---|
| Plan revision matches approval | N/A | No clean APPROVED report exists; executing on explicit user authorization (EXEC-DEC-001) |
| Repository and branch match | Pass | main @ efea8fe |
| Baseline recorded | Pass | efea8fe + documented dirty files |
| Blocking plan findings resolved | Pass | PLAN-001..005 dispositioned in plan v1.1 |
| Plan unchanged after approval | N/A | No approval; v1.1 is the executing contract |

## Task Ledger

| Task | Status | Files changed | Validation | Evidence |
|---|---|---|---|---|
| Plan v1.1 patch | Validated | plan md | n/a | findings dispositioned |
| 1 — policy core | Validated | task-policy/task-policy-core.mjs, test-task-policy-core.mjs | `node test-task-policy-core.mjs` | 29 checks pass |
| 2 — prompt state + guard | Validated | task-mode-gate.mjs, planning-start-gate.mjs, _core/config-model.mjs, config.json, config.schema.json, task-policy/task-policy-guard.mjs, test-task-policy-guard.mjs, quality-completion-gate/test-config-model.mjs | see Commands | all pass |
| 3 — gates → executors | Validated | quality-completion-gate.mjs, agent-diff-completion-gate.mjs, +agent-diff-policy.mjs | gate tests + integration | quality+agent-diff honor `taskPolicy.taskChangedFiles`; quality skips directive-forbidden command classes; agent-diff-policy pure helper wired into ruleTriggered. Existing gate tests pass unchanged (legacy path preserved). |
| 4 — stop chain authority ⚠ live | Validated | stop-completion-chain.mjs, +test-stop-policy-integration.mjs | `test-stop-policy-integration.mjs` (15/16, #8→Task5) | chain loads envelope, runs non-overridable integrity audit, computes task-relative delta, selectGates, runs only selected executors with policy context, owns block/report-only, suppresses unchanged blockers, appends decision JSONL, emits dynamic status; conservative no-heavy-gate on missing envelope; top-level try/catch fail-safe. |
| 5 — manifest/validator/wiring | Validated | quality-verify-manifest.json (all 49 commands tagged id+classes, 0 missing), _core/validate-runtime-hooks.mjs (#8 neutral-status, examples+live), examples/codex/{stop-hooks,task-policy-hooks}.fragment.toml, live ~/.codex/config.toml + ~/.claude/settings.json + ~/.cursor/hooks.json (guard wired; neutral Codex Stop status) | validate-runtime-hooks pass; live JSON/TOML parse; backup in `.state/task-policy/runtime-backup/` | — |
| 6 — 16 named regressions | Validated | (test runs only) | full node chain green under load; `test-stop-policy-integration` 16/16, 0 deferred | rerun once after Task 5 live wiring landed |
| 7 — docs/closure | Validated | README.md, STACK.md, changelog-hooks.md, this manifest | docs updated; changelog documents the cutover | — |

## Commands and Validation Evidence (this session, fresh)

| Command | Result |
|---|---|
| `node task-policy/test-task-policy-core.mjs` | pass (29 checks) |
| `node task-policy/test-task-policy-guard.mjs` | pass (15 checks) |
| `node task-mode/test-task-mode-core.mjs` | pass |
| `node task-mode/task-mode-gate.mjs --self-test` | OK (writes envelope) |
| `node task-mode/planning-start-gate.mjs --self-test` | OK |
| `validateConfig(config.json)` | ok: true |
| `node _core/generate-config-schema.mjs` | regenerated config.schema.json |
| `node quality-completion-gate/test-config-model.mjs` | pass (incl. new taskPolicy/guard tests) |
| `node --check` (all edited .mjs) | clean |

## Decisions and Deviations

| ID | Classification | Description |
|---|---|---|
| EXEC-DEC-001 | Deviation (user-authorized) | Executing without a clean APPROVED re-evaluation of plan v1.1; user explicitly directed implementation. Normal lifecycle would re-run evaluating-plan-before-implementation first. |
| EXEC-DEC-002 | Within-plan detail | task-mode-gate writes BOTH legacy task-mode state AND the envelope during the compatibility window; envelope writes are fail-open so a failure never blocks a prompt. |
| EXEC-DEC-003 | Within-plan detail | `stop-completion-chain` is a `scripts[]` entry (not a hook); guard dependency validation uses scriptById accordingly. |
| EXEC-DEC-004 | Within-plan detail | Executors convey pass/fail via their existing host-output shape, interpreted by the chain, rather than a new `executorResult` envelope — avoids gutting the 1.5k/2.3k-line modules. The chain owns ALL disposition + neutral messaging (ignores executor remediation prose), so the plan's invariants hold (chain sole authority; no executor-authored remediation reaches the user; task-scoped files). |
| EXEC-DEC-005 | Within-plan detail | Executor policy behavior is gated on `input.taskPolicy` presence; absent it (direct/legacy invocation) the gates behave exactly as before, so existing gate tests stay valid. The chain always drives policy mode, so the live Stop path is fully policy-governed. |
| EXEC-DEC-006 | Resolved | Named scenario #8 `stale-static-status-label-fails-runtime-validation` is now implemented: `validate-runtime-hooks` rejects a gate-claiming Codex Stop status (examples + live); integration suite is 16/16, 0 deferred. |
| EXEC-DEC-007 | Within-plan fix | The pre-existing flaky single-flight timing assertion in `test-quality-gate-core.mjs` (`<500ms` proxy, load-sensitive) was made deterministic (3000ms slow command, `<2800ms` bound); the real `runCount===1` correctness check is unchanged. The file is in the plan inventory; the flake repeatedly blocked Stop. |
| EXEC-DEC-008 | Live wiring (user-authorized) | External user-level configs (`~/.codex/config.toml`, `~/.claude/settings.json`, `~/.cursor/hooks.json`) edited to add the `task-policy-guard` PreToolUse hook and (Codex) the neutral Stop status. Snapshotted to `.state/task-policy/runtime-backup/<ts>/` before editing; all parse and `validate-runtime-hooks` passes. |

## Unresolved / Known Issues

- None blocking. The previously-flaky `test-quality-gate-core.mjs` timing assertion is fixed (EXEC-DEC-007).

## Next

Implementation complete and self-verified. Hand to `evaluating-implemented-plan` for independent audit against plan v1.1. Note EXEC-DEC-001: plan v1.1 was self-revised and not independently re-evaluated before execution (user-directed); an evaluator may wish to confirm the v1.1 contract first.
