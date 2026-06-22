# Blind Implementation Review — Stop Task Policy subsystem

**Reviewer:** Claude (Opus 4.8), plan-agnostic posture (author; independence partial)
**Scope:** working-tree diff vs `efea8fe` — `task-policy/`, `stop-completion-chain/stop-completion-chain.mjs`, gate scoping edits, `agent-diff-policy.mjs`, config/validator wiring.
**Date:** 2026-06-21

## What Was Built

A task-intent control plane for the hooks system. On each prompt, a session+repo-keyed "Active Task Envelope" is written capturing a git baseline (commit + per-file content fingerprints), parsed user directives, and scopes/routes. A PreToolUse guard denies tool calls the active task forbids. At Stop, a single orchestrator runs a telemetry integrity audit, computes which files changed *relative to the task baseline*, decides which completion gates may run (and with which command classes), runs only those with the task-scoped file list, decides block vs report-only itself, suppresses re-running unchanged blockers, and writes a bounded decision log. Net effect: Stop stops re-running heavy/unrelated checks and stops feeding "go fix this" prompts that caused implementation drift.

## What Works Well

- **Clean separation of concerns:** pure core (`task-policy-core.mjs`) with no host I/O beyond local state, a thin guard, a pure applicability helper (`agent-diff-policy.mjs`), and the chain as orchestrator. Easy to test (44 core+guard checks + 16 integration).
- **Low blast radius:** executor changes are gated on `input.taskPolicy` presence, so legacy/direct invocation is byte-for-byte unchanged — existing gate suites pass untouched. The chain has a top-level fail-safe.
- **Right safety priority:** the integrity audit runs before any suppression and a `read-only` directive cannot suppress fraud (verified by an integration test that seeds a fraudulent telemetry row under a read-only envelope and still blocks).
- **Honest status semantics:** skipped verification is reported as not-run, missing policy state runs no heavy gate, and report-only carries a hard non-redirect statement instead of a block.

## Findings

### Significant

**S1 — `read-only` does not prevent shell-based mutations.** `task-policy-guard.mjs` `decideGuard` denies `FILE_MUTATING_TOOLS` (Edit/Write/…) and *heavy* shell commands under `read-only`, but a plain `Bash`/`Shell` command is only blocked when it classifies as `browser`/`full-suite`. So under a `read-only` task, `Bash: rm -rf x`, `git commit`, `npm install`, or `echo > file` are all allowed. If "read-only" is treated as a safety guarantee, this is a real hole. Recommend: under `read-only`, deny shell commands unless they match a read-only/discovery allowlist (git status/log/diff, ls, cat, grep…), mirroring loop-safety's command classification.

**S2 — Full file-content reads on every prompt and every Stop.** `fileFingerprint` (`task-policy-core.mjs`) does `readFileSync(abs)` of each file's entire contents, and it's called for every baseline-dirty path in `captureBaseline` (UserPromptSubmit) and every current-dirty path in `taskRelativeChanges` (Stop). On a large or heavily-dirty worktree this is O(total bytes) of synchronous disk reads added to *every* prompt and *every* Stop. Recommend: cap per-file size (hash a prefix + size + mtime), or use `git hash-object`/the index, which already content-hashes blobs.

### Minor

**M1 — Decision-log write is read-all/rewrite-all, not append.** `appendDecision` reads the JSONL, slices, and rewrites the whole file via temp+rename. Two concurrent Stops for the same session+repo can interleave and drop a record (last writer wins). The quality gate has single-flight; the chain's decision write does not. Records are best-effort/bounded, so impact is low, but the function name implies append-safety it doesn't have.

**M2 — Integrity-audit errors are silently swallowed.** In the chain, `detectFraudulentVerificationInTelemetry` is wrapped in `try/catch {}` with the comment "absence of telemetry is not fraud." A genuinely broken telemetry DB (not just absent) would silently disable fraud detection with no signal. Consider distinguishing "no telemetry" from "telemetry query errored" and surfacing the latter.

**M3 — Manifest-declared mock detection is bypassed when policy skips quality.** `isFraudulentVerificationCommand` (static manifest scan) only runs inside the quality gate. If policy sets quality `selection=skip`, a manifest that *declares* a mocked verification command isn't statically caught (the telemetry audit still catches actual mock execution). Edge case; telemetry audit is the primary guard.

### Observations

- **O1** — `redactSecrets` includes a broad `[A-Za-z0-9+/_-]{32,}` rule that will also redact long hashes/paths in the stored objective. Safe-erring (over-redaction) and the objective is non-authoritative, so fine — just noting it's lossy.
- **O2** — `taskRelativeChanges` treats a baseline-dirty file that became clean (reverted during the task) as a task change. Defensible, but means "revert your own pre-existing dirt" registers as task work. Minor semantic choice worth knowing.

## Functional Verification Results

- `node stop-completion-chain/test-stop-policy-integration.mjs` → 16 passed, 0 deferred.
- `node task-policy/test-task-policy-core.mjs` → 29 checks pass; `…test-task-policy-guard.mjs` → 15 pass.
- Full node suite (task-mode, quality core + verification-integrity + config-model, agent-diff, stop-chain unit, hook-dev-tools) → all pass under load; `validate-runtime-hooks` passes.
- Live evidence: `.state/task-policy/{envelopes,decisions}/` populated this session → wiring fires end-to-end.

## Overall Assessment

**Functional but needs hardening.** The architecture is clean, the core is well-tested, and it demonstrably fixes the Stop-loop/drift problem in the live runtime. Two significant findings keep it from "Solid": the `read-only` directive is not airtight against shell mutations (S1), and the per-file full-content fingerprinting will add latency on large/dirty worktrees (S2). Neither is a security hole or data-corruption risk; both are worth addressing before this is leaned on heavily. The minor findings are cleanup-grade.
