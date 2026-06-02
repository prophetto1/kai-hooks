# Decision Memo: Temporary Sequential-Thinking Gate Cleanup

## Decision

Use a bounded matched-tool grant.

A successful configured sequential-thinking checkpoint grants a fixed number of subsequent matched tool calls. The temporary approved setting is:

```json
{
  "grantPolicy": {
    "mode": "bounded_tool_count",
    "maxToolUses": 2
  }
}
```

This is intentionally one policy knob. Changing enforcement from one tool call to two, five, or another count must require changing only `maxToolUses`.

## Problem

The original gate was too disruptive because one sequential-thinking event authorized only one tool call. That created a mechanical "think before every tool" toll during normal investigation and implementation.

The cleanup goal is narrower than a full phase-transition detector:

- keep sequential-thinking enforcement active;
- make one checkpoint cover a small coherent batch;
- avoid defining read/write tool classes;
- avoid read-only free lanes;
- avoid making an agent-authored taxonomy part of authorization.

## Current Mechanism

Source of truth:

- `E:/hooks/config.json`
- `E:/hooks/thinking-gate/thinking-gate.py`

The hook remains a `PreToolUse` gate with:

```json
{
  "match": { "tools": ["*"] }
}
```

The runtime exempts only:

- configured sequential-thinking tools, so the gate cannot deadlock the required checkpoint;
- configured bootstrap lookup tools, so an agent can discover the sequential-thinking tool.

Every other matched tool call consumes one grant use.

## Rejected Cleanup Path

Do not use `toolClasses`.

Do not define categories such as:

- `readOnly`
- `directWrite`
- `shell`
- `memoryWrite`
- `contextReadOnly`
- `contextState`
- `contextExecution`

Do not use `readOnlyShellPrefixes`.

Do not use policy keys such as:

- `consumeReadOnly`
- `unknownToolPolicy`
- `highRiskPolicy`
- `shellCompoundPolicy`

Those keys turn a simple count policy into a classifier-backed authorization system. That is too broad for the temporary cleanup and creates an incomplete boundary around what "read" and "write" mean.

## Required Behavior

With `maxToolUses: 2`:

1. A sequential-thinking checkpoint allows the next two matched non-exempt tool calls.
2. The third matched non-exempt tool call requires a new checkpoint.
3. Read-only tools consume the grant the same way write tools do.
4. Unknown tools consume the grant the same way known tools do.
5. A later non-thinking telemetry event does not invalidate the grant while uses remain and TTL has not expired.
6. Failed, stale, or other-session thinking events do not grant access.

## Verification

Required checks:

```powershell
rg -n "toolClasses|readOnlyShellPrefixes|consumeReadOnly|unknownToolPolicy|highRiskPolicy|shellCompoundPolicy|maxGatedToolUses" E:\hooks\config.json E:\hooks\thinking-gate\thinking-gate.py
python thinking-gate/test-thinking-gate.py
node _core/generate-config-schema.mjs
node quality-completion-gate/test-config-model.mjs
node _core/validate-runtime-hooks.mjs
python -m py_compile thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py
```

The grep must return no live config/runtime support for the rejected taxonomy. The tests must prove `maxToolUses` works for at least `1`, `2`, and `5`.
