# Codex Hook System Proposal

Author: Codex
Date: 2026-06-01
Target directory: `E:/hooks`

## Recommendation

Build the next hook system as a shared runtime plus event-specific hook modules.
Keep the existing `UserPromptSubmit` injector and the deterministic `Stop`
quality gate, but move both onto a common substrate before adding more gates.

The first implementation milestone must not be another standalone hook. It
must be the substrate:

- `lib/hook-runtime.mjs` for event parsing, config loading, fail policy,
  timeout handling, logging, and output shape.
- `schemas/*.schema.json` for config and manifest validation.
- `scripts/test-hook.mjs`, `scripts/validate-config.mjs`, and
  `scripts/doctor.mjs` for local verification.
- A hook console CLI for status, logs, dry runs, and manifest coverage.

After that, add the prevention and telemetry hooks. This keeps the system
cohesive instead of becoming a pile of unrelated scripts.

## Current Baseline

Live Codex config currently wires two hooks:

- `UserPromptSubmit`: `node E:/hooks/inject-protocol/inject-protocol.mjs`
- `Stop`: `node E:/hooks/quality-completion-gate/quality-completion-gate.mjs`

`E:/hooks/config.json` exists and is the intended central registry. It declares:

- `inject-protocol`, enabled, fail-open
- `quality-completion-gate`, enabled, fail-open
- `governance-gate`, planned, currently disabled, fail-closed
- shared project paths, memory paths, stopwords, runtime timeouts, and script
  entries

Current issues that the next design must fix:

- `E:/hooks/config.schema.json` is referenced but missing.
- `E:/hooks` is not a git repo, so git-root based quality checks do not cover
  hook-system self-edits.
- `config.json` still contains `_notWired` migration notes, which means the
  registry is not yet fully consumed by all loaders.
- `config.json` and manifests are mutable policy surfaces. A stable adapter
  reduces runtime trust churn, but config and manifest edits are not security by
  themselves. They must be validated and protected by governance rules.
- The quality gate is deterministic, but it still gates the whole dirty repo
  rather than a task-scoped change set.

## Operating Context From Memory And Current Docs

This proposal must bake in the history of what has been going wrong, not only
the desired architecture.

### Vector Memory Findings

The MCP-router vector memories surfaced these durable constraints:

- Agents working on `E:/` are expected to check vector memory, inspect current
  repo state, load applicable skills, and verify before completion.
- Skill theater is prohibited. Naming or listing a skill is not enough; the
  system must push agents toward actual invocation and useful application.
- A prior coordination pattern underused skills because the agent treated skill
  loading as optional or invisible. Hook design must make skill and memory use
  visible, routine, and hard to skip on substantive work.
- Repo writes must follow contracts/governance first when such contracts exist.
  The hook system must therefore protect policy surfaces and enforce current
  repo rules instead of trusting agent claims.

### Current Design Notes

`E:/hooks/docs/skill-memory-enforcement-design.md` identifies the core failure:
instructions are not enough. Agents skip effortful optional steps when those
steps slow down the immediate answer. The design response is:

- `PUSH`: `UserPromptSubmit` performs memory recall and skill suggestion so the
  agent does not have to remember to do the search manually.
- `GATE`: `PreToolUse` can block feature-code writes until the required
  workflow has actually happened.

The old evidence-tracker idea was rejected because it inferred quality from
command strings and regex matches. The new quality direction must stay
deterministic: compute changed surfaces, run declared verification commands,
and gate on exit codes only.

### Multi-Agent Coordination Notes

The coordination transcript in the attached context established these working
rules:

- OSS clones belong under `E:/hooks/references`.
- Reference repos are inputs for borrowing patterns, not runtime code.
- Promoting borrowed ideas into `E:/hooks` requires explicit implementation
  edits and review.
- The immediate lanes are substrate first, quality gate next, governance gate
  after the harness, with reference findings feeding each lane.

### Implications For This Proposal

The hook system must do more than inject reminders. It must:

- preserve the working prompt injector,
- make memory and skill routing visible and harder to skip,
- protect the policy/config surfaces that control the gates,
- make completion quality deterministic,
- record telemetry without allowing telemetry to become fake proof,
- provide a console/doctor surface so operators can see what is wired and why a
  hook blocked,
- treat `E:/hooks/references` as read-only reference material unless a user
  explicitly asks to port a pattern.

## Reference Findings

The local references are useful, but only as patterns to borrow.

### Codex CLI Hooks

Borrow:

- Treat lifecycle events as a complete system, not only `UserPromptSubmit`.
- Model all eight available events: `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `PreCompact`, and
  `PostCompact`.
- Keep hook registration thin and stable.

Do not borrow:

- Demo-style hooks where every event only plays a sound or logs raw payloads.
  We need policy, validation, and interoperation.

### Eyelet

Borrow:

- Universal event logging for debugging hook behavior.
- `doctor` and `validate` commands.
- Structured logs organized by event, tool, session, and timestamp.
- SQLite or JSONL logging with local-only retention.

Adaptation:

- Start with JSONL and per-session state files because they are simple and
  dependency-light on Windows.
- Keep the schema compatible with a later SQLite backend if logs grow.

### Clyro

Borrow:

- Local policy model with explicit `default_action`.
- Rule actions: `allow`, `block`, and `require_approval`.
- Session state and loop detection.
- Redaction rules for audit logs.
- Clear distinction between local policy, merged policy, state, and audit.

Adaptation:

- Do not add a cloud policy backend.
- Keep policies local and repo/operator governed.
- Use loop safety for Stop continuations and repeated failing tool actions.

### AgentiHooks

Borrow:

- Central hook manager pattern.
- Lazy imports / lightweight startup for frequent events.
- Retry breaker based on operation fingerprint plus normalized error text.
- Context audit that tracks tool-output volume.
- Context preprocessing with protected spans for code, paths, numbers, and
  high-risk words.

Adaptation:

- Use Node modules instead of a Python monolith, because the current hooks are
  already Node and Codex config is already wired to Node scripts.
- Borrow the retry/context ideas, not the full framework.

### claude-hooks

Borrow:

- Bash command decomposition before policy evaluation.
- Tests around compound shell commands, pipes, heredocs, subshells, and
  settings merge behavior.

Adaptation:

- Use this only for `PreToolUse` governance. It must not become the basis of
  quality completion, which must stay exit-code based.

### Lefthook

Borrow:

- Job schema concepts: `root`, `glob`, `exclude`, `env`, `timeout`, `parallel`,
  `piped`, `priority`, and grouped jobs.
- Validate every declared job before running it.
- Keep changed-file matching declarative.

Adaptation:

- Use a smaller JSON schema first. Avoid full Lefthook compatibility until
  there is a real need.

### pre-commit

Borrow:

- Strict config and manifest validation before hook execution.
- Separate config schema from manifest schema.
- Changed-file discipline and explicit stages.
- "Fail if no tests ran" style safety for policy tests and manifests.

Adaptation:

- Avoid hidden mutation of the worktree. Our Stop gate should run verifiers,
  not auto-fix.

### Open Policy Agent

Borrow:

- Policy-as-data boundary.
- Testable policy decisions with input fixtures.
- JSON output for machine-readable test reports.
- Coverage/fail-on-empty thinking for policy tests.

Adaptation:

- Do not introduce Rego in the first build. Use JSON policy predicates until
  the policy language is the bottleneck.

## Hook Responsibility Matrix

Each hook must have a narrow job, a clear reason to exist, and a defined
authority boundary.

| Hook event | Hook/module | What it does | Why it matters for us | Authority |
|---|---|---|---|---|
| `SessionStart` | `session-start/session-start.mjs` | Emits a cheap environment snapshot: cwd, project slug, repo root, branch, dirty count, enabled hooks, missing schemas, and current date. | Prevents agents from starting blind and catches obvious wiring/config drift before work begins. | Advisory only; never blocks. |
| `UserPromptSubmit` | `inject-protocol/inject-protocol.mjs` | Keeps the per-prompt protocol visible, performs memory/vector recall, suggests one or two skills, and caps injected context. | Direct answer to the documented failure where agents skipped memory and skill steps. It turns recall and skill routing into a system action instead of an optional agent chore. | Advisory push; fail-open. |
| `PreToolUse` | `governance-gate/governance-gate.mjs` | Evaluates write tools and shell commands before execution. Protects `E:/hooks/**`, schemas, manifests, governance files, secrets, destructive commands, and high-risk path writes. | Prevents agents from weakening the hook system, bypassing governance, or damaging workspaces before the damage happens. It also enforces real skill/workflow prerequisites for risky writes where supported. | Blocking gate; fail policy is per rule, default closed for protected policy surfaces. |
| `PermissionRequest` | `permission-context/permission-context.mjs` | Adds concise policy context to approval requests and logs the request. | Helps the user approve or deny sensitive actions with context instead of guessing why the agent needs permission. | Advisory/logging unless runtime exposes a safe decision API. |
| `PostToolUse` | `telemetry/post-tool-audit.mjs` | Records tool name, cwd, touched path, command fingerprint, exit status if available, output size, duration, and error fingerprint. Feeds retry breaker and context audit state. | Gives us observability into actual behavior and repeated failures without making regex telemetry the basis for completion quality. | Telemetry only; never proves quality. |
| `Stop` | `quality-completion-gate/quality-completion-gate.mjs` | Determines changed domains, validates the manifest, runs declared verifier jobs, respects `stop_hook_active`, and blocks only on verifier exit codes. | This is the deterministic completion gate. It prevents "done" claims when tests/builds/contracts required for touched surfaces fail. | Blocking quality gate; exit codes only. |
| `PreCompact` | `context-hygiene/pre-compact.mjs` | Saves a compact session summary: current task, blockers, changed files, verifier failures, active skills, and recent policy decisions. | Prevents context compaction from erasing the facts needed to finish safely. | Advisory/state capture. |
| `PostCompact` | `context-hygiene/post-compact.mjs` | Re-injects the compact summary after compaction and flags missing state. | Keeps the agent from losing the thread after compaction and repeating prior mistakes. | Advisory push; fail-open. |

Manual scripts are also part of the hook system:

| Script | What it does | Why it matters |
|---|---|---|
| `scripts/test-hook.mjs` | Runs fixture payloads through each hook and validates stdout shape, exit code, timeout behavior, and loop safety. | Prevents hook edits from being trusted by vibes. |
| `scripts/validate-config.mjs` | Validates `config.json`, local overrides, and manifests against schemas. | Turns config into a governed policy surface instead of a loose JSON blob. |
| `scripts/doctor.mjs` | Compares live Codex hook wiring, `E:/hooks/config.json`, script existence, schemas, and manifest command availability. | Answers "why did this hook fail or not fire?" without manual archaeology. |
| `scripts/hooks-console.mjs` | Operator console for status, logs, dry runs, coverage, and recent failures. | Gives Jon and agents a single place to inspect the system before changing it. |

## Target Architecture

### Directory Shape

```text
E:/hooks/
  config.json
  config.local.json                  # optional, gitignored if E:/hooks becomes a repo
  config.schema.json
  lib/
    hook-runtime.mjs
    hook-config.mjs
    hook-logger.mjs
    event-normalizer.mjs
    command-policy.mjs
    path-policy.mjs
    job-runner.mjs
  schemas/
    hook-config.schema.json
    quality-verify-manifest.schema.json
    governance-policy.schema.json
    hook-event-fixture.schema.json
  scripts/
    test-hook.mjs
    validate-config.mjs
    doctor.mjs
    hooks-console.mjs
    index-skills.py
    normalize-memory-tags.py
  inject-protocol/
    inject-protocol.mjs
    per-prompt-protocol.md
  quality-completion-gate/
    quality-completion-gate.mjs
    quality-gate-core.mjs
    quality-verify-manifest.json
  governance-gate/
    governance-gate.mjs
    governance-policy.json
  telemetry/
    post-tool-audit.mjs
  .state/
    sessions/
    logs/
    fixtures/
  references/
    ...
```

### Runtime Contract

Every hook script should be a thin event module:

1. Read stdin through `readHookInput()`.
2. Normalize to one envelope:
   - `eventName`
   - `sessionId`
   - `turnId`
   - `cwd`
   - `repoRoot`
   - `toolName`
   - `toolInput`
   - `transcriptPath`
   - `stopHookActive`
   - `raw`
3. Load `config.json` plus optional `config.local.json`.
4. Find its hook entry by `id`.
5. Apply fail policy and timeout budget.
6. Run the hook module.
7. Emit only the runtime-valid JSON shape for that event.
8. Write diagnostics to logs, not noisy stdout/stderr.

This makes hook behavior consistent across `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, and future events.

### Config Model

Keep `config.json` as the registry, but make it validateable.

Required top-level sections:

- `version`
- `shared`
- `events`
- `hooks`
- `scripts`
- `projects`
- `policies`
- `state`

Recommended split:

- `config.json`: hook registry, runtime defaults, project registry.
- `config.local.json`: local overrides only.
- `quality-verify-manifest.json`: verification domains and jobs.
- `governance-policy.json`: write/shell/path approval rules.
- `schemas/*.schema.json`: validation authority.

Do not put large policy bodies inside the adapter script. The adapter should be
stable; config and manifests should be validated and protected.

## Hook Lifecycle

### 1. SessionStart: Environment Snapshot

Purpose: push low-cost session facts before work starts.

Behavior:

- Report cwd, repo root, branch, dirty count, active project slug, configured
  hooks, and missing schemas.
- Never block.
- Never run expensive commands.

Why: this gives the agent useful context before the first answer without making
every prompt heavier.

### 2. UserPromptSubmit: Protocol and Recall Injection

Purpose: keep and improve the current injection hook.

Behavior:

- Inject the per-prompt protocol.
- Retrieve ranked memory recall.
- Suggest one or two skills.
- Cap output.
- Fail open.

Required upgrades:

- Move config loading to `lib/hook-runtime.mjs`.
- Read `shared.projects[]`, not the old `shared.projects.slugs` fallback.
- Move skill boost rules and noise terms into config.
- Add fixtures for representative prompts and expected skill suggestions.

This remains the primary "push" hook.

### 3. PreToolUse: Governance Gate

Purpose: prevent dangerous or policy-breaking actions before they happen.

Behavior:

- Match write tools and shell commands.
- Protect `E:/hooks/**`, hook manifests, schemas, and governance files.
- Parse Bash into subcommands before evaluation.
- Require explicit user approval for protected writes.
- Block destructive commands by policy.
- Record allow/block/approval decisions to telemetry.

Authority:

- This hook can block because it prevents high-risk actions.
- It must explain the exact policy rule and path/command that triggered.

Initial policies:

- Block edits to `E:/hooks/config.json`, schemas, manifests, and hook scripts
  unless the current user prompt explicitly approves that path.
- Block recursive deletion, force reset, broad move/delete, and shell writes
  outside the current workspace unless explicitly approved.
- Require approval for adding or changing hook registration in Codex config.

### 4. PermissionRequest: Policy Context

Purpose: enrich sensitive-operation approval requests.

Behavior:

- Log the request.
- Attach concise policy context if the runtime supports it.
- Never make quality decisions.

This is optional until Codex exposes enough payload detail to make it useful.

### 5. PostToolUse: Telemetry Only

Purpose: record facts after tools run.

Behavior:

- Record tool name, exit status if available, output size, command fingerprint,
  touched path, duration, and error fingerprint.
- Feed retry breaker and context audit state.
- Never decide whether work is complete.
- Never satisfy quality requirements by string matching command text.

Authority:

- No blocking authority for completion.
- It can only inform later diagnostics and continuation prompts.

### 6. Stop: Deterministic Quality Gate

Purpose: block incomplete work only when manifest-declared verification fails.

Behavior:

- Read git status for repos that are git repos.
- For `E:/hooks`, support a non-git self-check mode until the directory is a
  repo.
- Map changed files or declared paths to domains.
- Run manifest-declared jobs.
- Gate only on exit codes.
- Respect `stop_hook_active` and never re-block the same continuation loop.

Required upgrades:

- Add manifest schema validation.
- Validate every command exists before enabling a repo.
- Add dry-run mode for all manifest jobs.
- Decide and encode scope:
  - `dirtyRepo`: current behavior.
  - `sessionTouched`: paths seen in this session telemetry.
  - `always`: run for non-git hook-system checks.
- Add `E:/hooks` coverage with cheap checks:
  - `node --check` for hook scripts.
  - `node scripts/validate-config.mjs`.
  - `node scripts/test-hook.mjs --suite smoke`.
  - `python -m py_compile scripts/index-skills.py scripts/normalize-memory-tags.py`.

### 7. PreCompact and PostCompact: Context Hygiene

Purpose: preserve useful session state around context compaction.

Behavior:

- PreCompact records session summary, open blockers, recent verifier failures,
  and active project slug.
- PostCompact injects the compact state back into context.
- Compression must protect paths, code, negations, numbers, and policy words.

This is a later phase. It is useful, but not as urgent as runtime, validation,
and governance.

## Interoperation Rules

All hooks must build on the same shared facts:

- One project registry.
- One event envelope.
- One session state location.
- One logging format.
- One fail-policy model.
- One schema-validation path.
- One policy-surface protection rule.

No hook should hardcode its own project list, protected path model, timeout
defaults, or config parser after the runtime exists.

Authority boundaries:

- `UserPromptSubmit`: advisory push only.
- `PreToolUse`: prevention gate.
- `PostToolUse`: telemetry only.
- `Stop`: deterministic verification gate.
- Manual scripts: validation, doctor, smoke tests, indexing.

## Hook Console

Create `scripts/hooks-console.mjs` as the operator surface.

Minimum commands:

```text
node E:/hooks/scripts/hooks-console.mjs status
node E:/hooks/scripts/hooks-console.mjs validate
node E:/hooks/scripts/hooks-console.mjs doctor
node E:/hooks/scripts/hooks-console.mjs test --all
node E:/hooks/scripts/hooks-console.mjs logs --session <id>
node E:/hooks/scripts/hooks-console.mjs dry-run stop --cwd <path>
node E:/hooks/scripts/hooks-console.mjs dry-run pretool --fixture <file>
node E:/hooks/scripts/hooks-console.mjs coverage
```

Console output should answer:

- Which hooks are wired in Codex config?
- Which hooks are enabled in `E:/hooks/config.json`?
- Which declared scripts are missing?
- Which schemas are missing?
- Which manifests have commands that do not exist?
- Which projects are unverified or unmatched?
- Which protected policy surfaces are currently writable without approval?

## Implementation Plan

### Phase 0: Substrate First

Files:

- Add `lib/hook-runtime.mjs`.
- Add `lib/event-normalizer.mjs`.
- Add `lib/hook-config.mjs`.
- Add `lib/hook-logger.mjs`.
- Add `schemas/hook-config.schema.json`.
- Add `schemas/quality-verify-manifest.schema.json`.
- Add `scripts/validate-config.mjs`.
- Add `scripts/test-hook.mjs`.
- Add `scripts/doctor.mjs`.

Acceptance:

- `node E:/hooks/scripts/validate-config.mjs` passes.
- `node E:/hooks/scripts/doctor.mjs` reports current Codex hook wiring.
- `node E:/hooks/scripts/test-hook.mjs --suite smoke` runs fixtures for
  `UserPromptSubmit` and `Stop`.
- Existing live hook behavior is unchanged.

### Phase 1: Migrate Existing Hooks to Runtime

Files:

- Refactor `inject-protocol/inject-protocol.mjs` to use shared config/runtime.
- Refactor `quality-completion-gate/quality-completion-gate.mjs` to use shared
  runtime, event normalization, logging, and manifest schema validation.

Acceptance:

- `UserPromptSubmit` still injects protocol, memory, and skills.
- `Stop` still gates only on manifest command exit codes.
- No hook prints non-JSON stdout.
- Stop continuation loop safety remains present.

### Phase 2: Add Governance Gate

Files:

- Add `governance-gate/governance-gate.mjs`.
- Add `governance-gate/governance-policy.json`.
- Add Bash decomposition helpers in `lib/command-policy.mjs`.
- Add protected-path helpers in `lib/path-policy.mjs`.

Acceptance:

- Protected writes to `E:/hooks/**` block without explicit user approval.
- Normal reads/searches continue.
- Compound Bash commands are evaluated by subcommand, not as one raw string.
- Policy decisions are logged with rule id, path/command, and decision.

### Phase 3: Add Telemetry and Console

Files:

- Add `telemetry/post-tool-audit.mjs`.
- Add session state in `.state/sessions/`.
- Add JSONL logs in `.state/logs/`.
- Expand `scripts/hooks-console.mjs`.

Acceptance:

- PostToolUse records tool facts without blocking.
- Retry breaker can identify repeated failing operations.
- Context audit can report the largest output sources on Stop.
- Console can show last session, blocked rules, and verifier failures.

### Phase 4: Advanced Policy Only If Needed

Only consider OPA/Rego or another policy language if JSON predicates become too
weak to express real policy. Until then, the cost is not justified.

If adopted later, it must come with:

- policy tests,
- fail-on-empty test behavior,
- JSON decision output,
- a small fixture set for every protected rule.

## Immediate Next Steps

1. Add missing `config.schema.json` and validate the current `config.json`.
2. Add `scripts/test-hook.mjs` with two smoke fixtures:
   - `UserPromptSubmit` sample prompt.
   - `Stop` sample payload with `stop_hook_active=true`.
3. Add `scripts/doctor.mjs` to compare live Codex config with `E:/hooks/config.json`.
4. Add `E:/hooks` self-check coverage to the quality manifest using non-git
   `always` mode.
5. Implement governance gate only after the runtime/test harness exists.

## Lock Criteria

Do not call the hook system "locked" until these are true:

- Config and manifests validate against schemas.
- Existing hooks run through the shared runtime.
- The Stop gate is loop-safe and stderr-clean.
- `E:/hooks` self-edits are covered by checks.
- Governance protects the policy surfaces that can weaken the gates.
- Every manifest command has been dry-run in the current repo state.
- Telemetry is non-authoritative and cannot satisfy quality completion.
- The console can show wiring, status, config validity, and recent failures.

## Core Decision

Use a layered hook system:

```text
SessionStart      -> cheap environment context
UserPromptSubmit  -> protocol, memory, skills
PreToolUse        -> prevent unsafe actions
PermissionRequest -> approval context
PostToolUse       -> telemetry only
Stop              -> deterministic verification
PreCompact        -> preserve state before compaction
PostCompact       -> restore compacted state
```

The shared runtime is the spine. The injector remains the push layer. The
governance gate becomes the prevention layer. The quality gate remains the
deterministic completion layer. The console and schemas make the whole system
operable instead of opaque.
