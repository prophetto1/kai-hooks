# Thinking Gate Grant, Prompt Hygiene, and Local Plan Token Implementation Plan

**Goal:** Stabilize the hook control plane so planning enforcement improves reasoning quality instead of fragmenting work, while reducing unnecessary exposure to external reasoning-model prompt classification.

**Architecture:** Phase 1 keeps the existing external `sequentialthinking` tool as the planning signal but changes `thinking-gate` from a strict latest-event one-use ticket into a configurable bounded grant. Phase 1 also trims model-visible protocol text and neutralizes gate/loop messages. Phase 2 replaces the external reasoning-tool dependency with a local planning-token grant and completes risk-tiered gate routing.

**Tech Stack:** Python hooks, Node ESM hooks, SQLite (`E:/hooks/_db/hooks.db`, `E:/memory/memory-sqlite.db`), `config.json` plus generated `config.schema.json`, existing hook telemetry, existing quality completion gate tests.

**Status:** Draft for implementation approval

**Author:** Codex

**Date:** 2026-06-02

---

## Direct Answer: Is `thinking-gate` Configurable Today?

Yes. The live `thinking-gate` is controlled by `E:/hooks/config.json`.

Current configurable fields:

| Field | Current value | Meaning |
|---|---:|---|
| `hooks[id="thinking-gate"].enabled` | `true` | Turns the gate on or off. |
| `failPolicy` | `open` | Hook implementation errors allow the tool instead of blocking. |
| `match.tools` | `["*"]` | Applies the gate to every tool unless the hook code exempts it. |
| `settings.table` | `hook_events` | Telemetry table read by the gate. |
| `settings.consumptionTable` | `thinking_gate_consumptions` | Table used to consume one planning event. |
| `settings.ttlSeconds` | `300` | How recent the planning event must be. |
| `settings.thinkingTools` | list of sequentialthinking MCP tool names | Tool names treated as planning signals and exempted from the gate. |
| `settings.bootstrapTools` | `ToolSearch` terms | Allows finding the thinking tool without deadlock. |

What is not configurable today:

- No `maxToolUsesPerThinking`.
- No grant window mode.
- No risk tier classification.
- No read-only/tool-family exemptions beyond the thinking tool and `ToolSearch` bootstrap.
- No local planning token.

Phase 1 adds the missing bounded-window controls.

---

## Current-State Findings

### Repository State

The current worktree is already a large uncommitted restructuring. The plan must not assume the initial import layout is still authoritative.

Observed top-level runtime directories:

- `_core/`
- `_db/`
- `_docs/`
- `.state/`
- `depcruiser-migrations/`
- `hook-telemetry/`
- `inject-protocol/`
- `inject-protocol-complex/`
- `loop-safety/`
- `memory-normalizer/`
- `quality-completion-gate/`
- `thinking-gate/`
- `telemetry/` (legacy duplicate path still present)

The DB surface is file based and is being consolidated under `_db/`:

- `E:/hooks/_db/hooks.db`
- `E:/hooks/_db/hooks.db.pre-move-created.20260602-114321.bak`
- `E:/memory/memory-sqlite.db`
- `.state/` for per-hook JSONL/runtime state

### Current Live Hook Registry

Source of truth: `E:/hooks/config.json`.

| Hook | Event | Enabled | Runtime | Data dependency |
|---|---|---:|---|---|
| `inject-protocol` | `UserPromptSubmit` | yes | Node | Reads `memoryDb`, skill FTS, protocol file |
| `inject-protocol-complex` | `UserPromptSubmit` | no | Node | Same family, disabled |
| `hook-telemetry` | `PostToolUse`, `PostToolUseFailure` | yes | Python | Writes `_db/hooks.db.hook_events` |
| `thinking-gate` | `PreToolUse` | yes | Python | Reads `hook_events`, writes `thinking_gate_consumptions` |
| `memory-normalizer` | `PostToolUse` | yes | Python | Reads/writes `memoryDb`, audits to `hook_events` |
| `loop-safety` | `PreToolUse` | yes | Python | Reads `hook_events`, emits soft/hard gate JSON |
| `quality-completion-gate` | `Stop` | yes | Node | Reads git status and `quality-verify-manifest.json` |
| `governance-gate` | `PreToolUse` | no | Python/Node path declared | Script missing, planned only |

### Shared Runtime and Config Surface

| File | Role |
|---|---|
| `_core/hook_runtime.py` | Python hook runtime: loads `config.json`, enforces `enabled`, `match.tools`, `failPolicy`, resolves `hooksDb`, opens SQLite WAL. |
| `_core/config-model.mjs` | Config model and semantic validator. It special-cases `inject-protocol`, `hook-telemetry`, `loop-safety`, `thinking-gate`, and `skill-indexer`. |
| `_core/generate-config-schema.mjs` | Regenerates `config.schema.json` from the model. |
| `_core/validate-runtime-hooks.mjs` | Validates schema freshness, semantic config, enabled script paths, and protocol file existence. |

### SQLite Surface

`E:/hooks/_db/hooks.db` currently has:

| Table | Columns | Used by |
|---|---|---|
| `hook_events` | `id`, `ts`, `ts_iso`, `session_id`, `project`, `hook_id`, `event`, `tool_name`, `target`, `decision`, `status`, `duration_ms`, `detail` | Written by telemetry and normalizer audit; read by `thinking-gate` and `loop-safety`. |
| `thinking_gate_consumptions` | `id`, `ts`, `session_id`, `thinking_event_id`, `tool_name` | Written/read by `thinking-gate`; currently `thinking_event_id` is effectively one-use by `UNIQUE`. |

`E:/memory/memory-sqlite.db` currently has:

- `memories`
- `memory_content_fts`
- `skills`
- `skills_fts`
- vector/embedding tables that require the vector extension for full introspection

Phase 1 must not depend on vector-table internals.

### Current Thinking-Gate Behavior

`thinking-gate/thinking-gate.py` currently:

1. Exempts configured sequentialthinking tool names.
2. Exempts configured bootstrap tool patterns.
3. Selects only the latest same-session telemetry row within `ttlSeconds`.
4. Allows only if that latest row is a successful configured thinking tool.
5. Inserts that exact event id into `thinking_gate_consumptions`.
6. Denies all subsequent non-thinking calls until a new successful thinking call occurs.

This is why one shell/file-read operation invalidates the prior thinking call: the shell event becomes the latest event.

### Current Prompt/Message Hygiene Surface

Model-visible surfaces that need audit:

- `inject-protocol/per-prompt-protocol.md`
- `inject-protocol-complex/per-prompt-protocol.md`
- `thinking-gate/thinking-gate.py:emit_deny`
- `loop-safety/loop-guard.py:_emit_soft`
- `loop-safety/loop-guard.py:_emit_hard`
- `quality-completion-gate/quality-completion-gate.mjs` Stop messages
- `config.json` descriptions and `_note` fields when they appear in injected or inspected context

Current per-prompt protocol text includes charged or meta-control terms such as:

- `guardrails`
- `bypasses`
- `block`
- `fallbacks/loopholes`

Phase 1 must reduce this model-visible load.

### Current Completion-Gate Mismatch To Repair Before Implementation

`quality-completion-gate/quality-verify-manifest.json` has `repos[name="hooks"].blockOnUnmatched = true`.

Its `runtime.paths.prefixes` still includes stale paths such as:

- `docs/`
- `closure-gate/`
- `lib/`
- `scripts/`
- `telemetry/`

It does not include current paths that matter for this plan:

- `_docs/`
- `depcruiser-migrations/`
- `hook-telemetry/`

This is not part of the thinking-gate logic, but it affects implementation completion. Phase 1 must start by repairing the manifest prefixes so the Stop gate can verify the files that actually exist.

---

## External Pattern Grounding

Current official and primary-source patterns support targeted, risk-tiered control instead of universal per-tool reasoning:

1. OpenAI Agents guardrails distinguish input, output, and tool guardrails. This maps to targeted validation at workflow/tool boundaries, not a global forced-thinking loop for every observation.
   - Source: `https://openai.github.io/openai-agents-python/guardrails/`

2. Claude Code hooks support hook events and matchers such as `PreToolUse`, allowing selective control around tool classes.
   - Source: `https://code.claude.com/docs/en/hooks-guide`

3. LangGraph interrupts/checkpoints pause before sensitive actions and resume from durable state. This supports Phase 2's local planning-token/checkpoint direction.
   - Source: `https://docs.langchain.com/oss/python/langgraph/interrupts`

4. OpenAI reasoning guidance favors clear goals and constraints without forcing every intermediate reasoning step into the prompt. This supports shrinking the per-prompt protocol and avoiding rich meta-reasoning in the external sequentialthinking payload.
   - Source: `https://developers.openai.com/api/docs/guides/reasoning#advice-on-prompting`

5. ReAct-style agent loops interleave reasoning, action, and observation, but the pattern is not "run a separate reasoning model before every tool." Evidence gathering remains part of the loop.
   - Source: `https://arxiv.org/abs/2210.03629`

---

## Directional Decision

The good pairings are:

| Pairing | Description | Use now? |
|---|---|---:|
| Windowed grant + prompt/deny hygiene | Fixes repeated external thinking calls and reduces model-visible charged text. | Yes, Phase 1. |
| Windowed grant + partial risk-tiering | Lets read-only/tool-batch work proceed without one thought per read. | Yes, Phase 1. |
| Full risk-tiering + local plan-token | Replaces external reasoning calls with a local planning grant and applies stricter checks only where risk warrants it. | Yes, Phase 2. |
| Prompt hygiene + local plan-token | Reduces prompt noise and removes classifier dependency for planning grants. | Yes, Phase 2 continuation. |
| Sequentialthinking input gate + windowed grant | Constrains the external thought field but adds another policy-shaped local gate. | No, avoid as primary fix. |

Recommendation:

1. Phase 1: implement `windowed grant + prompt/deny hygiene + minimal risk-tier exemptions`.
2. Phase 2: implement `full risk-tiered gates + local plan-token`, then demote external sequentialthinking from authorization primitive to optional planning aid.

---

# Phase 1 Plan: Windowed Grant, Prompt Hygiene, and Minimal Risk Tiering

## Phase 1 Goal

Make the current planning gate usable and configurable without changing the fundamental trigger from external sequentialthinking yet.

Phase 1 must:

1. Replace strict latest-event one-use tickets with a configurable windowed grant.
2. Keep all window controls in `config.json`.
3. Preserve `_db/hooks.db` as the audit substrate.
4. Neutralize model-visible deny/soft-block messages.
5. Trim per-prompt injected protocol payload.
6. Add minimal risk-tier behavior without trying to solve the whole policy architecture.
7. Repair the hooks completion manifest for current `_`-prefixed paths before relying on completion checks.

## Phase 1 Non-Goals

Phase 1 does not:

- Add a new MCP server.
- Add a local plan-token system.
- Remove sequentialthinking as the planning signal.
- Implement the disabled governance gate.
- Change memory-vector internals.
- Depend on vector-table introspection in `E:/memory/memory-sqlite.db`.
- Implement full command safety classification for arbitrary shell commands.
- Rewrite the hook architecture around LangGraph or another external framework.

## Phase 1 Architecture

Current:

```text
tool call denied -> agent calls sequentialthinking -> one next tool allowed -> ticket consumed
```

Phase 1:

```text
agent calls sequentialthinking -> latest successful thinking event opens bounded grant
bounded grant -> up to N non-exempt gated tool calls inside TTL
low-risk exempt tools -> allowed without consuming grant when configured
write/destructive/risky tools -> still require grant
```

The grant remains tied to:

- same `session_id`
- successful configured thinking tool name
- `ts >= now - ttlSeconds`
- local consumption count below `maxToolUsesPerThinking`

## Phase 1 Config Contract

Modify `config.json` under `hooks[id="thinking-gate"].settings`.

Add:

```json
{
  "grantMode": "windowed",
  "maxToolUsesPerThinking": 8,
  "exemptTools": [
    "ToolSearch"
  ],
  "riskTiers": {
    "observe": {
      "tools": ["memory_search"],
      "consumeGrant": false
    },
    "inspect": {
      "tools": [],
      "consumeGrant": true
    },
    "change": {
      "tools": ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"],
      "consumeGrant": true
    }
  },
  "_mode": "Windowed grant. The latest successful same-session configured thinking event within ttlSeconds authorizes up to maxToolUsesPerThinking gated tool calls. Non-thinking events do not invalidate the grant."
}
```

Notes:

- `grantMode` is explicit so the implementation can keep `strict` available temporarily for rollback.
- `maxToolUsesPerThinking` must be a positive integer.
- `exemptTools` is intentionally narrow in Phase 1. Do not globally exempt `Bash` yet.
- `riskTiers` is intentionally minimal and mostly declarative in Phase 1. The full classifier belongs in Phase 2.

## Phase 1 Database Contract

No new table is required.

Use existing `thinking_gate_consumptions`, but change the meaning:

Current:

- `thinking_event_id UNIQUE` makes a thinking event one-use.

Phase 1:

- A thinking event may have up to `maxToolUsesPerThinking` consumption rows.
- The implementation must remove or stop creating the `UNIQUE` constraint on `thinking_event_id`.
- Existing DBs that already have a unique index/constraint must be migrated safely.

Required DB handling:

1. In `ensure_consumption_schema`, create the table without `UNIQUE`.
2. Add a non-unique index on `(session_id, thinking_event_id, ts)`.
3. For existing `thinking_gate_consumptions` tables with `thinking_event_id UNIQUE`, migrate by:
   - creating `thinking_gate_consumptions_v2`
   - copying existing rows
   - dropping old table
   - renaming v2 to `thinking_gate_consumptions`
   - recreating indexes
4. Keep existing rows; do not delete telemetry history.

No change to `hook_events`.

## Phase 1 Hook Runtime Surface

### `thinking-gate/thinking-gate.py`

Replace these functions:

- `latest_session_event`
- `consume_fresh_thinking`
- `emit_deny`

Add or modify:

| Function | Contract |
|---|---|
| `latest_successful_thinking_event(con, table, session_id, cutoff, thinking_tools)` | Return the newest successful thinking event for the session inside TTL, regardless of later non-thinking events. |
| `consumption_count(con, consumption_table, session_id, thinking_event_id)` | Count rows already consumed for the grant. |
| `consume_windowed_grant(...)` | In `BEGIN IMMEDIATE`, find latest thinking event, migrate/ensure table, count, insert one consumption if under max. |
| `configured_positive_int(settings, key, default)` | Parse bounded integer config safely. |
| `is_exempt_tool(settings, tool_name, tool_input)` | Keep thinking tools and bootstrap behavior; optionally exempt explicitly configured low-risk tools. |
| `emit_planning_needed(tool_name, ttl_seconds, max_uses)` | Neutral operational message. No charged meta-language. |

Required behavior:

1. The thinking tool itself is always allowed.
2. Bootstrap tools remain allowed only when their configured term match succeeds.
3. If `grantMode = "strict"`, old behavior remains available for rollback.
4. If `grantMode = "windowed"`, later non-thinking events do not invalidate the grant.
5. A grant permits at most `maxToolUsesPerThinking` gated tool calls.
6. A grant expires after `ttlSeconds`.
7. Different sessions cannot use each other's grants.
8. Failed thinking tool events do not grant access.
9. Handler errors still fail open through `_core/hook_runtime.py`.

Neutral deny message target:

```text
thinking-gate: planning checkpoint needed before using '<tool>'. Run the configured planning tool, then retry. Current grant: 0 remaining or expired.
```

Do not include:

- `bypass`
- `circumvent`
- `security`
- `safety`
- `policy`
- `violation`
- `jailbreak`

### `thinking-gate/test-thinking-gate.py`

Replace current strict assertions:

- `consumes thinking ticket immediately`
- `denies after a non-thinking tool`

With windowed assertions:

1. `allows thinking tool itself`
2. `allows sequentialthinking ToolSearch bootstrap`
3. `denies unrelated ToolSearch`
4. `denies without thinking`
5. `allows first tool after fresh thinking`
6. `allows second tool after same fresh thinking when maxToolUsesPerThinking >= 2`
7. `denies after maxToolUsesPerThinking consumptions`
8. `allows after non-thinking latest event if thinking grant remains within TTL and count`
9. `denies stale thinking`
10. `denies different session`
11. `denies failed thinking event`
12. `migrates old unique consumption table to non-unique windowed table`
13. `strict mode preserves one-use behavior for rollback`

### `_core/config-model.mjs`

Update `validateThinkingGate` to validate:

- `settings.grantMode` is absent or `"strict" | "windowed"`.
- `settings.maxToolUsesPerThinking` is a positive integer when `grantMode = "windowed"`.
- `settings.exemptTools` is absent or a string array.
- `settings.riskTiers` is absent or an object with known simple shape.

Do not overfit the schema to the final Phase 2 model. Phase 1 should validate only what it uses.

### `config.schema.json`

Regenerate with:

```powershell
node _core/generate-config-schema.mjs
```

Only regenerate after `_core/config-model.mjs` changes.

### `_core/validate-runtime-hooks.mjs`

No functional change expected.

Run after config/model/schema edits:

```powershell
node _core/validate-runtime-hooks.mjs
```

Expected:

```text
Runtime hook validation passed
```

The disabled missing `governance-gate` warning may remain unless separately fixed.

## Phase 1 Prompt Hygiene Contract

### Files

- `inject-protocol/per-prompt-protocol.md`
- `inject-protocol-complex/per-prompt-protocol.md`
- `config.json` `hooks[id="inject-protocol"].settings.output.capChars`

### Protocol Rewrite Requirements

Create a shorter protocol that preserves operational constraints but removes charged meta-language.

Must keep:

1. Memory recall requirement.
2. Skill loading requirement.
3. Repo write discipline.
4. SOPS-only secret rule.
5. Clean target map.
6. Brevity.

Must remove or neutralize:

- `guardrails`
- `bypass`
- `bypasses`
- `circumvent`
- `security` unless in `Secrets via SOPS only`
- `safety`
- `policy` unless necessary for repo policy file names
- `loopholes`
- `block`
- `deny`

Recommended protocol size target:

- `<= 4500` characters before memory/skill additions.
- Reduce `output.capChars` from `9500` to a Phase 1 target such as `6500`.

Do not remove the actual requirements just to reduce size. Rewrite them in operational language.

Example direction:

Current:

```text
No fallbacks/loopholes - fix the real thing.
```

Target:

```text
Fix the actual failing path. Do not use mocks, skip flags, or compatibility shortcuts as substitutes.
```

### Inject-Protocol Behavior

`inject-protocol/inject-protocol.mjs` should not need a code change if:

- the protocol file is shorter
- `capChars` is updated in config
- labels stay stable

If the output cap truncates useful memory/skill suggestions, add a test case before changing assembly order.

## Phase 1 Deny/Soft Message Hygiene Contract

### Files

- `thinking-gate/thinking-gate.py`
- `loop-safety/loop-guard.py`
- `quality-completion-gate/quality-completion-gate.mjs` if its Stop messages are model-visible in Codex
- `config.json` description fields only if they are injected or repeatedly read by agents

### Message Rules

Messages must be:

- operational
- short
- specific about next action
- free of charged meta-language

Messages must not explain:

- local enforcement philosophy
- classifier behavior
- upstream safety systems
- prompt-policy behavior
- anti-circumvention framing

Target examples:

Thinking gate:

```text
thinking-gate: planning checkpoint needed before using '<tool>'. Run the configured planning tool, then retry.
```

Loop soft:

```text
loop-safety: '<operation>' repeated the same failed result <n>x. Change approach before retrying.
```

Loop hard:

```text
loop-safety: '<operation>' reached the retry limit after <n> repeated failures. Inspect the cause before retrying.
```

## Phase 1 Minimal Risk-Tier Behavior

Phase 1 does not implement a full classifier. It only avoids the worst current behavior.

Allowed Phase 1 risk behavior:

1. Thinking tools are exempt.
2. `ToolSearch` bootstrap remains exempt when its configured search terms match.
3. Optional low-risk tools may be listed in `settings.exemptTools`.
4. All edit/write/destructive tools still require a valid grant.
5. `Bash` remains gated by default, because reliable Windows PowerShell read-only classification is not solved in Phase 1.

Do not attempt in Phase 1:

- full shell command parsing
- destructive command taxonomy
- path-sensitive write grant logic
- governance-path authorization
- local plan-token issue command

These belong in Phase 2.

## Phase 1 Quality-Completion Manifest Repair

Before implementation is considered complete, update `quality-completion-gate/quality-verify-manifest.json` for the `hooks` repo.

Required prefix updates:

- Add `_docs/`
- Add `_db/`
- Add `hook-telemetry/`
- Add `depcruiser-migrations/`
- Keep `_core/`
- Keep `thinking-gate/`
- Keep `loop-safety/`
- Keep `inject-protocol/`
- Keep `inject-protocol-complex/`
- Keep `memory-normalizer/`
- Keep `quality-completion-gate/`
- Decide whether `telemetry/` stays as a legacy alias or is removed after verifying no live config points to it.
- Remove or replace stale `docs/`, `lib/`, and `scripts/` prefixes if those dirs are no longer the active layout.

This is a Phase 1 prerequisite because `blockOnUnmatched = true` can otherwise block completion on the plan and hook files that now live under `_docs/` and renamed directories.

## Phase 1 Observability Contract

No new observability table is required.

Existing rows remain:

- `hook_events` records tool calls after execution.
- `thinking_gate_consumptions` records planning grant consumption.

Add, if useful and small:

- `thinking_gate_consumptions.detail` is not required in Phase 1.
- Do not add a new table unless tests prove consumption counts cannot answer the audit question.

The implementation should preserve enough information to answer:

1. Which session consumed a planning grant?
2. Which thinking event granted it?
3. Which tool consumed it?
4. How many consumptions remain under `maxToolUsesPerThinking`?

## Phase 1 Security and Secrets Contract

No secret reads or writes.

No SOPS changes.

No network credentials.

No external service dependencies.

No new package install.

## Phase 1 Tasks

### Task 1: Repair hooks completion manifest path coverage

**Files:**

- `quality-completion-gate/quality-verify-manifest.json`

**Steps:**

1. Add `_docs/`, `hook-telemetry/`, and `depcruiser-migrations/` to the `hooks.runtime.paths.prefixes` list.
2. Remove stale `docs/`, `lib/`, and `scripts/` only after confirming no active files remain there.
3. Decide whether to keep or remove `telemetry/` after confirming whether it is a legacy duplicate of `hook-telemetry/`.
4. Run `node _core/validate-runtime-hooks.mjs`.
5. Run `node quality-completion-gate/quality-completion-gate.mjs --self-test`.

**Expected output:**

- Runtime validation passes.
- Completion gate self-test emits JSON allowing continuation when no relevant dirty-file mismatch exists, or blocks only on real failed commands.

### Task 2: Add windowed thinking-gate config

**Files:**

- `config.json`
- `_core/config-model.mjs`
- `config.schema.json`
- `quality-completion-gate/test-config-model.mjs`

**Steps:**

1. Add `grantMode: "windowed"` and `maxToolUsesPerThinking` under `thinking-gate.settings`.
2. Add minimal `exemptTools` and `riskTiers` only if the implementation will consume them in Phase 1.
3. Update `validateThinkingGate`.
4. Regenerate `config.schema.json`.
5. Update config-model tests if they assert the previous setting shape.

**Test commands:**

```powershell
node _core/generate-config-schema.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
```

**Expected output:**

- Generated schema matches model.
- Runtime hook validation passes.
- Config model tests pass.

### Task 3: Migrate `thinking_gate_consumptions` schema behavior

**Files:**

- `thinking-gate/thinking-gate.py`
- `thinking-gate/test-thinking-gate.py`

**Steps:**

1. Write a failing test fixture with an old one-use/unique table.
2. Add migration logic in `ensure_consumption_schema`.
3. Ensure migration preserves existing rows.
4. Ensure the resulting table permits multiple rows for one `thinking_event_id`.
5. Add a non-unique index for grant counting.

**Test command:**

```powershell
python thinking-gate/test-thinking-gate.py
```

**Expected output:**

```text
thinking gate tests passed
```

### Task 4: Implement windowed grant query semantics

**Files:**

- `thinking-gate/thinking-gate.py`
- `thinking-gate/test-thinking-gate.py`

**Steps:**

1. Replace latest-any-event query with latest-successful-thinking-event query.
2. Count consumption rows for the selected thinking event.
3. Allow if count is below `maxToolUsesPerThinking`.
4. Insert a consumption row inside the same `BEGIN IMMEDIATE`.
5. Preserve strict mode behind `grantMode: "strict"` for rollback.
6. Update tests for same-session, other-session, stale, failed, max-count, and non-thinking-latest cases.

**Test command:**

```powershell
python thinking-gate/test-thinking-gate.py
```

**Expected output:**

```text
thinking gate tests passed
```

### Task 5: Neutralize thinking-gate and loop-safety messages

**Files:**

- `thinking-gate/thinking-gate.py`
- `loop-safety/loop-guard.py`
- `thinking-gate/test-thinking-gate.py`

**Steps:**

1. Rewrite the thinking-gate deny reason to an operational planning-checkpoint message.
2. Rewrite loop-safety soft and hard messages to operational retry-limit messages.
3. Add tests that assert the messages do not contain forbidden terms.
4. Keep JSON output shape unchanged.

**Forbidden terms for tests:**

- `bypass`
- `circumvent`
- `security`
- `safety`
- `policy`
- `violation`
- `jailbreak`

**Test commands:**

```powershell
python thinking-gate/test-thinking-gate.py
python -m py_compile _core/hook_runtime.py hook-telemetry/log-event.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/test-memory-runtime.py thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py inject-protocol-complex/recall.py inject-protocol-complex/suggest.py
```

**Expected output:**

- Thinking gate tests pass.
- Python compile exits 0.

### Task 6: Trim per-prompt protocol

**Files:**

- `inject-protocol/per-prompt-protocol.md`
- `inject-protocol-complex/per-prompt-protocol.md`
- `config.json`

**Steps:**

1. Rewrite protocol text to operational bullets.
2. Preserve memory, skill, repo write, SOPS, and repo map requirements.
3. Remove charged meta-language.
4. Reduce `hooks[id="inject-protocol"].settings.output.capChars` to a lower value such as `6500`.
5. Confirm `inject-protocol-complex` uses the same neutral protocol text even though it is disabled.

**Test commands:**

```powershell
node inject-protocol/inject-protocol.mjs --self-test
node inject-protocol-complex/inject-protocol-complex.mjs --self-test
node _core/validate-runtime-hooks.mjs
```

**Expected output:**

- Inject protocol self-test succeeds.
- Complex self-test succeeds or remains disabled/fail-open as currently intended.
- Runtime hook validation passes.

### Task 7: Run full hooks verification

**Files:**

- no edits

**Commands:**

```powershell
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
python memory-normalizer/test-memory-runtime.py
python memory-normalizer/normalize-after-store.py --self-test
python thinking-gate/test-thinking-gate.py
node inject-protocol/inject-protocol.mjs --self-test
node inject-protocol-complex/inject-protocol-complex.mjs --self-test
python -m py_compile _core/hook_runtime.py hook-telemetry/log-event.py loop-safety/loop-guard.py memory-normalizer/memory_retain.py memory-normalizer/normalize-after-store.py memory-normalizer/normalize-memory-tags.py memory-normalizer/test-memory-runtime.py thinking-gate/thinking-gate.py thinking-gate/test-thinking-gate.py inject-protocol/index-skills.py inject-protocol/recall.py inject-protocol/suggest.py inject-protocol-complex/recall.py inject-protocol-complex/suggest.py
node --check _core/config-model.mjs
node --check _core/generate-config-schema.mjs
node --check _core/validate-runtime-hooks.mjs
node --check inject-protocol/inject-protocol.mjs
node --check inject-protocol-complex/inject-protocol-complex.mjs
node --check quality-completion-gate/quality-completion-gate.mjs
node --check quality-completion-gate/quality-gate-core.mjs
node --check quality-completion-gate/test-config-model.mjs
```

**Expected output:**

- All commands exit 0.
- Any disabled missing `governance-gate` warning is explicitly reported and not treated as a thinking-gate failure.

## Phase 1 Acceptance Criteria

Phase 1 is complete only when:

1. `thinking-gate` is configurable for window size via `config.json`.
2. A successful configured thinking call grants more than one tool use when `maxToolUsesPerThinking > 1`.
3. Later successful non-thinking tool events do not invalidate the grant.
4. The grant still expires by TTL.
5. The grant still respects session boundaries.
6. Failed thinking events do not grant.
7. Strict mode remains available for rollback.
8. Per-prompt protocol text is shorter and neutral.
9. Gate/loop messages are operational and avoid forbidden charged terms.
10. Runtime validation and hook self-tests pass.
11. `quality-verify-manifest.json` covers current `_docs/`, `_core/`, `hook-telemetry/`, and `depcruiser-migrations/` paths.

## Phase 1 Rollback

If the windowed gate misbehaves:

1. Set `hooks[id="thinking-gate"].settings.grantMode = "strict"`.
2. Keep neutral messages and protocol hygiene; they are independently useful.
3. Re-run:

```powershell
node _core/validate-runtime-hooks.mjs
python thinking-gate/test-thinking-gate.py
```

Rollback does not require deleting new DB rows. Strict mode can ignore extra consumption rows or continue counting only one-use semantics.

---

# Phase 2 Plan: Local Plan Token and Full Risk-Tiered Gates

## Phase 2 Feasibility

Phase 2 is possible without adding an external framework if the local plan token is implemented as a local hook-controlled grant in `_db/hooks.db`.

The important idea:

> A local plan token is a structured local grant that proves the agent performed an explicit planning checkpoint, without sending a rich `thought` payload to an external reasoning model.

It replaces:

```text
successful external sequentialthinking tool call -> authorization grant
```

with:

```text
local planning checkpoint command/tool -> _db/hooks.db planning grant -> authorization grant
```

This means the control plane no longer depends on an upstream model request classifier for the basic authorization primitive.

## Phase 2 Goal

Complete the steady-state architecture:

1. Local planning grants become the primary authorization signal.
2. External sequentialthinking becomes optional, not required.
3. Risk-tiered gates decide when a planning grant is required.
4. Protected writes require explicit user grant.
5. Completion verification remains deterministic and exit-code based.

## Phase 2 Non-Goals

Phase 2 does not:

- Replace all agent reasoning.
- Inspect hidden chain-of-thought.
- Require a new external service.
- Require LangGraph adoption.
- Require changing `E:/memory/memory-sqlite.db` vector tables.
- Require disabling OpenAI, Claude, or Codex safety systems.

## Phase 2 Architecture

```text
User prompt
  -> inject-protocol supplies compact operating contract
  -> agent chooses a local planning checkpoint when needed
  -> planning-token gate writes a local grant to _db/hooks.db
  -> risk-tier gate evaluates each tool call
  -> low-risk observe tools proceed
  -> normal work consumes bounded local grant
  -> protected/destructive actions require stronger grant/user approval
  -> completion gate verifies changed domains by exit code
```

## Phase 2 Local Plan Token Definition

A local plan token is not an external reasoning call.

It is a row in `_db/hooks.db` created by a local planning checkpoint surface.

Recommended table:

```sql
CREATE TABLE IF NOT EXISTS planning_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  ts_iso TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  grant_kind TEXT NOT NULL,
  risk_tier TEXT NOT NULL,
  max_tool_uses INTEGER NOT NULL,
  expires_at REAL NOT NULL,
  source_tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_planning_grants_session_ts
  ON planning_grants(session_id, ts DESC, id DESC);
```

Recommended consumption table:

```sql
CREATE TABLE IF NOT EXISTS planning_grant_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  session_id TEXT NOT NULL,
  planning_grant_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  target TEXT,
  risk_tier TEXT
);

CREATE INDEX IF NOT EXISTS idx_planning_grant_consumptions_grant
  ON planning_grant_consumptions(planning_grant_id, ts DESC, id DESC);
```

`summary` must be short and operational:

- allowed: "Investigate hook runtime and draft plan."
- allowed: "Apply approved Phase 1 thinking-gate changes."
- not allowed: long internal reasoning, copied user secrets, full repo dumps, or policy/classifier discussion.

## Phase 2 Planning Checkpoint Surface

Recommended implementation for the current runtime:

### New directory

```text
planning-token/
  issue-plan-token.py
  planning-token-gate.py
  test-planning-token.py
```

### `issue-plan-token.py`

Local no-op script invoked by the agent through a tightly allowlisted command shape.

It prints a short success message, but it does not need to write the DB row itself.

Reason: the `PreToolUse` hook has the authoritative `session_id`, `cwd`, `tool_name`, and tool input. The hook should create the token when it sees the exact allowed planning-token command.

### `planning-token-gate.py`

`PreToolUse` hook that:

1. Detects the local plan-token issue command.
2. Validates it is exactly the local script and contains only allowed args.
3. Writes `planning_grants` using the hook payload's session and cwd.
4. Allows the command.
5. For later gated tools, reads `planning_grants`, counts consumption, and allows/denies by risk tier.

### Why use a local command instead of hidden assistant text?

Hooks cannot reliably inspect hidden assistant reasoning. A visible local checkpoint command gives the hook an auditable event without depending on external reasoning-model calls.

## Phase 2 Risk-Tier Contract

Add a dedicated `risk-policy` section to `config.json`.

Recommended shape:

```json
{
  "riskPolicy": {
    "tiers": {
      "observe": {
        "requiresGrant": false,
        "consumeGrant": false
      },
      "inspect": {
        "requiresGrant": true,
        "consumeGrant": true,
        "maxToolUses": 12
      },
      "change": {
        "requiresGrant": true,
        "consumeGrant": true,
        "maxToolUses": 6
      },
      "protected_write": {
        "requiresGrant": true,
        "requiresUserGrant": true,
        "consumeGrant": true,
        "maxToolUses": 3
      },
      "destructive": {
        "requiresGrant": true,
        "requiresUserGrant": true,
        "consumeGrant": true,
        "maxToolUses": 1
      }
    },
    "toolClassifiers": {
      "Edit": "change",
      "Write": "change",
      "MultiEdit": "change",
      "NotebookEdit": "change",
      "apply_patch": "change",
      "memory_search": "observe",
      "ToolSearch": "observe"
    },
    "bash": {
      "defaultTier": "inspect",
      "readOnlyPrefixes": [
        "rg ",
        "git status",
        "git log",
        "Get-Content ",
        "Get-ChildItem ",
        "Select-String ",
        "Test-Path "
      ],
      "destructivePatterns": [
        "Remove-Item",
        "rm ",
        "git reset",
        "git checkout --",
        "del ",
        "rmdir ",
        "move ",
        "Move-Item"
      ]
    },
    "protectedPaths": [
      "governance/",
      "contracts/",
      "secrets/",
      ".sops.yaml",
      "config.json",
      "config.schema.json"
    ]
  }
}
```

Phase 2 must validate this config in `_core/config-model.mjs`.

## Phase 2 User Grant Contract

Protected writes require explicit user grant naming:

- path or surface
- action
- scope

Examples:

- "Allow edits to `E:/hooks/config.json` for this Phase 1 implementation."
- "Allow updating `governance/contracts/*.json` to add dependency rules."

Local plan-token is not a substitute for user approval on protected writes.

## Phase 2 Hook Registry Changes

Add new hook:

```json
{
  "id": "planning-token-gate",
  "name": "Planning Token Gate",
  "description": "Local PreToolUse gate that issues and consumes bounded planning grants from _db/hooks.db.",
  "category": "gate",
  "event": "PreToolUse",
  "match": { "tools": ["*"] },
  "script": { "path": "planning-token/planning-token-gate.py", "runtime": "python" },
  "scope": { "projects": ["*"], "paths": ["**"] },
  "enabled": false,
  "failPolicy": "open",
  "settings": {
    "grantTable": "planning_grants",
    "consumptionTable": "planning_grant_consumptions",
    "ttlSeconds": 600
  }
}
```

Rollout sequence:

1. Add hook disabled.
2. Validate config.
3. Run tests.
4. Enable in observation mode.
5. Compare decisions against `thinking-gate`.
6. Make planning-token primary.
7. Set `thinking-gate.enabled = false` or reduce it to optional fallback.

## Phase 2 Implementation Files

New:

- `planning-token/issue-plan-token.py`
- `planning-token/planning-token-gate.py`
- `planning-token/test-planning-token.py`

Modified:

- `config.json`
- `config.schema.json`
- `_core/config-model.mjs`
- `_core/validate-runtime-hooks.mjs` only if path validation needs a new protocol check
- `quality-completion-gate/quality-verify-manifest.json`
- `thinking-gate/thinking-gate.py` only to demote or disable external thinking dependency
- `skills-catalog.md` if a new skill or command is added for planning-token workflow

## Phase 2 Tasks

### Task 1: Add risk policy config model

**Files:**

- `_core/config-model.mjs`
- `config.json`
- `config.schema.json`
- `quality-completion-gate/test-config-model.mjs`

**Steps:**

1. Add `riskPolicy` schema and validator.
2. Add default config.
3. Regenerate schema.
4. Add tests for valid and invalid tiers.

**Commands:**

```powershell
node _core/generate-config-schema.mjs
node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
```

### Task 2: Add local planning grant tables and tests

**Files:**

- `planning-token/planning-token-gate.py`
- `planning-token/test-planning-token.py`

**Steps:**

1. Write table creation tests.
2. Implement `ensure_planning_grant_schema`.
3. Implement consumption counting.
4. Verify old DBs without tables are upgraded idempotently.

**Command:**

```powershell
python planning-token/test-planning-token.py
```

### Task 3: Add plan-token issue command recognition

**Files:**

- `planning-token/issue-plan-token.py`
- `planning-token/planning-token-gate.py`
- `planning-token/test-planning-token.py`

**Steps:**

1. Define exact allowed command shape.
2. In the gate, detect only that shape.
3. Reject command strings with shell separators, redirections, or unapproved paths.
4. Create a grant row from hook payload session/cwd.
5. Allow the command.
6. Confirm unrelated shell commands are not treated as token issuance.

**Command:**

```powershell
python planning-token/test-planning-token.py
```

### Task 4: Add risk-tier classifier

**Files:**

- `planning-token/planning-token-gate.py`
- `planning-token/test-planning-token.py`

**Steps:**

1. Classify direct edit tools as `change`.
2. Classify protected paths as `protected_write`.
3. Classify known read-only non-shell tools as `observe`.
4. Classify `Bash` using conservative prefix/pattern rules.
5. Default unclassified `Bash` to `inspect`.
6. Classify destructive patterns as `destructive`.
7. Add tests for Windows PowerShell examples.

**Command:**

```powershell
python planning-token/test-planning-token.py
```

### Task 5: Enforce grants by risk tier

**Files:**

- `planning-token/planning-token-gate.py`
- `planning-token/test-planning-token.py`

**Steps:**

1. `observe`: allow without grant.
2. `inspect`: require local planning grant unless explicitly exempt.
3. `change`: require grant and consume.
4. `protected_write`: require grant plus user grant.
5. `destructive`: require grant plus user grant; one use max.
6. Emit neutral operational messages.

**Command:**

```powershell
python planning-token/test-planning-token.py
```

### Task 6: Add observation-mode rollout

**Files:**

- `config.json`
- `planning-token/planning-token-gate.py`
- `planning-token/test-planning-token.py`

**Steps:**

1. Add `settings.mode = "observe" | "enforce"`.
2. In observe mode, never deny; write decision/audit rows only.
3. Run a session with both `thinking-gate` and `planning-token-gate` enabled, with planning-token in observe mode.
4. Compare expected decisions manually from `_db/hooks.db`.
5. Flip to enforce only after observation matches expectation.

### Task 7: Demote external sequentialthinking dependency

**Files:**

- `config.json`
- `thinking-gate/thinking-gate.py`
- `thinking-gate/test-thinking-gate.py`

**Steps:**

1. Keep `thinking-gate` available but disabled by default, or convert it to optional fallback.
2. Make `planning-token-gate` the primary planning gate.
3. Keep sequentialthinking usable as a skill/tool for hard planning, but not required for every authorization window.
4. Run both test suites.

**Commands:**

```powershell
python planning-token/test-planning-token.py
python thinking-gate/test-thinking-gate.py
node _core/validate-runtime-hooks.mjs
```

## Phase 2 Acceptance Criteria

Phase 2 is complete only when:

1. A local plan-token command can create a grant without external model calls.
2. The grant is stored in `_db/hooks.db`.
3. Observe-tier tools can proceed without external thinking calls.
4. Inspect/change tools consume local grants.
5. Protected writes require explicit user grant.
6. Destructive commands require the strongest grant and are never silently allowed.
7. External sequentialthinking is no longer required as the normal authorization primitive.
8. All hook tests and config validation pass.
9. The implementation has an observation-mode rollout path.
10. The completion gate verifies the changed hook domains by manifest commands.

## Phase 2 Risks

1. Shell command classification can be wrong. Mitigation: keep `Bash` default at `inspect`, not `observe`, and classify destructive strings conservatively.
2. Hook payload differences between Claude and Codex may affect tool names. Mitigation: test both known families: Claude edit names and Codex `apply_patch`/`Bash`.
3. User grant detection can become brittle. Mitigation: require explicit path/surface/action grant text and record the grant in `_db/hooks.db`.
4. Plan-token command issuance still requires a tool call. Mitigation: allow only one exact local token command shape as bootstrap.
5. Too many local state tables can obscure debugging. Mitigation: keep tables small and names explicit.

## Phase 2 Rollback

If planning-token enforcement misbehaves:

1. Set `planning-token-gate.enabled = false`.
2. Re-enable Phase 1 `thinking-gate` windowed mode.
3. Keep prompt/deny hygiene changes.
4. Re-run:

```powershell
node _core/validate-runtime-hooks.mjs
python thinking-gate/test-thinking-gate.py
python planning-token/test-planning-token.py
```

---

## Implementation Approval Gate

Before executing either phase:

1. Re-read this plan.
2. Verify current `config.json`, `_core/config-model.mjs`, `thinking-gate/thinking-gate.py`, `loop-safety/loop-guard.py`, and `quality-verify-manifest.json`.
3. Confirm whether Phase 1 should keep strict rollback mode.
4. Confirm `maxToolUsesPerThinking` default.
5. Confirm whether Phase 2 should use the local command bootstrap or require a first-class local MCP tool.

No implementation should start until Phase 1 is approved.
