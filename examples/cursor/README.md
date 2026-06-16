# Cursor install fragment

Copy into `~/.cursor/hooks.json` (merge with existing hooks).

Requires **hook-telemetry** on `postToolUse` so agent-diff gate can detect verification-before-completion and waza-hunt skill usage.

```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "command": "node E:/hooks/adapters/cursor/run-hook.mjs postToolUse E:/hooks/hook-telemetry/log-event.py"
      }
    ],
    "stop": [
      {
        "command": "node E:/hooks/adapters/cursor/run-hook.mjs stop E:/hooks/stop-completion-chain/stop-completion-chain.mjs",
        "loop_limit": 8
      }
    ]
  }
}
```

Do not wire Stop directly to `quality-completion-gate`, `agent-diff-completion-gate`, or
`browser-verify-gate`. Stop must go through `stop-completion-chain` so completion gates run once,
in order, with one shared loop policy.

Restart Cursor after editing hooks.
