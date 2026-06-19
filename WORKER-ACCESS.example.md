# WORKER-ACCESS.example.md - hooks

Status: active
Owner: Jon
Last reviewed: 2026-06-19
Applies to: local worker access template
Canonical source: yes for shape only; real machine state belongs in gitignored `WORKER-ACCESS.md`

Copy this file to `WORKER-ACCESS.md` in a local checkout.

Do not commit `WORKER-ACCESS.md`.
Do not place plaintext secrets in either file.

## Purpose

`WORKER-ACCESS.md` tells local agents and workers what this machine can already
do for the hooks control plane before anyone asks Jon for help.

The committed example documents safe command shapes only. The real local file
may record whether a system is provisioned on this machine, but it must still
avoid secret values, raw tokens, private keys, or decrypted file contents.

## Access Status

| System | Status | How to verify | Notes |
| --- | --- | --- | --- |
| Node | provisioned / not provisioned | `node --version` | Required for `.mjs` hooks and tests. |
| Python | provisioned / not provisioned | `python --version` | Required for Python hooks and tests. |
| Git | provisioned / not provisioned | `git --version` | Required for diff-based Stop gates. |
| SOPS | provisioned / not provisioned | `sops --version` | Needed for Hindsight and other secret-backed service commands. |
| Codex auth | provisioned / not provisioned | `Test-Path $env:USERPROFILE\\.codex\\auth.json` | Needed for the local Codex proxy. Do not print file contents. |
| Hindsight service | provisioned / not provisioned | `powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\verify-hindsight.ps1` | Uses local MCP HTTP endpoint on `127.0.0.1:10003`. |
| Codex proxy | provisioned / not provisioned | `powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\verify-codex-proxy.ps1` | Used by `memory-harvester` LLM extraction. |
| Scheduled tasks | provisioned / not provisioned | `Get-ScheduledTask -TaskName JWC-Hindsight-10003,JWC-Codex-Proxy-8787` | Optional convenience recovery at user logon. |
| Memory DB access | provisioned / not provisioned | `python E:\hooks\memory-harvester\test-harvest-readonly.py` | Read-only check against the memory runtime. |

## Command Patterns

### Runtime Validation

```powershell
node E:\hooks\_core\validate-runtime-hooks.mjs
```

### Hindsight Recovery

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\ensure-hindsight.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\verify-hindsight.ps1
```

### Codex Proxy Recovery

```powershell
powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\ensure-codex-proxy.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\verify-codex-proxy.ps1
```

### Harvester LLM Smoke

```powershell
python E:\hooks\memory-harvester\test-live-llm-once.py
```

### Read-Only Memory Checks

```powershell
python E:\hooks\memory-harvester\test-harvest-readonly.py
python E:\hooks\memory-harvester\test-harvest-hindsight-readonly.py
python E:\hooks\memory-harvester\test-harvest-llm-readonly.py
```

### Hindsight Backfill Dry-Run

```powershell
python E:\hooks\memory-sync\backfill-sqlite-to-hindsight.py --dry-run --limit 5
```

### SOPS-Backed Provider Access

```powershell
sops exec-env E:\writing-system\secrets\dev\llm-providers.yaml "<command needing provider env>"
```

## Do Not Ask Jon For

- Secret values or decrypted copies of secret files.
- Manual service start or restart when `ensure-*.ps1` scripts already exist.
- Re-authentication when local access is already provisioned.
- Routine status checks that the verify scripts already cover.
- A workaround that commits local-only machine notes into the repo.

## Ask Jon Only For

- New provider grants, account-owner actions, or missing encrypted secret files.
- A missing or broken `%USERPROFILE%\.codex\auth.json` that local recovery cannot fix.
- Machine policy blocks around scheduled tasks, localhost listeners, or PowerShell execution that require administrator or policy changes.
- Approval for destructive operations against shared memory stores or other repos.

## Safety Rules

- Never print or paste secret values into chat, logs, or repo files.
- Never commit `WORKER-ACCESS.md`.
- Prefer `sops exec-env` command shapes over manual secret export.
- Treat `%USERPROFILE%\.codex\auth.json` as sensitive local state.
- Redact tokens, private URLs, machine identifiers, and account details from any shared output unless Jon explicitly says they are public.
