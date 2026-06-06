# Hook Control Plane Refactor Proposals — Evaluation (Round 2)

Reviews: `hook-control-plane-refactor-proposals.md` (revised, ~2090 lines)
Date: 2026-06-04
Reviewer: Claude (independent gate)
Modes used: blind-implementation-review lens + code-review lens + objective-drift check
Status: advisory gate for human evaluators — not an approval

## Context: prior blockers are fixed

This is a re-evaluation after the author revised the plan in response to Round-1 findings. All six Round-1 blockers were addressed **correctly** (verified against the live repo):

1. `validateManifestCommands` now iterates `Object.entries(repo.domains)` and checks the real `label`/`command`/`maxBuffer` fields (`:1326`) — was iterating `domains` as an array (would crash the Stop gate).
2. The integrity command is now placed in the real `repos[name=hooks].domains.runtime.commands` (`:1364`) — was targeting a non-existent `hooks-runtime` domain.
3. `runVerifyCommand` now **preserves** `maxBuffer` (`:1389`) and the doc explicitly forbids dropping it — was omitting it (false `ENOBUFS` failures on large-output commands).
4. thinking-gate is back to `failPolicy:"open"` with `unknownToolPolicy:"require_execute"` + a classification-completeness guard (`:853,890,997`) — was `failPolicy:"closed"` + `deny` (brick risk).
5. A real **Stop-hook drain trigger** exists (`:682-718`) — the drain worker was previously orphaned.
6. Every proposal now has a **Risks And Accepted Tradeoffs** section.

The findings below are **new** issues surfaced by the two fresh lenses — not the Round-1 list.

## Verification performed (ground-truth)

`config.json` (hook schema: `script`/`settings`, thinking-gate `failPolicy:open` at `:247`, `inject-protocol` `sources.protocol`+`settings.output.capChars`), `_core/config-model.mjs:728-737`, `thinking-gate/thinking-gate.py`, `quality-completion-gate/quality-verify-manifest.json` (full — `domains` is an object keyed by name; `maxBuffer:4194304` on several commands), `inject-protocol/inject-core.mjs` exports, `skills-catalog.md:52`. Note: a couple of code-review items below depend on functions/exports not shown in the proposal and are flagged "verify."

---

## Lens 1 — Blind Implementation Review

Judging the design on its own engineering merit.

**What it builds (reconstructed):** a coherence-and-safety pass over a single-user hook control plane — a capability registry (lifecycle states), a write-behind telemetry path (queue + Stop-triggered drain), a policy/lease thinking-gate with a read/write/execute risk taxonomy, a cross-surface integrity gate, a shared injector runner, and a repo↔live-config parity validator. The through-line is sound: make every surface declare itself and stop silent drift.

**What's genuinely good:** registry + live-wiring parity are textbook single-source-of-truth and drift detection; telemetry write-behind with a fail-open, diagnostic-only drain is the right shape; TDD-first ordering and per-proposal rollback are disciplined; the thinking-gate taxonomy (observe vs modify vs execute vs high-risk) is the correct fix for the original "reads cost the same as writes" pain.

### Findings

**Critical — the lease model does not enforce the budgets it advertises.**
In `policy.py:decide()` (`:971`), once a lease exists and has not expired, `observe`/`modify`/`execute` always return `allow=True, consume=True`. `consume()` (`:1133`) only *logs* a consumption row; nothing ever compares per-bucket counts against `maxObserve/maxModify/maxExecute` from `defaultLease`. So the configured "risk budget" is decorative — functionally the gate becomes "any classified tool is allowed for 500s after one think," with **no cap at all**. That is *less* enforcement than today's bounded counter (which stops at 15), while shipping two SQLite tables that imply stricter control. Decision required: enforce the budgets (count rows per bucket, deny when exceeded) or remove them from config/schema so they do not imply protection that does not exist.

**Significant — lease TTL ignores its own config.** `create_lease()` (`:1109`) computes expiry from `policy.get("leaseSeconds")`, but config defines `settings.ttlSeconds` (no `leaseSeconds`). It silently falls back to `500`; the configured TTL is never honored.

**Significant — lease store ignores configured table names.** `leases.py` hardcodes `thinking_gate_leases`/`thinking_gate_consumptions` (`:1067,1080`) and a private DB at `thinking-gate/.state/leases.sqlite3`, yet config declares `leaseTable`/`consumptionTable` and `config-model` now validates them as required SQL identifiers (`:1202-1203`). The knobs are validated but unused; leases also live in a different DB than `settings.table:"hook_events"` implies.

**Significant — a killed bounded drain orphans events.** The Stop trigger runs the drain under `spawnSync(timeout:1500)` (`:706`). `drain_file()` renames `x.jsonl → x.jsonl.draining` then processes (`:633`). If the budget/timeout kills it mid-file, the `.draining` file is left behind and `main()` globs `*.jsonl` only (`:670`) — so those events are orphaned forever. No startup recovery of `.draining` files.

**Minor — drain worker does not parse the bounds the trigger passes.** The trigger passes `--max-ms 1000 --max-events 500` (`:686`) but the shown `drain-events.py` has no arg parsing (`:666`). Acknowledged as a to-do (exec step 5), but as-shown the drain is unbounded under the 1500ms Stop budget — which is what creates the orphan above.

**Overall assessment: Functional but needs hardening.** Architecture sound, safety posture now good, but the centerpiece (Proposal 3) ships the machinery of a budgeted capability-lease without the budget enforcement, plus two config-vs-code mismatches.

---

## Lens 2 — Code Review

| # | File / loc | Dimension | Finding | Severity |
|---|---|---|---|---|
| 1 | `policy.py:decide` `:971` | Correctness | Budgets never enforced (see Critical above) | Critical |
| 2 | `leases.py:create_lease` `:1109` | Correctness | Reads `leaseSeconds`; config has `ttlSeconds` → TTL hardcoded to 500 | Significant |
| 3 | `leases.py` `:1067,1080` | Maintainability | Hardcodes table names; ignores validated `leaseTable`/`consumptionTable` | Significant |
| 4 | `validate-live-hooks.mjs:hookMatches` `:1872` | Correctness | Checks `actual.timeout_sec`, but Codex TOML hooks use `timeout` → every `required` hook reports "not found" (false drift failure). Verify the real TOML key. | Significant |
| 5 | `drain-events.py` `:666` + trigger `:686` | Correctness | Bounds args passed but not parsed → unbounded drain under 1500ms kill → orphaned `.draining` file (no recovery glob) | Significant |
| 6 | `store.py` `:500` / `drain-events.py` `:623` | Correctness | Imports `connect, detect_project, extract_target, hooks_db, safe_table, load_config` from `hook_runtime` — assumed exports; verify they exist (last round an import assumption was a real break) | Significant |
| 7 | `queue-event.py:append_event` `:469` | Concurrency | 128 KB max event + line-buffered append; concurrent PostToolUse processes can interleave partial lines above the OS atomic-append size; the drain sends those to `bad-events` | Minor |
| 8 | `store.py:ddl_for/insert_event` `:507,588` | Security | Table name f-string-interpolated into SQL — mitigated by `safe_table()` + `config-model` identifier check; safe iff `safe_table` is strict (verify) | Minor |
| 9 | `live-config-model.mjs` `:1814` | Robustness | Line-based TOML parser ignores arrays/inline tables/multiline; fine for today's flat blocks, brittle if TOML grows (Risks section acknowledges this) | Minor |

**Security/perf summary:** no injection or secret-handling problems (table names sanitized; no creds in code). Fail-open postures (telemetry, drain, thinking-gate) are correctly chosen for an always-on control plane. The real risks are correctness (budget + the two config-key mismatches), not security.

---

## Drift Check — vs the stated objective

Objective: "optimize the hook system following leading industry patterns and best practices."

**Mostly on-target.** Five of six proposals are clean applications of real best practices: single-source-of-truth registry (P1), declared-vs-actual parity / drift detection (P6), cross-surface integrity validation (P4), write-behind logging (P2), DRY consolidation (P5). The iterative revisions *added* grounding and per-proposal risk/rollback — quality, not scope creep. No meaningful scope drift; the six are cohesive.

**One real drift, in the centerpiece (Proposal 3).** The plan invokes "PEP/PDP + capability leases + admission control" as industry justification and builds two SQLite tables, UUID leases, and `scope_json`/`budget_json` — for a single-user local gate whose stated job (per Jon's locked requirement) is to not disrupt how he already works. Two ways it has drifted:

1. **Complexity without the corresponding value.** As found above, the lease DB exists but the budgets are not enforced — so the heavy machinery delivers a TTL-scoped allow-all, i.e. more statefulness than the current counter for less enforcement. That is the signature of a pattern adopted for its name rather than its payoff.
2. **It under-leverages the actual leading direction.** The modern move for this exact problem is policy-as-code as a pure decision function + steer-don't-block + native boundary events (PreToolUse `allow` + `additionalContext`, PostToolBatch, TaskCreated/Completed) — lighter, stateless, and aligned with the policy-first / guardrails-as-infrastructure direction. The plan name-checks the pattern but reaches for a bespoke stateful lease store instead.

**Not drifted in P3:** the read/write/execute taxonomy is the correct, on-objective fix and should stay.

**Recommendation on drift:** keep P3's taxonomy; reconsider the lease *mechanism*. Either (a) actually enforce per-class budgets and prove it does not reintroduce over-blocking, or (b) drop the two lease tables and make the gate a stateless policy function that steers rather than hard-counts — leaning on native PreToolUse-steer / boundary primitives. Do not pay for two SQLite tables on a personal gate unless budget enforcement is real and wanted. Also note one original pain point — sequential-thinking false-positives (rich payloads tripping the model) — is out of scope here; that is a separate fix, worth stating so it is not assumed covered.

---

## Bottom line

The plan is now structurally sound and the six prior blockers are genuinely fixed. What remains is a semantic gap in Proposal 3 (advertised-but-unenforced budgets + two config-key mismatches) and a right-sizing question for P3's mechanism. Proposals 1, 2, 4, 5, 6 read as ready-to-implement modulo the small code-review items (#4–#6 verify-then-fix).

**Recommendation:** gate approval on resolving the Proposal 3 budget decision (enforce or remove) and fixing code-review items #2–#6; Proposals 1 and 6 can proceed first.
