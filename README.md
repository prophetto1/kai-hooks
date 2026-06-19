# hooks

`hooks` is the local control-plane repo for agent hook behavior across Jon's
Windows workspaces. It centralizes prompt injection, task-mode guidance,
telemetry, loop safety, stop-time quality gates, memory capture, and the helper
services that those hooks depend on.

## What This Repo Owns

- The shared hook registry and all tunable settings in `config.json`
- The config model and generated schema contract in `_core/`
- Prompt-time injection of protocol, memory recall, and skill suggestions
- Task-mode classification and planning-start enforcement
- Tool-use telemetry and retry/loop protection
- Stop-time completion gating and repo verification manifests
- Stop-time memory harvesting into SQLite on a configured exchange cadence
- Local helper service recovery for Hindsight and the Codex proxy

## Source Of Truth

| Topic | File |
| --- | --- |
| Live hook config | `config.json` |
| Config model | `_core/config-model.mjs` |
| Generated schema | `config.schema.json` |
| Runtime validator | `_core/validate-runtime-hooks.mjs` |
| Stop verify domains | `quality-completion-gate/quality-verify-manifest.json` |
| Skill-routing catalog | `skills-catalog.md` |
| Repo change log | `changelog-hooks.md` |

`config.json` is the authority for enabled hooks, paths, models, thresholds,
and stop-chain order. `config.schema.json` is derived output, not a second
source of truth.

## Hook Flow

| Event | Primary hooks |
| --- | --- |
| `UserPromptSubmit` | `inject-protocol`, `task-mode-gate` |
| `PreToolUse` | `thinking-gate` when enabled, `planning-start-gate`, `loop-safety` |
| `PostToolUse` / `PostToolUseFailure` | `hook-telemetry`, `memory-normalizer` |
| `Stop` | `stop-completion-chain` runs `memory-harvester`, `quality-completion-gate`, then `agent-diff-completion-gate` |

The repo is built around config-driven orchestration. Individual hook scripts
should read the shared runtime plus their own config entry instead of drifting
into hardcoded copies.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `_core/` | Shared runtime loader, config model, and schema/validation utilities |
| `inject-protocol/` | Prompt protocol injection, memory recall, and skill suggestion |
| `task-mode/` | Mode classification and planning-start gate |
| `hook-telemetry/` | Tool event logging into the hooks SQLite store |
| `loop-safety/` | Same-error retry breaker for mutating tools |
| `memory-harvester/` | Stop-time durable-memory extraction with exchange-cadenced SQLite writes |
| `memory-sync/` | Manual SQLite-to-Hindsight backfill and reusable Hindsight MCP client utilities |
| `memory-normalizer/` | PostToolUse normalization for legacy SQLite memory mutations |
| `quality-completion-gate/` | Git-diff to verify-domain mapping and command execution |
| `agent-diff-completion-gate/` | Repo-specific diff-size and live-verification policies |
| `frontend-design-gate/` | Optional stop gate for raw HTML primitives in design-system repos |
| `thinking-gate/` | Optional sequential-thinking grant gate |
| `stop-completion-chain/` | Canonical Stop orchestrator |
| `hindsight/` | Local Hindsight service install/ensure/verify scripts |
| `codex-proxy/` | Local Codex subscription proxy install/ensure/verify scripts |
| `adapters/` | Runtime-specific adapters such as Cursor hook shims |
| `_db/`, `.state/` | Local hook state, telemetry DB, and transient runtime artifacts |

## Local Runtime And State

| Resource | Location / endpoint | Notes |
| --- | --- | --- |
| Hooks telemetry DB | `E:/hooks/_db/hooks.db` | Local SQLite store for hook events and gate state |
| Memory DB | `E:/_memory/memory-sqlite.db` | Recall and harvest store used by `inject-protocol` and `memory-harvester` |
| Hindsight MCP API | `http://127.0.0.1:10003/mcp/collective/` | Recovery owned by `hindsight/` |
| Codex proxy API | `http://127.0.0.1:8787/v1` | Used by `memory-harvester` LLM extraction |
| Skill catalog | `E:/hooks/skills-catalog.md` | Catalog for task-mode and planning guidance |

## Verification

Start with the smallest check that covers the files you touched.

- Runtime/config changes: `node _core/validate-runtime-hooks.mjs`
- Config model or schema changes: `node quality-completion-gate/test-config-model.mjs`
- Quality gate changes: `node quality-completion-gate/test-quality-gate-core.mjs`
- Inject protocol changes: `node inject-protocol/test-inject-protocol-core.mjs`
- Task-mode changes: `node task-mode/test-task-mode-core.mjs`
- Agent-diff gate changes: `node agent-diff-completion-gate/test-agent-diff-completion-gate.mjs`
- Memory readonly checks: `python memory-harvester/test-harvest-readonly.py`
- Service availability: run `hindsight/verify-hindsight.ps1` or `codex-proxy/verify-codex-proxy.ps1`

If you add a new root file or directory, update the hooks verify manifest or the
Stop quality gate will block completion on unmatched paths.

## Operational Notes

- `hindsight/README.md` is the contract for the local Hindsight MCP service.
- `codex-proxy/README.md` is the contract for the local OpenAI-compatible proxy
  used by `memory-harvester`.
- `WORKER-ACCESS.example.md` is the committed template for local-only
  `WORKER-ACCESS.md` notes.
- `changelog-hooks.md` is part of the working contract here. Update it when the
  repo changes.
