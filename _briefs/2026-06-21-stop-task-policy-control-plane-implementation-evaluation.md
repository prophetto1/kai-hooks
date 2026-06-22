# Stop Task Policy Control Plane Implementation Evaluation

**Approved plan:** `_briefs/2026-06-21-stop-task-policy-control-plane-implementation-plan.md`
**Approved plan revision:** v1.1 (uncommitted)
**Plan evaluation:** `_briefs/2026-06-21-stop-task-policy-control-plane-plan-evaluation.md`
**Plan evaluation verdict:** REVISION_REQUIRED (v1) — **no APPROVED verdict exists** (v1.1 not re-evaluated)
**Findings-resolution lineage:** plan v1.1 "Evaluation Findings Disposition" (self-authored)
**Execution manifest:** `_briefs/2026-06-21-stop-task-policy-control-plane-execution-manifest.md`
**Target repository:** hooks @ `E:/hooks`
**Target branch:** main
**Implementation baseline:** `efea8fe` (work uncommitted)
**Implementation revision reviewed:** working tree diff vs `efea8fe`
**Evaluation type:** Initial
**Evaluator:** Claude (Opus 4.8) — same author as the implementation (independence is therefore partial; a fresh reviewer is preferable)
**Date:** 2026-06-21
**Verdict:** REWORK_REQUIRED (minor; runtime substance verified, gaps are examples + plan/lineage reconciliation)
**Required next skill:** executing-approved-plans (rework: IMPL-003) + addressing-evaluation-findings / re-evaluation (IMPL-001, IMPL-002)

## Executive Assessment

The runtime substance of the implementation is complete, correct, and independently re-verified: the Active Task Envelope is built each prompt, the Stop chain is the sole policy authority (integrity audit → task-relative delta → gate selection → scoped executors → block/report-only → unchanged-blocker suppression → decision JSONL → neutral status), the PreToolUse guard enforces directives, and the live wiring fires (envelopes + decisions written this session). The full node regression chain and all 16 named scenarios pass.

It is **not** a clean PASS for three honest reasons: (1) there is no APPROVED plan revision — v1.1 was self-revised after a REVISION_REQUIRED verdict and never independently re-evaluated (lineage-gate failure, user-accepted); (2) the implementation deviates from the v1.1 locked inventory (several planned edits — `quality-gate-core.mjs`, `task-mode-core.mjs`, multiple test files — were not made because a gated/call-site design made them unnecessary); (3) the repo Cursor/Claude example fragments were not updated with the guard, leaving committed examples inconsistent with the shipped design and the live wiring. (1) and (2) are plan-target/lineage; (3) is a small, fixable implementation gap.

## Lineage Audit

| Artifact or baseline | Expected identity | Observed identity | Result |
|---|---|---|---|
| Approved plan | APPROVED revision | v1.1, verdict was REVISION_REQUIRED; never re-evaluated | **Fail** (no approval) |
| Plan evaluation | APPROVED / APPROVED_WITH_NONBLOCKING | REVISION_REQUIRED (v1) | Fail |
| Execution manifest | READY_FOR_IMPLEMENTATION_EVALUATION | present, status set | Pass |
| Implementation baseline | efea8fe | efea8fe (uncommitted) | Pass |
| Implementation revision | working-tree diff | recoverable; pre-existing dirt separable | Pass |

## Plan Compliance Matrix

| Contract area | Result | Evidence or finding IDs |
|---|---|---|
| Objective and scope | Pass | Stop now task-relative; drift loop removed (live evidence) |
| Requirement coverage | Pass | 12 requirements realized; 16/16 named scenarios |
| Change Surface Manifest | Pass (with IMPL-002) | all changed surfaces implemented; some via alternate files |
| Interfaces and contracts | Pass | envelope/decision/executor-policy contracts present |
| Application/domain logic | Pass | chain is sole authority; selectGates/disposition correct |
| Persistence/data lifecycle | Pass | `.state/task-policy/` envelopes + bounded decision JSONL |
| Identity/access control | Pass | session+repo scoped; no new privilege boundary |
| Runtime/integrations/operations | Pass | live `.codex`/`.claude`/`.cursor` guard wired; validator green |
| User interface/client | N/A | no UI surface |
| Tests and validation | Pass | full node chain green under load |
| File inventory and counts | **Fail** | IMPL-002 (locked 24 edits vs ~15 actual; quality-gate-core/task-mode-core untouched) |
| Locked decisions and frozen seams | Pass | chain-sole-authority, no service, integrity non-overridable upheld |
| Acceptance contract | Pass | all 15 acceptance bullets demonstrable via tests/live evidence |
| Rollout and recovery | Pass | snapshot-then-edit; backup in `.state/task-policy/runtime-backup/` |
| Completion criteria | Pass (with IMPL-003) | examples gap is the one unmet criterion |

## Repository Reality and Diff Verification

Actual diff vs `efea8fe`: **7 new files** (matches locked count) — `task-policy/{core,guard,tests}`, `agent-diff-policy.mjs`, `test-stop-policy-integration.mjs`, `examples/codex/task-policy-hooks.fragment.toml`. **~15 existing files edited** (vs locked 24). Pre-existing unrelated dirt (`harvest_core.py`, `vector_store_bridge.py`, `auth-slot-lease/`) correctly left untouched. Live external configs edited (outside repo) with backup snapshot.

## Validation Reproduction

| Command | Result | Proves |
|---|---|---|
| `node stop-completion-chain/test-stop-policy-integration.mjs` | 16/16, 0 deferred | named acceptance scenarios |
| `node task-policy/test-task-policy-core.mjs` | 29 checks pass | envelope/directive/delta/decision core |
| `node task-policy/test-task-policy-guard.mjs` | 15 checks pass | guard denials |
| full node chain (10 suites) | all pass under load | no regressions |
| `node _core/validate-runtime-hooks.mjs` | pass | live + example wiring, neutral status |
| live `.state/task-policy/{envelopes,decisions}/` | populated this session | wiring fires end-to-end |

## Findings

### IMPL-001 — No approved plan revision (lineage gate failure)
**Severity:** Significant **Category:** Lineage **Blocking:** No (user-accepted) **Correction target:** Plan
**Evidence:** plan-evaluation verdict is REVISION_REQUIRED; v1.1 patched by the same author; no re-evaluation report exists.
**Problem:** Execution proceeded without an APPROVED revision; the v1.1 contract was never independently gated.
**Impact:** Plan-compliance cannot rest on an approved baseline; the contract being audited is self-certified.
**Required correction:** Run `evaluating-plan-before-implementation` on v1.1 (or have a fresh reviewer accept it). User has explicitly accepted this deviation; recorded, not blocking by user election.

### IMPL-002 — Implementation deviates from v1.1 locked inventory
**Severity:** Significant **Category:** Inventory **Blocking:** No **Correction target:** Plan
**Affected paths:** `quality-completion-gate/quality-gate-core.mjs`, `task-mode/task-mode-core.mjs`, `task-mode/test-task-mode-core.mjs`, `agent-diff-completion-gate/test-agent-diff-completion-gate.mjs`, `stop-completion-chain/test-stop-completion-chain.mjs`, `hook-dev-tools/test-hook-dev-tools.mjs`
**Evidence:** `git diff --name-only HEAD` shows none of these were modified, yet v1.1 locked them as edits (24 total; actual ~15).
**Problem:** The gated/call-site design (EXEC-DEC-004/005) made these edits unnecessary — `quality-gate-core` is bypassed when policy supplies files; legacy task-mode state is retained during cutover; existing gate tests pass unchanged. Functionally sound, but the locked inventory/count is now wrong.
**Impact:** The plan's locked inventory misrepresents the real change set; PLAN-001's resolution (add quality-gate-core to inventory) diverges from what shipped (call-site confinement — PLAN-001's other valid option).
**Required correction:** Reconcile the v1.1 inventory to the call-site/gated approach and corrected counts (or, if literal core edits are wanted, edit `quality-gate-core.mjs` to retire `stopFailureMode` authority). No functional change required.

### IMPL-003 — Repo Cursor/Claude example fragments missing the guard
**Severity:** Significant **Category:** Plan compliance **Blocking:** Yes **Correction target:** Implementation
**Affected paths:** `examples/cursor/hooks.fragment.json`, `examples/cursor/hooks.full-stack.fragment.json`, `examples/claude/stop-hooks.fragment.json`
**Evidence:** `grep task-policy-guard` → MISSING in all three; plan Task 5 lists them as edits to add the guard.
**Problem:** Live `.codex`/`.claude`/`.cursor` configs and the new Codex fragment include the guard, but the committed Cursor/Claude example fragments do not. Anyone re-wiring from these examples gets task-mode + Stop chain without the policy guard.
**Impact:** Committed wiring templates are inconsistent with the shipped design; a planned deliverable is incomplete.
**Required correction:** Add the `task-policy-guard` PreToolUse entry to the three example fragments (mirroring the live wiring). Trivial, mechanical.

## What the Implementation Does Well

- Genuinely fixes the root problem: task-relative change detection + unchanged-blocker suppression + report-only disposition end the Stop-loop/drift (corroborated by live decision records and the user's observation).
- Low-risk design: executor changes gated on `taskPolicy` presence, so legacy/direct invocation and all existing gate tests are untouched; chain has a fail-safe.
- Integrity non-overridability is preserved and tested (a read-only directive cannot suppress fraud).
- Honest evidence discipline: snapshot-before-live-edit, deterministic fix for the pre-existing flaky timer, and accurate execution manifest.

## Required Next Action

Verdict **REWORK_REQUIRED**, minor. Route IMPL-003 to `executing-approved-plans` rework (add guard to the 3 example fragments) — the only genuinely-fixable blocking gap. IMPL-001 (lineage) and IMPL-002 (inventory reconciliation) are plan-target and user-accepted; close them via a v1.1 re-evaluation or explicit user waiver. The runtime implementation itself is verified-good and may proceed to `blind-implementation-review` in parallel.
