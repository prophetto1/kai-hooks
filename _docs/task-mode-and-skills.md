# Task mode and skills — start / during / stop

Canonical map for the three-layer hook system. All gates depend on **hook-telemetry** (`PostToolUse` → `hook_events`).

## Task modes

Set explicitly (`mode: implement` or `/implement`) or inferred from prompt keywords.

| Mode | Intent | Inferred when |
|------|--------|----------------|
| `explore` | Read, explain, investigate | how, explain, what is, review (read-only sense) |
| `implement` | New feature / substantial build | implement, build, add, create, wire up |
| `fix` | Bug, failure, regression | fix, bug, broken, failing, debug, error |
| `refactor` | Restructure without behavior change | refactor, restructure, clean up, extract |
| `review` | Code review, PR feedback, cold review | review this, code review, PR comments, blind review |
| `docs` | Documentation-only | docs only, changelog, README, no code |

## Skills by phase (expanded)

### START — before mutating tools (`task-mode-gate` + `planning-start-gate`)

| Mode | Load one of (planning checkpoint) | Also useful |
|------|-----------------------------------|-------------|
| `explore` | *(none required)* | `environment-discovery`, `initiating-a-new-task` |
| `implement` | `brainstorming`, `waza-think`, `investigating-and-writing-plan-v2`, `initiating-a-new-task` | `test-driven-development`, `writing-plans` |
| `fix` | `waza-hunt`, `systematic-debugging` | `comprehensive-systematic-debugging`, `debug` |
| `refactor` | `refactor`, `investigating-and-writing-plan-v2`, `waza-think` | `code-review`, `testing-strategy` |
| `review` | `code-review`, `receiving-code-review`, `blind-implementation-review` | `requesting-code-review`, `review-bugbot` |
| `docs` | *(none required)* | `writing-clearly-and-concisely`, `documentation` |

**Checkpoint rule:** Before `Write` / `Edit` / `Shell` (mutating) / `apply_patch`, agent must show **one** planning checkpoint:

- Sequential-thinking MCP call (active grant), **or**
- Read/follow a required skill for the current mode (logged in telemetry)

Read-only tools (`Read`, `Grep`, `Glob`, `SemanticSearch`, `WebSearch`, `WebFetch`) never consume planning grants.

### DURING — while editing

| Situation | Skills |
|-----------|--------|
| Implement with tests first | `test-driven-development` |
| Executing approved plan | `executing-approved-plans`, `subagent-driven-development` |
| Fix in progress | `waza-hunt` (diagnose before patch) |
| Refactor in progress | `refactor`, `performant-code` |
| Acting on review comments | `receiving-code-review` |
| Large diff hygiene | `waza-check` |

### STOP — after diff exists (`agent-diff-completion-gate` + `quality-completion-gate`)

| LOC (in-scope) | Required |
|----------------|----------|
| Any operational diff | `verification-before-completion` |
| 501+ LOC | + `waza-hunt` (post-implementation sweep) |
| Quality manifest | Domain tests from `quality-verify-manifest.json` |

| Optional / merge gate | Skills |
|-----------------------|--------|
| Before merge | `waza-check`, `blind-implementation-review`, `requesting-code-review` |
| After review feedback landed | `receiving-code-review` then re-verify |

## Hook stack (must run together)

```text
UserPromptSubmit
  inject-protocol          → protocol + memory + skill suggest
  task-mode-gate           → classify mode, inject required skills

PreToolUse
  planning-start-gate      → mode checkpoint before mutators
  thinking-gate            → sequential-thinking grant (mutators only; reads exempt)
  loop-safety              → retry breaker

PostToolUse / PostToolUseFailure
  hook-telemetry           → REQUIRED substrate for all gates above

Stop
  stop-completion-chain    → quality → agent-diff → browser-verify
```

## Explicit mode tags (recommended)

```text
mode: implement
Add settings appearance manifest editor
```

```text
/refactor Extract rail spec into shared module
```

Without a tag, keywords in the prompt are used; explicit tags win.

## Wiring

See `_docs/runtime-wiring.md` and `examples/cursor/hooks.full-stack.fragment.json`.
