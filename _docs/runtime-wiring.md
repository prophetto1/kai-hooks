# Runtime wiring — hook stack

Full stack: **inject → task-mode → telemetry → planning → thinking → loop-safety → Stop chain**.

See `_docs/task-mode-and-skills.md` for mode/skill map.

## Telemetry (required substrate)

Every runtime must log tool events:

```text
python E:/hooks/hook-telemetry/log-event.py
```

On `PostToolUse` and `PostToolUseFailure`. Without this, task-mode, thinking-gate, planning-start-gate, loop-safety, browser-verify, and agent-diff gates cannot detect skill usage.

## UserPromptSubmit (start)

1. `inject-protocol/inject-protocol.mjs` — protocol + memory + skill suggest
2. `task-mode/task-mode-gate.mjs` — classify mode, inject required skills

## PreToolUse (during)

1. `task-mode/planning-start-gate.mjs` — mode checkpoint before mutators
2. `thinking-gate/thinking-gate.py` — sequential-thinking grant (read-only + browser MCP tools exempt)
3. `loop-safety/loop-guard.py` — retry breaker

Browser MCP (`browser_navigate`, `browser_snapshot`, etc.) is exempt from thinking-gate — it verifies live localhost UI and must not be blocked mid-session.

Do not run `pnpm run dev` / `verify-runtime.mjs` while the user already has dev servers on 8800/8840 — that restarts or conflicts with active browser sessions.

## Stop (exit)

```text
node E:/hooks/stop-completion-chain/stop-completion-chain.mjs
```

Runs: quality-completion-gate → agent-diff-completion-gate (LOC tiers) → browser-verify-gate

Verification for kai-chattr web changes must use `scripts/dev/ui-snapshot-live.mjs` (real API via Vite proxy).
Mocked scripts (`ui-snapshot.mjs`, `ui-snapshot-route.mjs`) are dev smoke only — Stop gates reject runs without `run.json liveApi: true`.
**Verification fraud** (mocked intercepts, citing non-live PNGs as proof) blocks Stop and records session fraud strikes; see `quality-completion-gate/verification-integrity.mjs`.

The runtime validator checks live Codex and Cursor wiring for stale Stop hooks. Managed Stop
entries must route through `stop-completion-chain`; direct per-gate Stop commands are invalid.
For Codex, keep the outer Stop timeout at least 60s above the chain step timeout.
For Cursor, user-level and project-level Stop hooks are not additive-safe. If user-level Cursor
Stop is wired, project `.cursor/hooks.json` files must not also define managed Stop hooks.
The quality gate is single-flight per repo. If two runtimes fire Stop at the same time, the first
gate owns the manifest command run and the second exits quietly with `continue: true` instead of
launching duplicate tests or forcing a repeated "already running" Stop prompt.

## Codex

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node E:/hooks/inject-protocol/inject-protocol.mjs"
timeout = 10

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node E:/hooks/task-mode/task-mode-gate.mjs"
timeout = 10

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "node E:/hooks/task-mode/planning-start-gate.mjs"
timeout = 10

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "python E:/hooks/thinking-gate/thinking-gate.py"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node E:/hooks/stop-completion-chain/stop-completion-chain.mjs"
timeout = 360
statusMessage = "Running completion gates"
```

## Claude Code

Add to `hooks` in `~/.claude/settings.json`:

```json
"UserPromptSubmit": [
  { "hooks": [{ "type": "command", "command": "node E:/hooks/inject-protocol/inject-protocol.mjs" }] },
  { "hooks": [{ "type": "command", "command": "node E:/hooks/task-mode/task-mode-gate.mjs" }] }
],
"PreToolUse": [
  { "matcher": "*", "hooks": [{ "type": "command", "command": "node E:/hooks/task-mode/planning-start-gate.mjs" }] },
  { "matcher": "*", "hooks": [{ "type": "command", "command": "python E:/hooks/thinking-gate/thinking-gate.py" }] }
]
```

(Keep existing telemetry, loop-safety, Stop chain entries.)

## Cursor

Use `examples/cursor/hooks.full-stack.fragment.json` — merge into `~/.cursor/hooks.json`.
Cursor Stop must contain exactly one command routed through `stop-completion-chain`; do not wire
Stop directly to the per-gate scripts.

## Validate

```bash
node E:/hooks/_core/validate-runtime-hooks.mjs
node E:/hooks/task-mode/test-task-mode-core.mjs
node E:/hooks/task-mode/task-mode-gate.mjs --self-test
python E:/hooks/thinking-gate/test-thinking-gate.py
```
