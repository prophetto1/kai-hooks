# Codex subscription proxy (Spark harvester LLM)

Keeps a local OpenAI-compatible proxy running for `memory-harvester` when
`config.json` uses `settings.extraction.mode=llm`.

## Contract

- Proxy listens on `http://127.0.0.1:8787/v1`
- Auth comes from Codex subscription OAuth: `%USERPROFILE%\.codex\auth.json`
- Harvester model default: `gpt-5.3-codex-spark` (see `hooks[id=memory-harvester]` in `config.json`)

## How it stays up (no intrusive polling)

| When | What happens |
|------|----------------|
| **User logon** | Hidden scheduled task starts the proxy once (`JWC-Codex-Proxy-8787`) |
| **Session Stop** | Harvester health-checks the proxy; if down, runs ensure script silently (`autoEnsureProxy`) |
| **Manual** | Run ensure/verify scripts below |

There is **no periodic watchdog task**. Recovery is on-demand so nothing flashes a console every few minutes.

## Install (once)

```powershell
powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\install-startup-task.ps1 -RunNow
```

Re-running install removes the legacy `JWC-Codex-Proxy-8787-Watchdog` task if it exists.

## Manual recovery

```powershell
powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\ensure-codex-proxy.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File E:\hooks\codex-proxy\verify-codex-proxy.ps1
python E:\hooks\memory-harvester\test-live-llm-once.py
```

## Logs

```text
%LOCALAPPDATA%\JWC\codex-proxy\ensure.log
%LOCALAPPDATA%\JWC\codex-proxy\proxy.stdout.log
%LOCALAPPDATA%\JWC\codex-proxy\proxy.stderr.log
%LOCALAPPDATA%\JWC\codex-proxy\startup-task.log
```

## Tune harvester model / reasoning

Edit `E:/hooks/config.json` → `hooks` → `memory-harvester` → `settings.extraction.llm`
(`model`, `reasoningEffort`, `temperature`, prompts, etc.).
