# depcruiser-migrations — Design, Current State & Independent Verification Spec

> **Status:** DRAFT for independent verification. The "Proposed design" (§5) is **not built yet**.
> An independent agent should verify every claim in **§7** against the actual files on disk *before* any implementation begins (§8).
>
> **Authoring conditions (important for the verifier):** this document was produced by an assistant operating over a **read/write Filesystem connector to `E:/`** with **no shell on the host**. That means file *contents* were read directly, but **no `node`/`python`/`depcruise`/`tsc`/`git` command was executed on the host**. Every command in this doc is for *you* (the verifier, who has a shell where the repos and `node_modules` live) to run. Treat all "verified" claims as "verified by reading the file," not "verified by execution," unless explicitly marked otherwise.
>
> All paths are absolute under `E:/hooks` unless noted.

---

## 1. Purpose & how to use this document

This system adds **page-closure migration tooling** to the existing `E:/hooks` control plane. The tooling traces a single frontend entry (a page/route/component) and its transitive TypeScript import-closure out of a **donor** repo and governs porting it into a **target** repo, using two enforcement points: a pre-edit gate (block editing the target until the closure is mapped and every node adjudicated) and a completion check (structure + types + donor/target reconcile).

Use this doc as a verification harness:
- **§3–§4** state facts about the live system and what was changed this session. Re-derive them from the anchors given.
- **§5** is the proposed (unbuilt) architecture. Judge it; do not assume it exists.
- **§6** lists things an earlier draft got wrong — confirm each correction.
- **§7** is the atomic claim checklist: *claim → how to verify → expected result*. This is the core deliverable for an independent pass.
- **§8** is the implementation sequence, split by who may do each step (agent-draftable vs operator-lock).
- **§9** is the honest list of things this author did **not** verify.

---

## 2. System overview

- **Bundle:** `E:/hooks/depcruiser-migrations/` — a self-contained directory holding the migration skill, scripts, the rule config, and the pre-edit gate. It lives under `E:/hooks/` because there is no separate plugin directory yet. Dir name = the job (migration); internal files keep `closure-*` names because they are mechanism-accurate (the gate checks the import **closure**; the manifest **is** one). The pre-edit gate's hook **id is `closure-gate`** (= its filename), unchanged by the dir rename.
- **Graph tool:** `dependency-cruiser` only (invoked as `depcruise`). Madge was dropped earlier. Two non-obvious facts the verifier should re-confirm (§7): `--ts-pre-compilation-deps` is **required** or type-only imports drop from the closure; and `depcruise --output-type json` **exits 0 even on rule violations**, so JSON-mode gating must parse the result, not trust the exit code (the default reporter *does* exit non-zero, which is what the completion commands rely on).
- **Donor reference:** OpenHands frontend (`E:/kai-chattr/_references/openhands/frontend`), entry `src/routes/conversation.tsx`.
- **Target repos (rebuild kind):** `kai-chattr` (`E:/kai-chattr`), `blockdata` (`E:/blockdata`), `kai` (`E:/kai-ai`).

---

## 3. Control-plane wiring (verified by reading the files)

### 3.1 Two databases
- **`E:/hooks/_db/hooks.db`** — observability/coordination substrate. Tables (verified via a read-only copy): `hook_events(id, ts, ts_iso, session_id, project, hook_id, event, tool_name, target, decision, status, duration_ms, detail)` and `thinking_gate_consumptions(id, ts, session_id, thinking_event_id UNIQUE, tool_name)`.
  - `hook-telemetry` (PostToolUse + PostToolUseFailure) **writes** `hook_events`.
  - `loop-safety` (PreToolUse) **reads** `hook_events` to count consecutive same-error failures of one operation.
  - `thinking-gate` (PreToolUse) **reads** `hook_events` for the latest thinking-tool call and **writes/reads** `thinking_gate_consumptions` (the `UNIQUE` `thinking_event_id` enforces one-use tickets).
- **`E:/memory/memory-sqlite.db`** — recall/skills store: `memories` + `memory_content_fts`, `skills` + `skills_fts`. **Read** by `inject-protocol` on every prompt; the skills side is **rebuilt** by the `skill-indexer` script; `memory-normalizer` touches memory tags/type/metadata and logs visibility back into `hook_events`. *(This DB was described from config, not opened — see §9.)*

### 3.2 Config → model → schema → validator loop
- **`config.json`** (version 2) is the single source of truth: `shared`, `hooks[]`, `scripts[]`. `"$schema": "./config.schema.json"`.
- **`_core/config-model.mjs`** is the *real* source. It exports both `generateConfigSchema()` (emits the JSON Schema) **and** `validateConfig()` (a hand-written semantic/cross-field validator), plus enum tables. The `hook` schema is **generic**; only `inject-protocol` settings and `skill-indexer` settings are special-cased. `validateConfig()` special-cases only `inject-protocol`, `hook-telemetry`, `loop-safety`, `thinking-gate`, `skill-indexer`. A plain gate is checked **only** by the generic `validateHook` (id/category/event/enabled/failPolicy/scriptRef).
- **`config.schema.json`** is **generated** output (`node _core/generate-config-schema.mjs`). It is not hand-edited.
- **`_core/validate-runtime-hooks.mjs`** ties it together: re-derives the schema and **fails if `config.schema.json` is stale**, asserts `$schema`, runs `validateConfig()`, and errors if any **enabled** hook/script path is missing on disk (a **disabled** hook/script with a missing path is only a warning).

### 3.3 Hook loading
Every hook resolves itself by `id` (= its filename) out of `config.json` via a runtime helper (`hookRuntime` for node, `_core/hook_runtime.py` for python). The migration gate's `closure-gate-core.mjs` mirrors `quality-completion-gate/quality-gate-core.mjs`. Hook output contract (cross-runtime): a JSON decision on stdout, **always exit 0**; a PreToolUse denial uses `hookSpecificOutput { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason }` (Claude) plus a top-level `systemMessage` (Codex).

### 3.4 Completion gate
`quality-completion-gate` (Stop, node) diffs git status, maps changed files to a repo's `domains` in `quality-completion-gate/quality-verify-manifest.json`, runs that domain's commands, and gates **on exit codes only**. Each repo entry has a `blockOnUnmatched` flag.

### 3.5 Skill discovery (two independent surfaces)
1. **FTS suggestion:** `skill-indexer` rebuilds `skills`/`skills_fts` (in the memory DB) from on-disk `SKILL.md` files under its `scanRoots`. `inject-protocol` queries that on every prompt and suggests ≤2 skills.
2. **Catalog allowlist:** `skills-catalog.md` is consulted by the `using-superpowers` routing skill; a regex extracts the back-ticked skill ids as the allowlist.
For a skill to participate in *automatic* discovery it must be **both** under a `scanRoot` **and** listed in the catalog. Explicit/by-name invocation does not require either.

### 3.6 `.state/` substrate
`.state/` holds per-hook runtime state: event logs (`inject-protocol-events.jsonl`, `inject-protocol-complex-events.jsonl`) and per-hook dirs (`quality-gate/`). It is **not declared in `config.json`** and is **outside the git-tracked / quality-gate-matched surface** (so writes there cannot trip the completion gate). This is the basis for the proposed arming design (§5.1).

---

## 4. Current on-disk state (including this session's changes)

### 4.1 What exists in the bundle now — `E:/hooks/depcruiser-migrations/`
- `closure-gate.mjs` + `closure-gate-core.mjs` — the PreToolUse gate. **As written today it reads the active-migration name from the hook's `config.json` settings** (`settings.active.name`) via `hookRuntime` + a `manifestPathFor(runtime, name)` helper. Behavior (verified by the author in a *sandbox* against a fake config, not on the host): dormant when unarmed; deny (`hookSpecificOutput…permissionDecision:"deny"`, + `systemMessage`) when the manifest is missing or any node verdict is still `TBD`; `{ "continue": true }` for non-edit tools and when all verdicts are set; exits 0 in all cases; fail-open.
- `generate-closure-manifest.mjs` — CLI: `node generate-closure-manifest.mjs <donor.depcruise.json> <out.manifest.json> [--entry <src/path>]`. Emits every node with `verdict: "TBD"`, plus `port_order` (leaves-first), `imported_by`, `reachable_via` (value/type-only/dynamic), `external_deps`, `unresolved`.
- `validate-closure-manifest.mjs` — CLI: `--mode verdicts --manifest <m.json>` (exit 1 if any verdict is not port/adapter/cut; used by the gate) and `--mode reconcile --manifest <m.json> --target <target.depcruise.json>` (exit 1 if target ≠ donor − cuts + adapters; intended for the completion gate).
- `dependency-cruiser.cjs` — rule config: `no-circular`, `no-unresolvable`, a scaffold-import ban; `tsConfig` + `tsPreCompilationDeps: true` + `doNotFollow` node_modules.
- `closure-gate.register.json` — **DRAFT** registration (a `hookEntry` for `config.json` and a `verifyManifestDomain`). Paths were updated to `depcruiser-migrations/` this session; `id` stays `closure-gate`; ships `enabled: false`.
- `README.md` — rewritten this session to the new dir name.
- `initialize-depcruiser-migrations/SKILL.md` — written this session (the agent-facing how-to: inquire → install → trace → generate → arm).
- `manifests/` — empty; per-migration artifacts land in `manifests/<name>/`.

### 4.2 Changes made this session
- **Renamed** `E:/hooks/closure-gate/` → `E:/hooks/depcruiser-migrations/` (directory move).
- Rewrote `closure-gate.register.json` and `README.md` to the new dir name (kept hook `id = closure-gate`).
- Added `initialize-depcruiser-migrations/SKILL.md`.
- **No change to `config.json`, `config.schema.json`, `quality-verify-manifest.json`, `skills-catalog.md`, the `_core` files, or any database.**

### 4.3 What is explicitly NOT done
- `closure-gate` is **not** registered in `config.json` (it exists only in the draft `register.json`).
- The completion `closure` domain is **not** in `quality-verify-manifest.json`.
- `dependency-cruiser` install state in the repos is unverified (no host shell).
- The gate is **not** enabled; nothing is live.

---

## 5. Proposed design (NOT yet built — judge, don't assume)

### 5.1 Single arm-state file in `.state/`
Move the active-migration pointer out of `config.json` settings and into **`E:/hooks/.state/depcruiser-migrations/active.json`**, matching the per-hook `.state/` convention (§3.6). Proposed shape:
```json
{ "name": "conversation-page", "repo": "kai-chattr",
  "targetEntry": "apps/web/src/routes/conversation.tsx",
  "targetCwd": "E:/kai-chattr/apps/web",
  "targetGlob": "apps/web/src/**", "armedAt": "<iso>" }
```
Rationale: arming becomes a **worker-writable** action (true one-command initiate) instead of a `config.json` edit (operator lock domain), and it lands outside the git-tracked/quality-gate surface so it can't trip the completion gate. **This requires editing `closure-gate-core.mjs` to read the active migration from `active.json` instead of `settings.active`.** `config.json` settings would retain only declarative fields (`manifestsDir`, `editTools`).

### 5.2 Completion via one runner + a one-line-per-repo domain
**Problem this solves:** a hand-authored `closure` domain with a repo's paths/cwd baked in does not scale across target repos with different layouts (e.g., `kai-chattr` → `apps/web/`, `blockdata` → `apps/web/`, `kai` → unknown), and it would live in `quality-verify-manifest.json` (operator lock surface), making *every migration* a gated manual edit.

**Design:** the per-repo/per-migration specifics live in `active.json` (§5.1), and completion is an **indirection**:
- A new runner **`verify-active-closure.mjs`** reads `active.json`; if nothing is armed it **exits 0 immediately**; if armed it resolves `targetEntry`/`targetCwd` and runs, in order: `depcruise --config <bundle>/dependency-cruiser.cjs` (rules), `tsc --noEmit` in `targetCwd`, then a target trace + `validate-closure-manifest.mjs --mode reconcile`. Gates on its own exit code.
- Each target repo gets **one** `closure` domain in `quality-verify-manifest.json`: a single command (`node E:/hooks/depcruiser-migrations/verify-active-closure.mjs`) under a `paths` match = that repo's frontend prefix (e.g., `apps/web/`). The command is **identical across repos**; only the prefix differs. Adding a new target repo = one near-identical line; directory-structure differences are absorbed by `active.json`, not by re-authoring commands.

The **same `active.json`** is read by both the PreToolUse gate (block pre-edit) and the completion runner (verify post). Single arm state, two readers. This mirrors the existing pattern where domain commands are already scripts (`check-contracts.mjs`, `check-deps.mjs`).

### 5.3 dependency-cruiser install model
Per-repo dev-dependency: install `dependency-cruiser` in the **donor** (for the trace) and the **target** (for the completion rule check; the target's own `tsc` covers the typecheck), only if absent. Detect the package manager by lockfile. *(An alternative — vendoring depcruise inside the bundle and pointing `--ts-config` at each repo — was considered and not chosen.)*

### 5.4 `initialize-depcruiser-migrations` skill (already on disk; one step changes under §5.1)
Inquire (donor repo + **specific entry**, target repo + landing) → install depcruise in both → `mkdir manifests/<name>` → trace donor → generate manifest. Final step today is written as an **operator handoff** to set `config.json` `settings.active.name`; under §5.1 it becomes a worker write of `active.json` (self-arm). The skill should be updated to whichever arming model is approved.

---

## 6. Corrections to earlier drafts (confirm each)

1. **Registering `closure-gate` does NOT require regenerating `config.schema.json`.** The schema is generic over hooks and the model has no closure-specific rule, so the entry is schema-valid as-is. The draft `register.json` `_draft` note and `README.md` currently say to "regenerate `config.schema.json` from `_core/config-model.mjs`" as a lock step — that is only true if a closure-specific rule is *added* to the model. Correct lock steps: add the entry → `node _core/validate-runtime-hooks.mjs` → flip `enabled`.
2. **The rename desynced the completion gate.** `quality-verify-manifest.json` → `repos[name="hooks"]` has `blockOnUnmatched: true`, and its `runtime` domain `paths.prefixes` still lists `closure-gate/` while `depcruiser-migrations/` is **absent**. An agent editing the renamed dir would therefore hit *unmatched → blocked at Stop*. The prefix must be updated. (That prefix list is also broadly pre-`_`-reorg: it contains `docs/`, `lib/`, `scripts/`, `telemetry/`, none of which match the current `_`-prefixed layout; only `_core/` matches. A wider sweep is optional.)
3. **The bundle-placed skill is invisible to automatic discovery as-is.** `skill-indexer` `scanRoots` is warehouse-only (`E:/__skills`), so nothing under `depcruiser-migrations/` is indexed; and `skills-catalog.md` still lists the stale **`install-closure-tooling`** ("Madge + dependency-cruiser") with no `initialize-depcruiser-migrations`. Full auto-discovery needs a `scanRoot` add **and** a catalog swap. By-name invocation works regardless.
4. **The gate's arm source must change for the `.state` design.** `closure-gate.mjs`/`-core.mjs` currently read `settings.active`; §5.1 moves this to `active.json`. This is a code change to the gate, not just a manifest/config edit.
5. **The draft `verifyManifestDomain` is over-specific.** It hardcodes `src/routes/` and per-repo command paths. Per §5.2 it should be the runner one-liner + a per-repo prefix template, not a baked-in domain.

---

## 7. Verification checklist (claim → verify → expected)

Run on the host (where `node`, `python`, and the repos live). "Inspect" = open the file and read the named field.

1. **config.json has no `closure-gate`.**
   Verify: inspect `config.json` `hooks[].id`.
   Expected: ids are inject-protocol, inject-protocol-complex, hook-telemetry, thinking-gate, memory-normalizer, loop-safety, quality-completion-gate, governance-gate. **No** `closure-gate`.

2. **Schema is generated, and the validator currently passes.**
   Verify: `node E:/hooks/_core/validate-runtime-hooks.mjs`.
   Expected: prints `Runtime hook validation passed` (exit 0). (Confirms `config.schema.json` is in sync with the model *before* any closure-gate change.)

3. **Generic hook entry needs no model change.**
   Verify: inspect `_core/config-model.mjs` — the `hook` `$def` and `validateConfig()` for any branch keyed on a gate id other than the special-cased five.
   Expected: none; gates are validated only by generic `validateHook`. (Supports Correction 1.)

4. **Rename desync in the completion gate.**
   Verify: inspect `quality-completion-gate/quality-verify-manifest.json` → `repos[name="hooks"]` → `blockOnUnmatched` and `domains.runtime.paths[].prefixes`.
   Expected: `blockOnUnmatched: true`; prefixes include `closure-gate/`; prefixes do **not** include `depcruiser-migrations/`. (Confirms Correction 2 — the must-fix.)

5. **`blockOnUnmatched` actually blocks.** *(This author did not verify the code path — see §9.)*
   Verify: read `quality-completion-gate/quality-gate-core.mjs` and confirm that, for a repo with `blockOnUnmatched: true`, a changed file matching no domain yields a blocking decision.
   Expected: confirm or refute. **If refuted, Correction 2's severity changes.**

6. **Skill discovery surfaces.**
   Verify: inspect `config.json` `scripts[id="skill-indexer"].settings.scanRoots`; grep `skills-catalog.md` for `install-closure-tooling` and `initialize-depcruiser-migrations`.
   Expected: scanRoots = `[{path:"E:/__skills", …}]` only; catalog contains `install-closure-tooling`, **not** `initialize-depcruiser-migrations`. (Confirms Correction 3.)

7. **Bundle contents exist as described (§4.1).**
   Verify: list `E:/hooks/depcruiser-migrations/` and `E:/hooks/depcruiser-migrations/initialize-depcruiser-migrations/`.
   Expected: the files in §4.1; `manifests/` empty.

8. **Gate currently reads arm from config settings (not `.state`).**
   Verify: read `closure-gate-core.mjs` for how the active migration name is resolved.
   Expected: it reads `runtime.settings.active` (config), with `manifestPathFor`. (Supports Correction 4; `.state` is unbuilt.)

9. **Proposed artifacts do NOT exist yet.**
   Verify: check for `E:/hooks/.state/depcruiser-migrations/active.json` and `E:/hooks/depcruiser-migrations/verify-active-closure.mjs`.
   Expected: neither exists.

10. **Target repo layouts.**
    Verify: inspect `quality-verify-manifest.json` `repos[name in {kai-chattr, blockdata}].domains`.
    Expected: both expose `web` at `apps/web/`, `backend` at `services/api/`. `kai` (kai-ai) is **not** in the manifest — its layout is unverified (see §9).

11. **depcruise: `--ts-pre-compilation-deps` is required for type-only edges.** *(Re-test; the original sandbox proof is not on the host.)*
    Verify: on a tiny TS sample with a `import type` edge, run `depcruise --output-type json` with and without `--ts-pre-compilation-deps`.
    Expected: the type-only target is absent without the flag, present with it.

12. **depcruise JSON mode exits 0 on rule violations.** *(Re-test.)*
    Verify: run `depcruise --config <cfg> --output-type json` on input that violates a rule; check `$?`.
    Expected: exit 0 with `summary.error > 0` in the JSON (so JSON gating must parse `summary.error`; the default reporter is what exits non-zero for the completion commands).

---

## 8. Implementation steps (sequenced; A = agent-draftable, B = operator-lock)

> Lock convention: agents draft/recommend under `E:/hooks/**`; the operator (Jon) makes the binding edits to `config.json`, `config.schema.json`, `quality-verify-manifest.json`, and `skills-catalog.md`, and flips `enabled`. (`governance-gate` is planned to enforce this; it is currently `enabled:false` and its script is not built.)

**Phase 0 — repair what the rename already touched (do first).**
- **B0.1** Update `quality-verify-manifest.json` `repos[name="hooks"].domains.runtime.paths` prefix `closure-gate/` → `depcruiser-migrations/`. (Optional: sweep the other stale prefixes — `docs/`→`_docs/`, drop `lib/`/`scripts/`/`telemetry/` or correct them.) *Until this is done, agent edits under the new dir risk a Stop block (Correction 2).*

**Phase 1 — finalize bundle artifacts (agent-draftable, no live wiring).**
- **A1.1** Decide arming model (recommended: `.state/` per §5.1). If `.state`: edit `closure-gate-core.mjs` to read `active.json`; keep `manifestsDir`/`editTools` in config settings; define the `active.json` schema.
- **A1.2** Build `verify-active-closure.mjs` (the completion runner, §5.2): read `active.json` → unarmed exit 0 → armed run depcruise rules + `tsc --noEmit` in `targetCwd` + target trace + reconcile; exit-code authority.
- **A1.3** Update `initialize-depcruiser-migrations/SKILL.md` to write `active.json` (self-arm) if §5.1 is approved; otherwise keep the operator-handoff wording.
- **A1.4** Rewrite `closure-gate.register.json`: corrected lock steps (Correction 1, no schema regen), and replace the hardcoded `verifyManifestDomain` with the runner one-liner + per-repo prefix template (Correction 5).
- **A1.5** Update `README.md` to match (`.state` arm, runner completion, one-line-per-repo domain).
- **A1.6 (verify)** Re-run the gate's behavior tests against the `.state`-based arm in a sandbox; re-confirm claims 11–12.

**Phase 2 — go live, per target repo (operator-lock).**
- **B2.1** Install `dependency-cruiser` as a dev-dependency in the target repo (and in the donor when a trace is run), if absent.
- **B2.2** Add the `closure-gate` `hookEntry` to `config.json` `hooks[]`; run `node _core/validate-runtime-hooks.mjs` (must pass — **no schema regen**).
- **B2.3** Add the one-line `closure` domain (runner command + frontend prefix) to that repo's entry in `quality-verify-manifest.json`.
- **B2.4** Add `E:/hooks/depcruiser-migrations` to `skill-indexer` `scanRoots`; swap `skills-catalog.md` `install-closure-tooling` → `initialize-depcruiser-migrations` (depcruise-only wording); run the `skill-indexer`.
- **B2.5** Flip the `closure-gate` entry `enabled: true`.

---

## 9. Not verified by this author (edges for the verifier)

- **No host execution.** No `node`/`python`/`depcruise`/`tsc`/`git` was run on the host; "verified" means "read the file." Claims 2, 5, 11, 12 specifically need execution.
- **`blockOnUnmatched` code path** (claim 5) — stated from the manifest's semantics and an earlier read of `quality-gate-core.mjs`, not re-read this session.
- **`E:/memory/memory-sqlite.db`** — described from `config.json`, not opened.
- **Internal logic** of `loop-guard.py`, `thinking-gate.py`, `_core/hook_runtime.py`, `inject-protocol/index-skills.py`, `suggest.py`, `recall.py` — inferred from config entries + descriptions, not line-read.
- **kai (kai-ai) layout** — not present in `quality-verify-manifest.json`; its frontend path is unknown.
- **Catalog/FTS interaction** — whether `inject-protocol`'s FTS suggestion *additionally* filters by the catalog allowlist was not confirmed (`suggest.py` not read).
- **Gate behavior** was exercised in a sandbox against a fake config, never against a real repo edit on the host.

---

## 10. Appendix — key paths & commands

**Files**
- SSOT: `E:/hooks/config.json` · model: `E:/hooks/_core/config-model.mjs` · generated schema: `E:/hooks/config.schema.json`
- Validators: `E:/hooks/_core/validate-runtime-hooks.mjs`, `E:/hooks/_core/generate-config-schema.mjs`
- Completion manifest: `E:/hooks/quality-completion-gate/quality-verify-manifest.json` · core: `…/quality-gate-core.mjs`
- DBs: `E:/hooks/_db/hooks.db` (telemetry), `E:/memory/memory-sqlite.db` (memory + skills)
- Catalog: `E:/hooks/skills-catalog.md`
- Bundle: `E:/hooks/depcruiser-migrations/` (gate `closure-gate.mjs`/`-core.mjs`, `generate-closure-manifest.mjs`, `validate-closure-manifest.mjs`, `dependency-cruiser.cjs`, `closure-gate.register.json` [draft], `initialize-depcruiser-migrations/SKILL.md`, `manifests/`)
- State substrate: `E:/hooks/.state/` (proposed: `.state/depcruiser-migrations/active.json`)

**Commands the verifier will use**
- Validate control plane: `node E:/hooks/_core/validate-runtime-hooks.mjs`
- Regenerate schema (only if the model changes): `node E:/hooks/_core/generate-config-schema.mjs`
- Donor trace (from donor repo root): `npx depcruise --no-config --output-type json --ts-config <donor-tsconfig> --ts-pre-compilation-deps <donor-entry> > E:/hooks/depcruiser-migrations/manifests/<name>/before-edit.donor.json`
- Generate manifest: `node E:/hooks/depcruiser-migrations/generate-closure-manifest.mjs <donor.depcruise.json> <out.manifest.json> --entry <donor-entry>`
- Verdict gate: `node E:/hooks/depcruiser-migrations/validate-closure-manifest.mjs --mode verdicts --manifest <m.json>`
- Reconcile: `node E:/hooks/depcruiser-migrations/validate-closure-manifest.mjs --mode reconcile --manifest <m.json> --target <target.depcruise.json>`
