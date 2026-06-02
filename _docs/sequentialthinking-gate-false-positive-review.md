# Sequentialthinking Gate False-Positive Review

Status: **proposal only.** Nothing in this document is implemented. This brief is for an independent Codex review before changing live hooks.

## Goal

Reduce false-positive OpenAI prompt-policy blocks from `sequentialthinking` tool calls while preserving the local intent of `thinking-gate`: require deliberate planning before tool use.

The fix must not bypass OpenAI safety checks. It must reduce unnecessary exposure to those checks by ensuring the local system sends only minimal, neutral input to the external `sequentialthinking` model.

## Current As-Is Reality

### Live gate contract

`thinking-gate` is a `PreToolUse` hook in `config.json`.

Relevant config:

- `config.json:238-244` declares `thinking-gate`, `PreToolUse`, and match `tools: ["*"]`.
- `config.json:251` sets `ttlSeconds` to `300`.
- `config.json:252-258` lists sequentialthinking MCP tool names.
- `config.json:263` describes the current mode as a strict one-use ticket: the next gated tool is allowed only if the latest recent same-session telemetry row is a successful configured thinking tool, and that row has not already been consumed.

Relevant implementation:

- `thinking-gate/thinking-gate.py:70-76` selects only the latest same-session event within the TTL.
- `thinking-gate/thinking-gate.py:88-95` begins an immediate SQLite transaction and denies unless that latest event is an `ok` sequentialthinking tool event.
- `thinking-gate/thinking-gate.py:96-104` inserts into `thinking_gate_consumptions`, making the thinking row one-use.
- `thinking-gate/thinking-gate.py:107-120` returns a deny decision telling the agent to run sequentialthinking before the blocked tool.

Relevant test assertions:

- `thinking-gate/test-thinking-gate.py:163-165` asserts that one fresh thinking event allows one tool, then is immediately consumed.
- `thinking-gate/test-thinking-gate.py:167-168` asserts that a non-thinking event after a thinking event causes denial.

### Telemetry substrate

The existing telemetry hook already records enough state to implement a better grant model without a new state store.

Relevant implementation:

- `hook-telemetry/log-event.py:32-47` defines `hook_events` with `id`, `ts`, `session_id`, `tool_name`, and `status`.
- `hook-telemetry/log-event.py:95-99` derives `status`.
- `hook-telemetry/log-event.py:108-132` inserts one row per tool event.

## Observed Phenomenon

The user observed intermittent failures when the agent calls `sequentialthinking`:

```text
Invalid prompt: your prompt was flagged as potentially violating our usage policy.
Please try again with a different prompt:
https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
```

The working hypothesis is:

1. `thinking-gate` denies a tool call.
2. The agent calls `sequentialthinking` to satisfy the gate.
3. If the `thought` field contains rich diagnostic text about hooks, policies, gate behavior, bypass prevention, system instructions, or security-sensitive meta-language, the OpenAI-side request classifier may reject the prompt before model generation.
4. The MCP/router surfaces the upstream API error.
5. Because the local gate requires repeated one-use sequentialthinking calls, the system repeatedly exposes itself to the same false-positive surface.

This does not mean the user's content is unsafe. It means a local hook design is sending unnecessary high-entropy meta-prompt content to a model endpoint that performs request-level safety classification.

## External Source Grounding

OpenAI safety docs state that requests are classified into risk thresholds and may return errors when safety systems identify high-risk activity:

- https://developers.openai.com/api/docs/guides/safety-checks

OpenAI prompt-block guidance says prompts may be blocked for content-policy or security-measure reasons, including prompts that appear to manipulate or circumvent safety systems:

- https://help.openai.com/en/articles/9824988-why-was-my-chatgpt-prompt-blocked

OpenAI reasoning-model guidance recommends clear goals, constraints, and output contracts without prescribing every intermediate step:

- https://developers.openai.com/api/docs/guides/reasoning#advice-on-prompting

The proposed fix aligns with those docs by narrowing sequentialthinking input to a short, neutral authorization signal instead of sending internal diagnostic reasoning.

## Problem Statement

The current design has two coupled problems.

### Problem 1: Unsafe-by-shape sequentialthinking input

The tool is being used as a local gate token, but its free-text `thought` field can contain rich internal reasoning. That is unnecessary for the gate and creates avoidable classifier exposure.

The gate needs proof that a deliberate planning step occurred. It does not need a detailed explanation sent to the external model.

### Problem 2: The strict latest-event one-use model amplifies exposure

The current gate requires the latest telemetry event to be sequentialthinking and consumes it immediately. This causes three failures:

- Parallel tool calls break because one sequentialthinking event can authorize only one tool.
- Any harmless intervening tool event makes the previous thinking event unusable.
- The agent must call sequentialthinking repeatedly, increasing the number of chances for a false-positive external prompt rejection.

The current behavior is not a bug in SQLite or telemetry. It is encoded in config, code, and tests.

## Proposed Fix

Implement two coordinated changes.

### 1. Add a local `sequentialthinking-input-gate`

Add a `PreToolUse` hook that matches only configured sequentialthinking tool names.

Purpose:

- Validate the `tool_input.thought` before it reaches the external model.
- Deny rich or non-neutral thoughts locally.
- Tell the agent exactly what neutral payload to retry.

Recommended allowed payload shape:

```json
{
  "thought": "Proceed with tool authorization.",
  "thoughtNumber": 1,
  "totalThoughts": 1,
  "nextThoughtNeeded": false
}
```

Recommended validation rules:

- `thought` must be short, for example 80 characters or less.
- `thought` must be ASCII printable.
- `thought` must either equal one of a small allowlist or match a narrow neutral pattern.
- `thought` must not include user content, repo evidence, policy terms, safety terms, security terms, bypass language, chain-of-thought language, or hook internals.
- `thoughtNumber` must be `1`.
- `totalThoughts` must be `1`.
- `nextThoughtNeeded` must be `false`.

Suggested allowlist:

- `Proceed with tool authorization.`
- `Proceed with read-only inspection.`
- `Proceed with focused implementation.`
- `Proceed with verification.`

The hook should deny invalid sequentialthinking inputs with a clear retry instruction. It should not rewrite the payload silently.

Rationale:

- Local validation is deterministic.
- A deny-before-call prevents bad-shaped prompts from hitting the external API.
- A fixed neutral payload preserves the gate signal without exposing internal reasoning.
- The agent can still reason in normal assistant context; it just must not put that rich reasoning into `sequentialthinking.thought`.

### 2. Replace strict latest-event one-use tickets with a windowed grant

Change `thinking-gate` from:

```text
latest same-session event must be successful sequentialthinking and unused
```

to:

```text
latest successful same-session sequentialthinking event within TTL grants a bounded short window of tool use
```

Recommended settings:

```json
{
  "ttlSeconds": 300,
  "maxToolUsesPerThinking": 5
}
```

Recommended query model:

1. In `BEGIN IMMEDIATE`, find the latest `hook_events` row where:
   - `session_id = current session`
   - `tool_name IN configured thinking tools`
   - `status = "ok"`
   - `ts >= now - ttlSeconds`
2. Do not require that row to be the latest event overall.
3. Count rows in `thinking_gate_consumptions` for that `thinking_event_id`.
4. Allow if the count is below `maxToolUsesPerThinking`.
5. Insert a consumption row for the gated tool before allowing.

This preserves a bounded proof-of-thinking requirement while avoiding repeated sequentialthinking calls for every tool.

## Why This Is The Best Fit Here

### It fixes the real failure mode

The false-positive event happens before or during the external sequentialthinking model call. Changing downstream telemetry or retrying with different rich text will not reliably solve it.

The correct control is at the boundary: constrain what enters the external model.

### It reduces model calls instead of adding more

The strict one-use gate forces repeated sequentialthinking calls. A windowed grant reduces the number of external calls and therefore reduces the number of safety-classifier opportunities.

### It keeps the safety posture intact

This is not a skip flag, bypass, mock, or disabled gate. It keeps a planning gate but changes the evidence model from "rich text sent to a model every time" to "short neutral planning marker plus bounded local accounting."

### It uses existing infrastructure

`hook_events` and `thinking_gate_consumptions` already exist. The fix changes query semantics and adds one validation hook. It does not require a new database, daemon, external service, or credential.

### It follows tool-design best practice

For tools used as control-plane signals, the input should be constrained and boring. Free-text model prompts are the wrong substrate for internal authorization state.

The better pattern is:

- Structured input.
- Narrow validation.
- Deterministic local denial for malformed input.
- Actionable error message.
- Bounded grant.
- Existing telemetry as the audit substrate.

### It aligns with reasoning-model guidance

OpenAI reasoning guidance favors clear tasks and constraints without forcing every intermediate reasoning step into the prompt. Here, the external reasoning model does not need detailed local hook reasoning to authorize the next local tool. It only needs a minimal neutral marker.

## Alternative Fixes Considered

### Disable `thinking-gate`

Rejected. It removes the enforcement behavior the system was built to provide.

### Keep one-use tickets and only tell agents to be concise

Rejected. It depends on agent behavior and still forces repeated calls. The system should enforce the safe input shape.

### Add retries around sequentialthinking

Rejected. Retrying a prompt that was rejected by safety classification is noisy and can amplify the problem.

### Exempt more tools from `thinking-gate`

Partially useful but not sufficient. Exemptions reduce friction for specific tools, but they do not fix the unsafe-by-shape sequentialthinking input or parallel-call churn.

### Store a separate session flag outside `hook_events`

Rejected for now. Existing telemetry already provides session, timestamp, tool, and status. A new store adds moving parts without solving a missing capability.

## Implementation Sketch

### New hook directory

Create:

```text
E:/hooks/sequentialthinking-input-gate/
  sequentialthinking-input-gate.py
  test-sequentialthinking-input-gate.py
```

### Config updates

Add a new hook before `thinking-gate`:

```json
{
  "id": "sequentialthinking-input-gate",
  "name": "Sequential Thinking Input Gate",
  "category": "gate",
  "event": "PreToolUse",
  "match": {
    "tools": [
      "mcp__mcp_router__sequentialthinking",
      "mcp__mcp-router__sequentialthinking",
      "mcp__sequential-thinking__sequentialthinking",
      "mcp__sequentialthinking__sequentialthinking",
      "mcp__plugin_sequential-thinking_sequential-thinking__sequentialthinking",
      "mcp__plugin_sequentialthinking_sequentialthinking__sequentialthinking"
    ]
  },
  "script": {
    "path": "sequentialthinking-input-gate/sequentialthinking-input-gate.py",
    "runtime": "python"
  },
  "scope": { "projects": ["*"], "paths": ["**"] },
  "enabled": true,
  "failPolicy": "open",
  "settings": {
    "maxThoughtChars": 80,
    "allowedThoughts": [
      "Proceed with tool authorization.",
      "Proceed with read-only inspection.",
      "Proceed with focused implementation.",
      "Proceed with verification."
    ]
  }
}
```

Note: `failPolicy: open` keeps the hook system from deadlocking if the validator itself fails. The validator should still deny invalid payloads when it runs successfully.

### Thinking gate updates

Update `thinking-gate` settings:

```json
{
  "ttlSeconds": 300,
  "maxToolUsesPerThinking": 5
}
```

Update `_mode` text from strict one-use ticket to bounded short-window grant.

Update `thinking-gate.py`:

- Replace `latest_session_event` with a query for the latest successful sequentialthinking row within TTL.
- Do not invalidate the grant merely because another tool event happened later.
- Count consumptions for the selected thinking row.
- Allow only if consumption count is below `maxToolUsesPerThinking`.
- Keep `BEGIN IMMEDIATE` for atomic count-plus-insert behavior.

Update `thinking-gate/test-thinking-gate.py`:

- Existing "consumes thinking ticket immediately" should become "allows up to configured max uses."
- Existing "denies after a non-thinking tool" should become "still allows after unrelated non-thinking telemetry within grant limit."
- Add "denies after grant use count is exhausted."
- Keep stale and different-session denial tests.

## Verification Plan

Run these checks after implementation:

```powershell
python E:/hooks/sequentialthinking-input-gate/test-sequentialthinking-input-gate.py
python E:/hooks/thinking-gate/test-thinking-gate.py
python -m py_compile E:/hooks/sequentialthinking-input-gate/sequentialthinking-input-gate.py E:/hooks/thinking-gate/thinking-gate.py E:/hooks/hook-telemetry/log-event.py
node E:/hooks/_core/validate-runtime-hooks.mjs
node E:/hooks/quality-completion-gate/test-config-model.mjs
```

Manual smoke:

1. Call sequentialthinking with the allowed neutral payload.
2. Confirm one successful `hook_events` row is recorded.
3. Run two read-only shell commands without another sequentialthinking call.
4. Confirm both are allowed under the same thinking grant.
5. Call sequentialthinking with rich policy/meta text.
6. Confirm the local input gate denies before the external model receives it.

## Review Questions For Independent Codex

1. Is a bounded grant of `maxToolUsesPerThinking = 5` the right default, or should it be lower for write tools?
2. Should the input gate use an exact allowlist only, or allow a narrow regex?
3. Should `thinking-gate` treat write tools differently from read-only tools?
4. Should the input gate live as a separate hook directory, or be folded into `thinking-gate`?
5. Does the proposed approach preserve the original governance intent better than disabling or broad-exempting the gate?

## Recommended Review Verdict Criteria

Approve the proposal only if the reviewer agrees that:

- The root problem is unnecessary rich text sent to sequentialthinking plus over-frequent local gate calls.
- The proposed input gate prevents high-risk prompt shape locally rather than bypassing external safety.
- The bounded grant preserves a real planning requirement.
- The implementation uses existing telemetry state correctly.
- Tests cover the old failure mode and the new desired behavior.

