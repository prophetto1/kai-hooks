# AGENTS.md - hooks

Status: active
Owner: Jon
Last reviewed: 2026-06-19
Applies to: whole repository
Canonical source: yes

## Start Here

1. Read this file for the operating contract.
2. Read `README.md` for the subsystem map and repo ownership.
3. Read `STACK.md` for runtime, service, and verification expectations.
4. Read `changelog-hooks.md` for the latest repo-level decisions.
5. Read `config.json` before changing hook wiring, thresholds, models, paths, or enabled state.
6. Read `skills-catalog.md` before changing task-mode or planning behavior.
7. Read local `WORKER-ACCESS.md` if it exists and you need machine-specific service access or recovery steps.

## Repository Contract

| Topic | Canonical source | Notes |
| --- | --- | --- |
| Hook tunables and runtime wiring | `config.json` | Single source of truth for paths, hook settings, stop-chain order, models, and enabled state. |
| Config/schema model | `_core/config-model.mjs` | The schema model is hand-maintained here. |
| Generated schema | `config.schema.json` | Derived output only. Regenerate after model changes. |
| Runtime validation | `_core/validate-runtime-hooks.mjs` | Verifies config, generated schema, and runtime hook wiring. |
| Stop-gate verify coverage | `quality-completion-gate/quality-verify-manifest.json` | New files and directories must map to a declared verify domain or Stop will block completion. |
| Task-mode skill routing | `skills-catalog.md` | `task-mode-gate` and `planning-start-gate` point here. |
| Hindsight recovery | `hindsight/README.md` | Local MCP service contract and recovery commands. |
| Hindsight backfill utilities | `memory-sync/` | Manual SQLite-to-Hindsight migration helpers, not runtime hooks. |
| Codex proxy recovery | `codex-proxy/README.md` | Local OpenAI-compatible proxy for `memory-harvester`. |
| Repo changelog | `changelog-hooks.md` | Update before claiming repo work is complete. |

## Commands

| Task | Command |
| --- | --- |
| Validate runtime wiring | `node _core/validate-runtime-hooks.mjs` |
| Regenerate schema | `node _core/generate-config-schema.mjs` |
| Config-model tests | `node quality-completion-gate/test-config-model.mjs` |
| Quality-gate core tests | `node quality-completion-gate/test-quality-gate-core.mjs` |
| Inject-protocol core tests | `node inject-protocol/test-inject-protocol-core.mjs` |
| Task-mode tests | `node task-mode/test-task-mode-core.mjs` |
| Agent-diff gate tests | `node agent-diff-completion-gate/test-agent-diff-completion-gate.mjs` |
| Read-only memory checks | `python memory-harvester/test-harvest-readonly.py` |
| Backfill dry-run | `python memory-sync/backfill-sqlite-to-hindsight.py --dry-run --limit 5` |
| Verify Hindsight service | `powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\verify-hindsight.ps1` |
| Verify Codex proxy | `powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\verify-codex-proxy.ps1` |

Use the smallest relevant check first, then broaden when the touched area warrants it.

## Non-Negotiables

- Treat `config.json` as the live control plane. Do not hide tunables in code when they belong in config.
- When `_core/config-model.mjs` changes, regenerate `config.schema.json` and run the runtime validator.
- When you add a root file or directory, update `quality-completion-gate/quality-verify-manifest.json` so Stop can classify it.
- Keep secrets out of this repo. Use SOPS-backed commands, local auth files, and gitignored `WORKER-ACCESS.md` notes instead.
- Do not clean or revert unrelated dirty-worktree changes unless Jon explicitly asks.
- Update `changelog-hooks.md` for repo changes before you call the task complete.

## Verification Before Completion

- Run `git diff --check -- <touched files>` for whitespace and patch hygiene.
- Run the narrowest relevant tests for the edited subsystem.
- If config or stop wiring changed, run `node _core/validate-runtime-hooks.mjs`.
- If the verify manifest changed, run the quality-gate tests or another targeted manifest check.
- If service helper scripts changed, run the corresponding `verify-*.ps1` script when possible or say why you could not.
