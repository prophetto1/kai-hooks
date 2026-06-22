# Stop Task Policy Control Plane Pre-Implementation Plan Evaluation

**Plan reviewed:** `E:/hooks/_briefs/2026-06-21-stop-task-policy-control-plane-implementation-plan.md`
**Plan revision:** SHA-256 `16464374df1d670cee9a59bc163f9f44b840807de6cb0f88f0bcc0d399757d4d` (untracked; baseline HEAD `efea8fe`)
**Target repository:** `hooks` at `E:/hooks`
**Target branch:** `main`
**Evaluation type:** Initial
**Evaluator:** Claude (Opus 4.8)
**Date:** 2026-06-21
**Verdict:** REVISION_REQUIRED
**Next skill:** addressing-evaluation-findings

## Executive Assessment

This is a strong, repository-grounded plan. Every load-bearing claim about current behavior was independently verified true: `task-mode-gate` persists only mode/snippet/watermark/checkpoint with no git baseline; `quality-gate-core.changedFiles()` inspects the full dirty worktree; quality and agent-diff each own independent `failureMode: "block"` and retry/remediation authority; the manifest commands have no `id`/`classes`; the Codex example status text falsely advertises "quality, Playwright, review"; and the chain is correctly enforced as the sole Stop entry by `validate-runtime-hooks.mjs`. The diagnosed bugs are real and systemic, and capturing a baseline at `UserPromptSubmit` is genuinely required to compute task-relative change at Stop, so the cross-event scope is defensible rather than over-reach.

It is not yet approvable. The file inventory omits `quality-gate-core.mjs`, which actually owns the full-worktree selection and `failureMode` logic the plan must change (PLAN-001), and the acceptance contract plus classification examples reference manifest command IDs (`carops.config-contract`) that do not exist in the current manifest and are not provisioned by any task (PLAN-002). Both force an implementer to improvise around locked contracts. Fix these two, address the minor findings, and re-evaluate.

## Contract Audit

| Contract area | Result | Evidence or finding IDs |
|---|---|---|
| Header, objective, and scope | Pass | Header complete; objective, scope, non-goals, constraints, assumptions all present |
| Investigation evidence | Pass | Full-read statement present; sampled files verified against reality |
| Repository Evidence Matrix | Pass | Authorities correctly labeled observed/not-applicable; matches repo |
| Current and target state | Pass | Current behavior independently verified accurate |
| Change Surface Manifest | Fail | PLAN-001 (quality-gate-core.mjs omitted) |
| Requirement coverage | Pass | All 12 requirements map to tasks and acceptance evidence |
| File inventory | Fail | PLAN-001 (missing file; locked count understated) |
| Locked decisions and acceptance | Fail | PLAN-002 (carops.config-contract acceptance not provisioned) |
| Higher-rigor sections | Pass | Rollout, rollback, frozen seam, risks, revision triggers all present |
| Implementation tasks | Pass (with PLAN-004) | Outcomes observable, dependency-ordered; minor sequencing note |
| Plan Validity Gate | Pass | Self-assessment present and largely accurate |

## Repository Reality Verification

Independently inspected: `task-mode/{task-mode-gate,task-mode-core,planning-start-gate}.mjs`, `stop-completion-chain/stop-completion-chain.mjs`, `quality-completion-gate/{quality-completion-gate,quality-gate-core,verification-integrity,quality-verify-manifest.json}`, `agent-diff-completion-gate/agent-diff-completion-gate.mjs`, `_core/{config-model,validate-runtime-hooks}.mjs`, `config.json`, `examples/codex/stop-hooks.fragment.toml`, `.gitignore`, and the manifest repo structure.

Matched the plan: HEAD `efea8fe` and the six documented dirty paths match the working tree exactly; `task-policy/` does not exist; `.state/` is gitignored; chain order is `memory-harvester → quality-completion-gate → agent-diff-completion-gate` with memory-harvester fail-open; no `shared.taskPolicy` and no `task-policy-guard` exist yet; both gates carry `failureMode: "block"`.

Diverged from the plan: (1) the manifest repo `carops` exposes only a `repo` domain — there is no `config`/`config-contract` command, contradicting acceptance criterion "CareerOps config-only task changes select only `carops.config-contract`" (PLAN-002). (2) Full-worktree selection (`changedFiles`, `quality-gate-core.mjs:~1569`) and `stopFailureMode` (`quality-gate-core.mjs:81`) live in `quality-gate-core.mjs`, which is read in the evidence matrix but absent from the edit inventory and Task 3 (PLAN-001).

## Findings

### PLAN-001 — Edit inventory omits `quality-gate-core.mjs`, which owns the logic the plan must change

**Severity:** Significant
**Category:** Inventory
**Blocking:** Yes
**Plan location:** Implementation File Inventory (lines 564-586); Task 3 (lines 827-831); Drift to Remove (line 228); Locked Inventory Counts (line 736)
**Repository evidence:** `quality-completion-gate/quality-gate-core.mjs` — `changedFiles()` performs `git status --porcelain` full-worktree selection (~line 1569); `stopFailureMode()` reads `settings.failureMode` (line 81). The plan reads this file in the evidence matrix (line 98) but lists only `quality-completion-gate.mjs` for edit; `quality-gate-core.mjs` appears in no task.
**Problem:** Task 3 requires "Remove full-worktree fallback from chain-invoked execution" and Drift-to-Remove targets "the quality gate's configured `failureMode`," but the module that implements both is not in the inventory. The locked count (23 existing edits) therefore understates the change set, and an implementer must either edit an unlisted file (count drift) or improvise a call-site-only workaround the plan never authorizes.
**Impact:** The central Stop fix (stop selecting the full dirty worktree) cannot be completed within the declared inventory; locked-count integrity is violated.
**Required correction:** Either add `quality-completion-gate/quality-gate-core.mjs` to the edit inventory and Task 3 (updating the count to 24), or state explicitly that the refactor is confined to the `quality-completion-gate.mjs` call site and justify how `changedFiles`/`stopFailureMode` in core remain correct unedited.

### PLAN-002 — Acceptance contract references a manifest command that does not exist and is not provisioned

**Severity:** Significant
**Category:** Repository reality
**Blocking:** Yes
**Plan location:** Command Classification examples (line 414); Tests list item 6 `carops-config-only-selects-config-contract-only` (line 517); Locked Acceptance Contract (line 643)
**Repository evidence:** `quality-verify-manifest.json` repo `carops` has a single domain `repo` — no `config`/`config-contract` command exists. Task 5 adds IDs/classes to *existing* commands and adds hooks-domain test commands, but never creates a `carops` config-contract command.
**Problem:** A locked acceptance criterion and a named required test depend on a command ID that neither exists today nor is added by any task. As written, the test cannot pass against the real manifest.
**Impact:** Acceptance is unprovable; an implementer must invent a manifest command or silently restate the criterion — both are improvisation around a locked contract.
**Required correction:** Reconcile the classification examples and acceptance test with real manifest commands (use an existing `carops` command ID, or another repo's genuine config command), or add the `carops` config-contract command explicitly in Task 5 and the manifest edit.

### PLAN-003 — No snapshot/backup step before mutating live external runtime configs

**Severity:** Minor
**Category:** Operations
**Blocking:** No
**Plan location:** Task 5 external edits (lines 914-916); Rollback (lines 722-728)
**Repository evidence:** Targets `C:/Users/jwchu/.codex/config.toml`, `.claude/settings.json`, `.cursor/hooks.json` — user-level files shared across all projects. Rollback says "restore prior user-level hook wiring" but no step captures the prior copy.
**Problem:** Rollback assumes a prior copy exists; none is captured before the edit.
**Impact:** A faulty wiring edit could degrade hooks across every project with no clean restore source.
**Required correction:** Add a pre-edit step that snapshots each external runtime config (the restorable source rollback depends on).

### PLAN-004 — Task 1 claims complete gate decisions before its applicability dependency is created

**Severity:** Minor
**Category:** Consistency
**Blocking:** No
**Plan location:** Task 1 outcome (line 748); Task 3 creates `agent-diff-policy.mjs` "shared with the policy core" (lines 558, 834)
**Repository evidence:** Plan-internal: `agent-diff-policy.mjs` (Task 3) is described as a pure applicability helper shared with `task-policy-core` (Task 1), yet Task 1 is ordered first and claims it owns "gate decisions."
**Problem:** If core's gate selection consumes agent-diff applicability, Task 1 cannot finalize gate decisions before Task 3 exists.
**Impact:** Mild executability/ordering ambiguity; resolved at Task 4 integration but not stated.
**Required correction:** Clarify that core's agent-diff gate selection is finalized at Task 4, or move the shared applicability helper's creation into Task 1's dependency set.

### PLAN-005 — Scope is large for the stated bug-fix objective (alternative, not a defect)

**Severity:** Observation
**Category:** Architecture
**Blocking:** No
**Plan location:** Objective (lines 13-24); Inventory (7 new + 23 edited + 3 external)
**Repository evidence:** Bugs verified systemic; baseline-at-prompt-time genuinely required for task-relative delta, so cross-event scope is justified.
**Problem:** None — noted for the author's consideration: the chain-disposition/executor refactor (the direct Stop bug) is separable from the PreToolUse guard + external-runtime cutover and could land first to reduce blast radius.
**Impact:** Single large cutover across three live runtimes raises rollback blast radius for what is framed as a bugfix.
**Required correction:** None required. Consider phasing if the author wants to de-risk delivery.

## What the Plan Does Well

- **Accurate diagnosis.** Every current-state claim verified true against code, including the misleading Codex status text and the dual independent `failureMode: "block"` authorities.
- **Sound grounding for scope.** The report-only/non-redirect fix maps onto the chain's existing `haltChain + continue + systemMessage` path, and the baseline-at-prompt-time design correctly recognizes Stop cannot compute task-relative change without an earlier baseline.
- **Strong contract discipline.** Versioned envelope/decision/executor schemas, separated selection-vs-disposition axes, non-overridable integrity audit, locked decisions, frozen seam, revision triggers, and a no-improvisation pre-implementation contract.
- **Integrity preserved.** Verification-integrity remains non-overridable; skipped browser verification is recorded as not-run, never passed — consistent with repo safety policy.

## Approval Scope and Next Action

No revision is approved. Two blocking findings (PLAN-001, PLAN-002) must be dispositioned, and PLAN-003/PLAN-004 should be addressed, in `addressing-evaluation-findings`. The revised plan must return for re-evaluation before `executing-approved-plans`. Implementation must not begin on this revision.
