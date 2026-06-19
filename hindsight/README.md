# Hindsight Startup Owner

This folder owns local recovery for the native Hindsight MCP API used by MCP Router.

## Contract

- Hindsight API must listen on `http://127.0.0.1:10003`.
- MCP Router points to `http://127.0.0.1:10003/mcp/collective/`.
- Required MCP tools are `recall`, `list_memories`, `reflect`, and `sync_retain`.
- Provider secrets stay in SOPS. Do not write decrypted keys into this repo, task arguments, logs, or chat.

## Files

- `ensure-hindsight.ps1` checks the MCP endpoint, starts Hindsight through SOPS when needed, and waits for the required tools.
- `verify-hindsight.ps1` performs a Streamable HTTP MCP initialize plus `tools/list` check.
- `install-startup-task.ps1` registers the current-user Windows scheduled task `JWC-Hindsight-10003`.

## Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\install-startup-task.ps1
```

The task runs at user logon. It uses:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\ensure-hindsight.ps1
```

## Manual Recovery

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\ensure-hindsight.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\verify-hindsight.ps1
```

## Secret Source

`ensure-hindsight.ps1` uses `sops exec-env` against:

```text
E:\writing-system\secrets\dev\llm-providers.yaml
```

The script does not print secret values. In this local hooks setup, Hindsight's
default LLM and retain LLM are both forced to the same **Codex Spark** proxy as
`memory-harvester` (`http://127.0.0.1:8787/v1`, model
`gpt-5.3-codex-spark`, reasoning effort `medium`).

- Config source: `hooks[id=memory-harvester].settings.hindsight.retainLlm` in
  `config.json`.
- `ensure-hindsight.ps1` ensures the Codex proxy is up before starting Hindsight.
- Stale SOPS/OpenAI/Mistral Hindsight LLM env is overwritten at process start.
- Mistral is not used for retain in this local hooks setup.

After changing SOPS LLM settings, restart the service:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\ensure-hindsight.ps1 -ForceRestart
```

To verify the retain LLM path, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\hindsight\verify-hindsight.ps1 -RetainSmoke
```

## Logs

Hindsight process logs are timestamped under:

```text
%LOCALAPPDATA%\hindsight-native
```
