# Codex Proposal: Full Hook System

Status: Proposed
Author: Codex
Date: 2026-06-01
Location: `E:/hooks/codex-proposal.md`

## Direct Recommendation

Keep `E:/hooks/config.json`, but promote it from "current registry" to a schema-validated hook control plane.

Do not replace it with OPA/Rego or a wholesale OSS framework now. The stronger move is:

- one event dispatcher model
- one schema-validated config surface
- one shared runtime library
- one job manifest model for verification work
- one state directory for loop guards, approvals, and hook telemetry

## Current Reality Checked

- `E:/hooks/config.json` exists and is valid JSON.
- `E:/hooks/config.schema.json` does not exist, despite `config.json` referencing it.
- `inject-protocol/inject-protocol.mjs` is wired in Codex and Claude settings.
- `quality-completion-gate/quality-completion-gate.mjs` is wired in Codex `Stop`.
- `quality-completion-gate/quality-verify-manifest.json` is the current quality job manifest.
- `governance-gate` exists as a directory, but the gate is disabled and not implemented.
- `E:/hooks` is not a git repo, so the current Stop gate does not protect edits inside `E:/hooks`.
- Codex official docs say multiple matching command hooks for the same event launch concurrently, so dependent hooks must not be separate same-event entries if order matters.
- Codex official docs say trust is recorded against the hook definition hash, not as a proven script-content checksum.
- Codex official docs list `stop_hook_active` on `Stop`; the current quality gate already checks it.

## MCP Memory Context Reflected

The hook system must respond to actual documented drift, not abstract hook theory.

Relevant MCP/vector-memory findings:

- Hook proposals must state, plainly, what each hook does, why it matters for
  Jon's workflow, and which documented failure it addresses.
- Skill theater is prohibited. Naming or listing a skill is not enough; the
  hook system must push or gate toward actual skill invocation and useful
  application.
- Prior coordination turns underused skills and memory because agents treated
  them as optional or invisible. The hook system must make skill and memory use
  visible, routine, and hard to skip on substantive work.
- Governance contracts drifted when agents pre-authored and locked rules. The hook system must keep agents in draft/propose mode and reserve locked rule changes for Jon.
- The old `internal/governance` current-situation TODO is no longer the target shape. The current model is generated Fumadocs contract pages from three governance contracts: Frontend, Backend, Architecture.
- Blockdata and kai-chattr devdocs both require generated contract docs and tab-scoped Fumadocs navigation. Contract JSON edits must trigger contract validation and MDX regeneration.
- Memory tagging drift happened because workers cannot reliably remember to tag records. The forward fix is a write-time hook for memory writes that derives project scope from `cwd`.
- Secret handling drift happened when credentials were pasted into chat. Hooks must block secret-bearing writes and route secrets to SOPS-only workflows.
- Repo-local `.venv` drift happened when `uv` ran without `UV_PROJECT_ENVIRONMENT`. Hooks must block or warn on repo-local virtualenv creation.
- Existing guard scripts are scattered across `E:/writing-system` and related repos. The hook registry is the right consolidation point so guardrails run before writes land, not only at git-time.

Local hook docs add one more important framing: instruction alone is not
enough. `E:/hooks/docs/skill-memory-enforcement-design.md` frames the fix as:

- `PUSH`: `UserPromptSubmit` does memory recall and skill suggestion so the
  agent does not have to remember to do that work manually.
- `GATE`: `PreToolUse` blocks risky writes until required workflow conditions
  have actually happened.

The proposal below uses that framing. Every hook entry says what the hook does,
why it exists for this environment, and whether it is advisory, telemetry, or a
blocking gate.

## OSS References Checked

| Reference | License | Use | Do Not Use |
|---|---:|---|---|
| `lefthook` | MIT | job model: root, glob, exclude, grouped/parallel commands, timeout, fail text, schema | Go runtime |
| `pre-commit` | MIT-style | config validation, manifest validation, clear failure messages | Python environment installer model |
| `clyro` | Apache-2.0 | loop detection, state hash, local policy shape, fail-open details | cloud sync, cost platform |
| `claude-hooks` | MIT | shell command decomposition for compound Bash | Claude permission format as-is |
| `eyelet` | MIT | doctor command, hook logging, hook test harness ideas | dashboard/UI scope |
| `agentihooks` | MIT | one-handler lifecycle routing, guardrail pipeline, retry breaker concepts | full profile/fleet system |
| `opa` | Apache-2.0 | future policy engine reference | Rego dependency in v1 |
| `codex-cli-hooks` | no LICENSE found | Codex hook wire-format examples only | code lifting until license is clarified |

## Architecture

Use a single cohesive control plane:

```text
Codex / Claude hook config
  -> event entrypoint
  -> lib/hook-runtime.mjs
  -> lib/dispatcher.mjs
  -> event modules
  -> config.json + referenced manifests
  -> .state/
```

## Hook Responsibility Matrix

| Hook | What It Does | Why It Matters For Us | Authority |
|---|---|---|---|
| `SessionStart` | Loads workspace/canon status once at session start, verifies core paths, and can warn if hooks/config are unhealthy. | Prevents agents starting cold or using stale project assumptions. Useful for Fumadocs/governance current-state reminders without injecting a huge payload every turn. | Advisory |
| `UserPromptSubmit` | Keeps `inject-protocol`: A-E protocol, memory recall, skill suggestions, project detection, and lightweight user-approval capture. | This is the attention/context hook. It addresses documented failures where agents skipped skills, missed memory context, or forgot current repo rules. | Advisory, narrow prompt block only |
| `PreToolUse` | Blocks dangerous actions before they land: protected governance writes, `E:/hooks/**` edits without approval, secret-bearing writes, repo-local `.venv`, dependency drift, destructive shell subcommands, and memory writes missing project tags. | This is the prevention hook. It turns repeated documented mistakes into deterministic guardrails before files, secrets, or memory records are polluted. | Hard gate |
| `PermissionRequest` | Decides approval-flow cases such as escalated shell/network actions, only when Codex is about to ask for permission. | This keeps operator approval semantics separate from baseline safety. It can allow/deny escalations without bloating PreToolUse. | Approval bridge |
| `PostToolUse` | Records structured telemetry, command failures, changed-file hints, regeneration prompts, and repeated-failure signatures after a supported tool runs. | This creates evidence for debugging and Stop decisions without pretending post-execution telemetry proves completion. It also supports future doctor/status views. | Observation |
| `Stop` | Computes dirty files, maps them to declared domains/jobs, runs deterministic verification commands, checks generated docs/contracts, and blocks completion only on fresh failing evidence. | This is the completion gate. It stops "claiming done" when Fumadocs, contracts, dependency gates, builds, or tests are out of sync. | Hard gate with loop breaker |
| `PreCompact` | Captures a short state summary before compaction and warns if active gate failures would be lost. | Prevents compaction from erasing the reason a hook or migration lane is blocked. | Advisory |
| `PostCompact` | Re-injects only the minimal post-compaction operating context if needed. | Keeps long-running migrations coherent without repeating the full protocol each turn. | Advisory |

### Runtime Files

- `lib/hook-runtime.mjs`
  - load config
  - validate schema
  - parse stdin
  - normalize event names
  - expose output helpers for Codex and Claude
  - enforce per-hook timeout budget
  - write structured logs
  - provide loop/approval state helpers

- `lib/dispatcher.mjs`
  - route one event to ordered modules
  - run modules in declared order
  - stop on deny/block
  - merge advisory context deterministically
  - keep event-specific output shape correct

- `lib/job-runner.mjs`
  - Lefthook-inspired bounded parallel execution
  - total budget below Codex hook timeout
  - per-job timeout
  - child process cleanup
  - output tailing with high buffer or file-backed capture
  - no `execSync` for multi-job gates

- `lib/shell-command-parser.mjs`
  - borrow/adapt `claude-hooks` command decomposition
  - split `&&`, `||`, `;`, pipes, newlines, subshells
  - strip heredocs and redirections before policy checks
  - validate every sub-command

## Config Decision

Keep JSON.

Reason:

- Codex and Node can consume it without new runtime dependencies.
- The current system already centralizes most settings there.
- Lefthook and pre-commit prove the important upgrade is schema validation and clear manifest semantics, not YAML itself.
- OPA/Rego is too much for the current policy complexity.

Required changes:

- Add `E:/hooks/config.schema.json`.
- Add `E:/hooks/scripts/validate-runtime-hooks.mjs`.
- Make config parse failures loud in validation and fail according to each hook's declared policy at runtime.
- Remove stale compatibility assumptions from `inject-protocol`.
- Treat every extra policy/manifest file as a declared child of `config.json`, not a hidden second source of truth.

Recommended config shape:

```json
{
  "version": 3,
  "shared": {
    "paths": {},
    "runtime": {
      "totalStopBudgetMs": 150000,
      "defaultJobTimeoutMs": 60000,
      "maxBufferBytes": 10485760
    }
  },
  "events": {
    "UserPromptSubmit": {
      "entrypoint": "inject-protocol/inject-protocol.mjs",
      "modules": ["protocol", "memory-recall", "skill-suggest"],
      "failPolicy": "open"
    },
    "PreToolUse": {
      "entrypoint": "governance-gate/gov-gate.mjs",
      "modules": ["protected-paths", "shell-policy", "dependency-policy", "secrets-write"],
      "failPolicy": "closed"
    },
    "Stop": {
      "entrypoint": "quality-completion-gate/quality-completion-gate.mjs",
      "modules": ["quality-jobs"],
      "failPolicy": "open-after-loop-threshold"
    }
  },
  "manifests": {
    "qualityJobs": "quality-completion-gate/quality-verify-manifest.json"
  }
}
```

## Hook Lifecycle

### 1. UserPromptSubmit: Keep And Harden

Keep `inject-protocol`.

It remains the advisory/context hook:

- inject A-E protocol
- recall memory
- suggest skills
- detect project scope
- optionally capture user approval phrases for later gates

Do not turn this hook into a hard gate except for narrow prompt-blocking cases.

### 2. PreToolUse: Build Governance Gate

Build `governance-gate/gov-gate.mjs`.

It must protect:

- `E:/hooks/**`
- clean repo `governance/**`
- dependency surfaces
- secret-bearing writes
- destructive shell commands

Policy:

- deny before execution
- use official Codex `hookSpecificOutput.permissionDecision = "deny"` where supported
- use old `decision: "block"` only as compatibility fallback
- parse compound Bash before matching
- never rely on whole-command string matching

### 3. PermissionRequest: Add Later If Needed

Use only for approval-flow decisions:

- escalated shell commands
- network-sensitive operations
- persistent permission requests

Do not put baseline governance here; it runs only when Codex is about to ask for permission.

### 4. PostToolUse: Telemetry Only

Use PostToolUse for observation:

- structured log
- command result capture
- repeated-failure signal
- file-read dedup signal

Do not make PostToolUse an authority for quality completion. It cannot undo side effects and is not a reliable completion gate.

### 5. Stop: Deterministic Completion Gate

Keep `quality-completion-gate`, but replace the synchronous runner.

Required behavior:

- read `stop_hook_active`
- compute dirty files
- map files to declared domains
- run only declared jobs
- gate only on exit codes
- run independent jobs with bounded parallelism
- stay under `timeout = 180` in Codex config
- tail output on failure
- avoid infinite continuations with a state hash threshold

## Quality Job Manifest

Upgrade `quality-verify-manifest.json` to a job model inspired by Lefthook.

Each job must have:

- `id`
- `label`
- `cwd`
- `run`
- `timeoutMs`
- `maxBufferBytes`
- `failText`
- `domains`
- `paths`
- `parallelGroup`

Each repo must declare:

- `root`
- `blockOnUnmatched`
- `unmatchedAllowlist`
- `domains`
- `jobs`

Current `blockOnUnmatched: false` is acceptable only during bootstrap. It must become explicit per repo with an allowlist and review output.

## Loop Safety

Use both Codex-native and local loop guards.

Required:

- If `input.stop_hook_active === true`, return `continue: true` with a system message.
- Hash the block signature:
  - repo root
  - touched domains
  - changed file list
  - failing job IDs
  - failure exit codes
- Store the signature in `E:/hooks/.state/quality-gate/`.
- If the same signature blocks more than the configured threshold, stop blocking and emit an explicit system message.

This borrows Clyro's state-hash idea, but keeps implementation small and local.

## Verification Harness

Build `scripts/test-hook.mjs` before enabling new gates.

Minimum cases:

- `UserPromptSubmit` injects context and exits valid JSON/plaintext per event contract.
- `PreToolUse` denies protected path writes.
- `PreToolUse` decomposes compound Bash and catches a denied sub-command.
- `Stop` passes clean repo.
- `Stop` blocks dirty repo with failing job.
- `Stop` does not re-block when `stop_hook_active` is true.
- `Stop` loop threshold releases repeated identical failure.
- `validate-runtime-hooks.mjs` fails if config schema, manifest schema, script paths, or command fields are invalid.

Borrow from Eyelet's doctor/testing shape and pre-commit's validation stance.

## Implementation Order

1. Create schema + validator.
   - `config.schema.json`
   - `quality-completion-gate/quality-verify-manifest.schema.json`
   - `scripts/validate-runtime-hooks.mjs`

2. Extract shared runtime.
   - `lib/hook-runtime.mjs`
   - event output helpers
   - config loader
   - state helpers

3. Add test harness.
   - `scripts/test-hook.mjs`
   - fixture payloads for Codex events

4. Upgrade Stop runner.
   - async child process execution
   - bounded concurrency
   - total budget
   - 10MB/file-backed output capture
   - loop signature state

5. Build governance gate.
   - protected path checks
   - Bash decomposition
   - dependency policy
   - secret-write checks

6. Clean inject-protocol.
   - remove stale config comments/defaults
   - read `shared.projects[]`
   - make config mismatch visible in self-test

7. Wire config with one active command per event.
   - avoid multiple same-event hooks that need ordering
   - keep Codex and Claude hook configs thin

## Acceptance Criteria

- `node E:/hooks/scripts/validate-runtime-hooks.mjs` passes.
- `node E:/hooks/scripts/test-hook.mjs --all` passes.
- `node E:/hooks/inject-protocol/inject-protocol.mjs --self-test` passes.
- `node E:/hooks/quality-completion-gate/quality-completion-gate.mjs --self-test` passes.
- A protected write to `E:/hooks/config.json` is denied without explicit user approval.
- A governance contract edit triggers contract validation and generated Fumadocs/MDX validation.
- A memory write without a project tag is auto-tagged from `cwd` or blocked for missing scope.
- A compound Bash command with a denied sub-command is denied.
- A repo-local `.venv` creation attempt is blocked or produces a hard gate failure before completion.
- A Stop continuation with `stop_hook_active: true` does not re-block.
- Dirty `E:/blockdata` and `E:/kai-chattr` docs/governance changes map to the correct jobs.

## Open Decisions For Jon

- Whether `quality-verify-manifest.json` remains a child manifest or folds into `config.json`.
- Whether `E:/hooks` should become a git repo or stay protected by governance gate + tests only.
- Whether `blockOnUnmatched` should flip to true immediately after allowlists are written.
- Whether to add `PermissionRequest` in v1 or keep it out until PreToolUse and Stop are stable.

## Final Position

The right direction is not "adopt an OSS hook framework."

The right direction is to keep the existing hook pillars, formalize them around a validated JSON control plane, borrow specific proven mechanisms from the references, and make one cohesive runtime where each event has a clear authority level:

- `UserPromptSubmit`: context
- `PreToolUse`: prevention
- `PermissionRequest`: approval bridge
- `PostToolUse`: telemetry
- `Stop`: deterministic completion gate
