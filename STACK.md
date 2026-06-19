# STACK.md - hooks

Status: active
Owner: Jon
Last reviewed: 2026-06-19
Applies to: runtime, dependency, local-service, and verification work

`hooks` is a script-first control-plane repo. It is not a single app with one
build pipeline. The active stack is the combination of Node, Python, PowerShell,
SQLite, Git-based diff inspection, and a few local helper services.

## Stack Summary

| Layer | Current stack |
| --- | --- |
| Hook runtime | Node `.mjs` scripts plus Python `.py` scripts selected by `config.json` |
| Config authority | `config.json` with `_core/config-model.mjs` as the validation/model source |
| Schema output | Generated `config.schema.json` |
| Local state | SQLite in `E:/hooks/_db/hooks.db` plus `.state/` directories |
| Memory integration | SQLite memory DB at `E:/_memory/memory-sqlite.db` plus optional Hindsight sync |
| Migration utilities | `memory-sync/` backfill scripts for SQLite-to-Hindsight document migration |
| Local service helpers | PowerShell scripts in `hindsight/` and `codex-proxy/` |
| Stop gating | `stop-completion-chain/`, `quality-completion-gate/`, `agent-diff-completion-gate/` |
| Supported workspaces | `blockdata`, `kai-chattr`, `kai`, `writing-system`, `chattr`, `jwc-global`, `dbase` |
| Runtime adapters | Codex and Claude stop-chain wiring, plus `adapters/cursor/` support |

## Runtime Requirements

- Node must be available on `PATH` for the `.mjs` hooks and tests.
- Python must be available on `PATH` as `python` for the Python hooks and tests.
- PowerShell is required for Windows helper scripts and scheduled-task flows.
- Git is required because the completion gates inspect repository diffs directly.
- SOPS is required for Hindsight and other secret-backed local service recovery.
- Keep Windows-style absolute paths stable in config unless the repo is being
  intentionally migrated. This repo is currently authored around `E:/...` paths.

## Package And Dependency Policy

- This repo is script-first and currently has no root package-manager manifest
  or lockfile acting as the single dependency authority.
- Do not invent ad hoc install instructions in random files. If a new runtime or
  dependency becomes required, document the install source and verification path
  here and in the relevant subsystem README.
- `config.schema.json` is generated output. Do not hand-edit it as the primary
  source.
- Keep third-party operational dependencies explicit: local auth files, SOPS,
  scheduled tasks, and localhost services should be documented instead of
  assumed.

## Local Services And State

| Resource | Location / endpoint | Verification |
| --- | --- | --- |
| Hooks DB | `E:/hooks/_db/hooks.db` | Read-only hook/runtime tests |
| Memory DB | `E:/_memory/memory-sqlite.db` | Memory readonly tests |
| Hindsight MCP API | `http://127.0.0.1:10003/mcp/collective/` | `powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\verify-hindsight.ps1` |
| Codex proxy API | `http://127.0.0.1:8787/v1` | `powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\verify-codex-proxy.ps1` |
| Hook runtime scratch | `E:/hooks/.state/` | Inspect only when debugging runtime state |

`memory-harvester` defaults to LLM extraction through the local Codex proxy and
falls back to heuristics when the proxy is unavailable. The Stop hook fires
after every assistant response, but `runAfterNewExchanges` controls extraction
cadence and `reviewLastExchanges` controls the review window. Hindsight sync is
fail-open when enabled; current local config keeps it off until backfill is
intentionally ready.

## Build And Verification Gates

Use the smallest relevant check first, then widen only when the touched area
requires it.

| Change type | Typical checks |
| --- | --- |
| Root docs only | `git diff --check -- <files>` and verify-manifest coverage if you add new root paths |
| Config or hook wiring | `node _core/validate-runtime-hooks.mjs` |
| Config model / schema | `node quality-completion-gate/test-config-model.mjs` |
| Quality completion gate | `node quality-completion-gate/test-quality-gate-core.mjs` |
| Agent-diff gate | `node agent-diff-completion-gate/test-agent-diff-completion-gate.mjs` |
| Inject protocol | `node inject-protocol/test-inject-protocol-core.mjs` and `node inject-protocol/test-inject-protocol-self-test.mjs` |
| Task-mode / planning gates | `node task-mode/test-task-mode-core.mjs` and gate self-tests |
| Memory runtime | `python memory-normalizer/test-memory-runtime.py` and targeted read-only tests |
| Hindsight backfill utilities | `python memory-sync/backfill-sqlite-to-hindsight.py --dry-run --limit 5` |
| PowerShell helper scripts | Run the corresponding `verify-*.ps1` script when possible |

If Stop blocks on unmatched paths, the missing piece is usually
`quality-completion-gate/quality-verify-manifest.json`, not the hook code that
was just edited.

## Environment Model

- This is a local operator repo, not a deployed product surface.
- Its outputs control local agent behavior across other repos on the machine.
- Most failures here show up as hook misbehavior, blocked Stop completions, or
  helper-service outages in those other repos.
- Changes should be treated as cross-repo infrastructure work even when the edit
  is small.

## Important Stack Decisions

- `config.json` is the single source of truth for hook tunables and stop-chain wiring.
- `stop-completion-chain` is the canonical Stop orchestrator; individual gates
  should not grow their own competing runtime wiring.
- SQLite remains the active memory recall base while Hindsight stays wired for
  synchronized retain and future cutover work.
- `memory-harvester` uses the local Codex subscription proxy by default instead
  of requiring a separate Platform API key.
- The repo is Windows-first today; PowerShell and absolute `E:/...` paths are
  part of the current contract.

## Known Active Gaps

- Dirty worktrees are common. Do not clean unrelated files.
- Verify-manifest coverage must be kept in sync with new root docs and
  directories or Stop will block completion.
- Some optional gates remain disabled until their runtime wiring is explicitly
  enabled and validated.
- Local service access is machine-specific. Keep those notes in gitignored
  `WORKER-ACCESS.md`, not in committed docs.
