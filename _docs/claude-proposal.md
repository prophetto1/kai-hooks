# Full Hook-System Proposal — claude (lead)

**Status:** proposal / unlocked. Independent draft per Jon's id=456/id=464. Nothing here is built or locked until Jon approves.
**Date:** 2026-06-01
**Companions:** `codex-proposal.md`, `gemini-proposal.md` (same directory).

---

## 1. Thesis

A hook is only worth its overhead if it **prevents a failure we have actually hit.** So this proposal is built backwards from our *documented* difficulties (mined from the vector memory), not from generic best practice. Every hook below names the real failure it stops.

Four principles:

1. **Exit codes are the only authority.** No heuristics, no parsing of what the agent "said it did." (We already proved the old regex evidence-sniffer was gameable.)
2. **One config SSOT, policy decoupled.** `config.json` stays the registry; *policy* (what to check, what to deny) lives in declarative data, not hardcoded JS — so rules change without touching trusted runner code.
3. **Stable runners, tunable config.** Codex trusts a hook by its definition/hash; we freeze a small set of runner scripts and push tunables into config — but config/manifest then become a **governed policy surface** that must be schema-validated and write-protected (this is codex's correct divergence from gemini's draft, and I agree).
4. **One job per event; hooks build on each other.** SessionStart primes → UserPromptSubmit routes → PreToolUse guards → PostToolUse records → Stop verifies. Each consumes the prior's state.

---

## 2. The documented difficulties this system must fix (the WHY)

Mined from the vector memory (mistake-notes + project memories). This is the spine of the proposal — every hook traces to one of these.

| # | Documented failure (source) | Hook that addresses it |
|---|---|---|
| D1 | Agents authored governance content and routed it agent-to-agent / marked it "paste-ready" **before Jon saw it** (mistake `12b5414`) | PreToolUse governance-gate |
| D2 | Contracts created/marked `locked:true` **without Jon's sign-off** → Jon deleted the whole dir (mistake `4fa964c`) | PreToolUse governance-gate |
| D3 | Claimed a dep "already installed" / a fix "done" **without verifying** (mistakes `ce4fb00`, `d16ae5f`) — verification theater | Stop quality-gate |
| D4 | "**Gates green**" only validated contract-schema, **not** that the filesystem matches the contract (blind-review gap) | Stop quality-gate (+ conformance check) |
| D5 | Changed an enforcement mechanism, left **stale cross-references** in sibling files (mistake `5e69390`) | Stop quality-gate |
| D6 | **Zero skills loaded** across long coordination runs; recall/protocol discipline degrades (mistake `54175e4`) | UserPromptSubmit injector (keep) |
| D7 | Assumed MCP/memory tools were **unavailable** without checking; acted on **stale context** (mistake `861f0d6`; my own stale-chat-read slip this session) | SessionStart primer |
| D8 | The gate's own **config/manifest is mutable and unprotected** — an agent could neuter it (codex id=434/463) | PreToolUse governance-gate + schema validation |

If a proposed hook doesn't map to a row here, it's scope creep.

---

## 3. The hooks — what each DOES and WHY

### 3.1 SessionStart — the primer  *(NEW)*
**Does:** Once per session (startup/resume/clear/compact), injects a small, stable fact-block: active repo + branch + dirty-file count, hook health (which hooks are wired + last self-test), skill-index count, memory-store reachability, and the current governance posture (e.g. "kai-chattr contracts empty; check-contracts no-ops").
**Why:** D7. Agents start cold and act on stale or assumed state (assumed tools missing; acted on a stale chat cursor). A primer makes the true starting state un-missable and offloads static bulk from the per-turn injector.
**Borrow:** eyelet `doctor.py` issues/warnings accumulator for the health section.

### 3.2 UserPromptSubmit — inject-protocol  *(KEEP, evolve)*
**Does:** Per prompt, injects the A–E protocol + ranked memory recall + a curated skill suggestion. Stays advisory — never blocks.
**Why:** D6. This is the only thing that keeps per-turn discipline (recall the store, pick a skill, follow protocol) from silently decaying. Jon explicitly wants it maintained.
**Evolve (not rebuild):** move its hardcoded skill-routing regex (`boostedSkills`) out of the JS into the declarative policy layer (§4) — gemini's tech-debt finding, OPA-style decoupling. Behavior unchanged; policy becomes data.

### 3.3 PreToolUse — governance + safety gate  *(NEW; highest leverage)*
**Does:** Before a write/edit/bash/MCP-write tool runs:
- **Governance guard:** deny writes under `governance/**` and `E:/hooks/**` (incl. the manifest + config) unless Jon typed an approval for that path in the recent prompt window. Agents draft/propose only. Fail-**closed**.
- **Safety guard:** decompose compound bash commands and deny destructive ones (`rm -rf`, `sudo`, path-traversal, writes to `.env`/secrets).
**Why:** D1, D2, D8 — our single biggest documented failure class is agents manufacturing false authority (authoring/locking governance content Jon never approved) and the gate's own policy surface being editable. This hook makes "only Jon locks" a *tooling* guarantee, not a convention.
**Borrow (near-direct port):** claude-hooks `smart_approve.py` — its `decompose_command` (splits on `&& || ; |` respecting quotes/subshells — the security crux), deny-first/all-must-allow logic, merged global+project+local settings, and the exact output contract `{hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason}}`. Plus validate-write/validate-bash heuristics from `E:/__skills/hook-development`.
**Codex constraint:** output shape must be exact; Codex intercepts Bash/apply_patch/Edit/MCP only — fail-closed on *intercepted* paths, documented as not a total boundary.

### 3.4 PostToolUse — telemetry  *(thin, optional)*
**Does:** Records a lightweight evidence/audit trail (tool, target, exit status) to a per-session state file. **Never enforces** (runs after side effects).
**Why:** Feeds the Stop gate's audit context and the loop-breaker's failure history. Kept minimal — not the basis of any verdict (that was the old sniffer's fatal flaw).

### 3.5 Stop — deterministic quality-gate  *(EXISTS v1 → V2)*
**Does:** On stop, compute `git status` (ground truth) → map changed files to declared domains in the verify-manifest → **run** each domain's *cheapest authoritative* check → gate strictly on **exit codes**.
**Why:** D3, D4, D5 — verification theater, "gates green ≠ conformance," stale cross-refs. The gate forces real verification before "done."
**V2 hardening (from the three red-line reviews):**
- **Loop-safety:** read `stop_hook_active` + persist a per-session **failure-signature counter**; after N consecutive identical-failure blocks, **yield** with a loud message. *Borrow:* agentihooks `retry_breaker` (dual-threshold, op+normalized-error fingerprint, reset-on-success) + clyro's atomic per-session JSON state persistence.
- **Fast checks, not builds:** each domain command = typecheck/lint/contract-validate/dep-check, **not** full `pnpm build`/full suites.
- **Bounded-parallel under a budget:** *Borrow:* lefthook's parallel/timeout model, but **add the concurrency cap + total time budget it lacks**, with `totalBudgetMs` set **below** the Codex 180s hook ceiling and per-command deadlines derived from it; SIGKILL the process tree on timeout.
- **10MB buffer** (stop ENOBUFS masking the real failure) + **capture git stderr** (clean JSON out).
- **Conformance check (D4):** for repos with a declared layout, verify declared dirs/files actually exist — closes the "schema-valid ≠ filesystem-matches" gap.

---

## 4. Config & policy model — the `config.json` decision

**Recommendation: keep `config.json` as the SSOT, extend it, decouple policy — do NOT adopt a new framework or an OPA sidecar.**

1. **Extend `config.json` (pre-commit-shaped).** Add a declarative per-domain command layer borrowing pre-commit's proven schema: `command`/`entry`, `glob`/`files` + `exclude` (regex), `stages` (mapped to CC/Codex events), `timeout`, `tags`, `fail_fast`, and the **retcode-or-modified** success contract. This generalizes the verify-manifest and is well-bounded.
2. **Decouple policy (OPA *pattern*, not engine).** The governance gate becomes a thin **PEP** (enforcement point) that builds an `input` (`{tool, path, approval, actor}`) and asks a small Node **decision module** fed by a `policy` block in the SSOT (protected paths, approval rules, exceptions). Rules become data, editable without touching trusted runner code. **No OPA/Go sidecar** — disproportionate for a single-host `.mjs` system.
3. **Protect the surface (D8).** Because config/manifest now *are* policy, they get: a **JSON schema** + a **command-existence preflight** (in `validate-runtime-hooks.mjs`), and they sit behind the PreToolUse governance-gate (edits need Jon's approval).
4. **Extract `lib/hook-runtime.mjs` now.** With SessionStart + gov-gate + Stop all sharing stdin-parse / config-by-id / output-adapter / fail-policy / state-paths, the shared runner is justified (it wasn't with one hook). Stable hash → less Codex re-trust churn.

---

## 5. Build order

- **P0 — Substrate:** `lib/hook-runtime.mjs`; `test-hook.mjs` (mock per-event JSON → stdin → assert stdout shape + exit code + timeout; borrow claude-hooks' subprocess test pattern); `validate-runtime-hooks.mjs` (borrow eyelet `validate.py` schema + `doctor.py` accumulator; add command-existence + Codex `config.toml` checks); `quality-verify-manifest.schema.json`.
- **P1 — Stop gate V2:** loop-safety, bounded-parallel+budget, buffer, stderr, fast-checks manifest, conformance check.
- **P2 — PreToolUse governance+safety gate** (port `smart_approve.py`) — **required before the Stop gate is flipped to prod**, since it protects the policy surface.
- **P3 — SessionStart primer.**
- **P4 — inject-protocol policy decouple** (move regex → policy data).

Substrate first: every hook is tested against `test-hook.mjs` before it's wired.

---

## 6. Interoperation

```
SessionStart  →  writes session-primer state (repo, health, posture)
      │
UserPromptSubmit (inject-protocol) → reads primer + memory + skills, injects protocol
      │
PreToolUse (gov+safety) → reads policy block; denies unapproved governance/E:/hooks writes + destructive bash
      │
PostToolUse (telemetry) → appends evidence/exit-status to per-session state
      │
Stop (quality-gate) → reads git diff + manifest + per-session failure history → runs verifiers → exit-code verdict (loop-safe)
```

All five read/write the one SSOT (`config.json` + policy block) through `lib/hook-runtime.mjs`. State lives in per-session JSON files (clyro pattern).

---

## 7. Open decisions for Jon

1. **Config model:** approve "extend `config.json` + decoupled policy block" (vs a new framework)?
2. **Gate scope:** whole dirty tree (recommended — deterministic) vs task-scoped?
3. **PostToolUse:** build the thin telemetry hook now, or defer until the Stop gate needs its history?
4. **License posture:** Verified permissive (attribution, no wholesale vendor): claude-hooks, eyelet, pre-commit, lefthook, agentihooks = MIT; clyro, opa = Apache-2.0. **`codex-cli-hooks` has NO LICENSE file in its clone (codex verified, id=468) → wire-format/reference-only; do NOT lift code from it until license is clarified.**
