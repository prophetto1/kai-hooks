# Hooks Repo Review

## 1. Executive Verdict

**Verdict: Partially works.**

The repo has real, non-trivial hook implementations. Several hooks are implemented with coherent runtime behavior, and the tests cover meaningful cases for telemetry, thinking grants, loop safety, quality gating, browser verification, frontend design enforcement, and injection output composition.

But I would **not call this repo ready as a portable, stable hook system** yet.

It is ready only under a narrow deployment assumption:

- The repo is installed at **`E:/hooks`**.
- `config.json` is present at **`E:/hooks/config.json`** or `HOOKS_CONFIG_PATH` is set.
- The memory DB exists at the configured path.
- Claude Code / Codex / another runtime is already externally configured to invoke these scripts.
- You accept that some hooks are disabled and some config keys are metadata-only or drifted.

**Works:**

- `inject-protocol` can load config, validate it, parse a prompt, query skill/memory helpers, and emit `UserPromptSubmit` additional context.
- `hook-telemetry` can append tool events into SQLite.
- `thinking-gate` can require a recent sequential-thinking event before tools.
- `loop-safety` can detect repeated same-operation failures and emit soft/hard PreToolUse decisions.
- `memory-normalizer` can observe memory tool writes, resolve rows, normalize metadata/tags, and audit.
- Disabled Stop gates are implemented and tested, but not active by default.

**Does not fully work as a stable runtime system:**

- There is no committed Claude/Codex hook wiring file showing what actually invokes the scripts.
- Many defaults, tests, schema IDs, manifests, and validators hardcode `E:/hooks`.
- Python and Node runtimes do not enforce the same contract.
- `hooks[].event` is validated but not enforced by the shared Python runtime.
- Several config settings are declared but unused, duplicated, or only partially validated.
- Tests are meaningful but not hermetic or portable.

Claude Code’s current hooks docs confirm that command hooks receive JSON on stdin, JSON output is processed on exit `0`, `PreToolUse` should use `hookSpecificOutput.permissionDecision`, and `Stop` continues to use top-level `decision: "block"` / `reason`. That means the repo’s “exit 0 + JSON decision” pattern is valid for Claude Code. I could not independently verify the claimed Codex-specific contract from official OpenAI docs in this review. Source: https://docs.anthropic.com/en/docs/claude-code/hooks

---

## 2. Repository Map

| Path | Role | Who calls it | Inputs | Outputs / side effects | Status |
|---|---|---|---|---|---|
| `config.json` | Central hook registry and settings artifact. Defines shared paths, projects, enabled hooks, scripts, and per-hook settings. | Loaded by most hook scripts via `HOOKS_CONFIG_PATH` or default `E:/hooks/config.json`. | JSON config. | Controls hook settings, DB paths, thresholds, scripts, memory/skill search. | Active, but contains portability and drift issues. |
| `config.schema.json` | Generated JSON Schema. | Validator and editors. | Generated from `_core/config-model.mjs`. | Schema validation / editor assistance. | Generated artifact, hardcoded to `E:/hooks`. |
| `_core/config-model.mjs` | Source-of-truth schema generator plus imperative validator. | `inject-protocol`, `_core/validate-runtime-hooks.mjs`, tests. | Parsed `config.json`. | Validation result and generated schema. | Active, but schema is much weaker than imperative validation for most hooks. |
| `_core/hook_runtime.py` | Shared Python hook wrapper. Handles config load, enabled checks, tool matching, payload parsing, fail-open/closed, DB helpers. | Python hooks call `run(hook_id, handler)`. | stdin JSON, config. | Exits `0` or `2`; may print JSON from handler. | Active, important, but does not enforce hook event matching. |
| `_core/validate-runtime-hooks.mjs` | Runtime config validator. | Manual script / quality gate. | `config.json`, `config.schema.json`. | Prints validation result, exits nonzero on errors. | Active, but hardcodes `E:/hooks/config.schema.json`. |
| `_core/generate-config-schema.mjs` | Schema generator. | Manual script. | Config model. | Writes `config.schema.json`. | Active, but hardcodes default output path. |
| `inject-protocol/inject-protocol.mjs` | `UserPromptSubmit` hook. Injects protocol, skill suggestions, memory recall, diagnostics. | Agent runtime should invoke on `UserPromptSubmit`. | stdin hook payload; config; memory DB; transcript path. | stdout JSON `hookSpecificOutput.additionalContext`; `.state` JSONL event log. | Active and enabled. |
| `inject-protocol/inject-core.mjs` | Shared pure helpers for project detection and output composition. | `inject-protocol` and tests. | Projects, labels, memories, skills, budgets. | Composed text block. | Active. |
| `inject-protocol/recall.py` | Memory recall helper. | Spawned by `inject-protocol.mjs`. | DB path, FTS query, project, JSON config. | JSONL rows on stdout. | Active. |
| `inject-protocol/suggest.py` | Skill suggestion helper. | Spawned by `inject-protocol.mjs`. | DB path, FTS query, project, terms, JSON config. | JSONL rows on stdout. | Active. |
| `inject-protocol/index-skills.py` | Maintenance script to rebuild `skills` / `skills_fts`. | Manual script from config. | Config, `skills-catalog.md`, `SKILL.md` scan roots. | Rebuilds skill tables in memory DB. | Active maintenance script. |
| `hook-telemetry/log-event.py` | `PostToolUse` / `PostToolUseFailure` logger. | Agent runtime should invoke after tools. | stdin hook payload. | Inserts rows into `hook_events`. | Active and enabled. |
| `thinking-gate/thinking-gate.py` | `PreToolUse` planning grant gate. | Agent runtime should invoke before tools. | stdin payload; `hook_events` DB. | Emits JSON deny decision or silently allows; writes consumption rows. | Active and enabled. |
| `loop-safety/loop-guard.py` | `PreToolUse` retry breaker. | Agent runtime should invoke before selected tools. | stdin payload; `hook_events` DB. | Emits soft context or deny decision; otherwise silent allow. | Active and enabled. |
| `memory-normalizer/normalize-after-store.py` | `PostToolUse` observer for memory mutation tools. | Agent runtime should invoke after configured memory tools. | stdin payload; memory DB; hooks DB. | Updates memory metadata/tags and writes audit rows. | Active and enabled. |
| `memory-normalizer/memory_retain.py` | Pure memory normalization/classification helper. | Memory normalizer and maintenance scripts. | Memory content, config, cwd/tool/session context. | Normalized retain payload. | Active. |
| `memory-normalizer/normalize-memory-tags.py` | Manual tag maintenance tool. | Config script `tag-normalizer`. | Config, memory DB. | Dry-run or updates memory tags. | Active maintenance script. |
| `memory-normalizer/maintain-existing-memories.py` | Manual memory cleanup/dedupe maintenance script. | Quality manifest compiles/tests it; not listed in `config.json.scripts`. | Config, memory DB. | Dry-run/apply normalization and dedupe. | Active-ish, but not registered as a script. |
| `quality-completion-gate/quality-completion-gate.mjs` | `Stop` hook that maps changed files to verification commands. | Agent runtime if enabled. | stdin Stop payload; git repo; verify manifest. | stdout `{continue:true}` or `{decision:"block", reason}`. | Implemented but disabled in config. |
| `quality-completion-gate/quality-gate-core.mjs` | Shared Node helpers for quality gate. | Quality gate and tests. | Config, git, manifest. | Git status, changed domains, command results. | Active. |
| `quality-completion-gate/quality-verify-manifest.json` | Repo/domain/verification command manifest. | Quality gate. | Git changed files. | Determines commands to run. | Active, but has directory drift. |
| `browser-verify-gate/browser-verify-gate.py` | `Stop` hook requiring browser verification on large turns. | Agent runtime if enabled. | stdin Stop payload; telemetry DB. | Blocks or allows completion. | Implemented but disabled. |
| `frontend-design-gate/frontend-design-gate.py` | `Stop` hook blocking newly added raw HTML primitives when design-system components exist. | Agent runtime if enabled. | stdin Stop payload; git diff. | Blocks or allows completion. | Implemented but disabled. |
| `*_test.*` files | Ad hoc test suite. | Manual commands / quality manifest. | Temp DBs/repos, hardcoded `E:/hooks`. | Prints pass/fail, exits nonzero. | Useful but not portable. |
| `_docs/*` | Design proposals and migration notes. | Not invoked by runtime. | Markdown. | Documentation only. | Useful historical docs, not executable contract. |

The main registry says it is intended as the source of truth for `E:/hooks`, but it also admits that selected hooks are wired from live Codex config rather than from this repo alone. The `_notWired` section also says some settings are migration notes “not yet consumed by all loaders.”

---

## 3. Runtime Trace

### Important global runtime fact

There is no committed Claude Code `settings.json`, Codex `config.toml`, plugin manifest, or installer that proves how the agent runtime invokes these hooks. Searches for `settings.json` and `config.toml` mostly returned docs/proposals and `config.json`, not actual runtime wiring files.

So the **first invoked file** is not knowable from this repo alone. Internally, each script expects to be invoked directly by an external hook runtime.

### Shared Python hook path

Python hooks use `_core/hook_runtime.py`.

Flow:

1. Script imports `_core/hook_runtime.py`.
2. Script calls `run("<hook-id>", handler)`.
3. Runtime loads config from `HOOKS_CONFIG_PATH` or `E:/hooks/config.json`.
4. Runtime finds its own config entry by `hooks[].id`.
5. If `enabled === false`, exits `0`.
6. Runtime parses stdin JSON; malformed JSON becomes `{}`.
7. If `tool_name` is present, runtime checks `match.tools`.
8. Handler runs.
9. If handler returns `EXIT_DENY`, runtime exits `2`; otherwise exits `0`. Handler-printed JSON is the primary decision channel for most gates.

**Important gap:** this shared runtime does **not** check `payload.hook_event_name` against `hooks[].event`. It trusts external wiring.

### `inject-protocol` — `UserPromptSubmit`

**Entry:** `inject-protocol/inject-protocol.mjs`

Trace:

1. Agent invokes `node inject-protocol/inject-protocol.mjs`.
2. Script loads config from `HOOKS_CONFIG_PATH` or `E:/hooks/config.json`.
3. It validates the entire config using `_core/config-model.mjs`; invalid config exits `0` with stderr and no hidden default injection.
4. It finds its own hook entry by script basename `inject-protocol`.
5. It builds runtime settings from `SELF.settings`.
6. It reads stdin JSON; malformed JSON becomes `{ raw }`.
7. It extracts prompt text from `prompt`, `user_prompt`, `message`, `input`, or `raw`.
8. It reads the configured protocol file.
9. If prompt text exists:
   - Detects project from cwd.
   - Extracts configured terms.
   - Reads transcript tail for prior user prompts.
   - Calls `suggest.py` for skills and `recall.py` for memories.
   - Builds diagnostics if helper calls fail.
   - Calls `composeOutput`.
10. It emits:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

**Failure behavior:** fail-open. Config/read/validation errors exit `0`; helper failures become diagnostics rather than blocking.

**Runtime quality:** good conceptually, but not event-guarded and not portable unless config/DB paths exist.

### `hook-telemetry` — `PostToolUse` / `PostToolUseFailure`

**Entry:** `hook-telemetry/log-event.py`

Trace:

1. Agent invokes script after tool success/failure.
2. Shared Python runtime loads config and enforces `enabled`, `failPolicy`, `match.tools`.
3. Handler reads:
   - `hook_event_name`
   - `session_id`
   - `cwd`
   - `tool_name`
   - `tool_input`
   - `tool_response` / `tool_result`
4. It classifies status:
   - `PostToolUseFailure` -> `error`
   - structured error envelope fields -> `error`
   - otherwise `ok`
5. It derives target using shared `extract_target`.
6. It opens `shared.paths.hooksDb`, creates `hook_events` if needed, inserts a row, prunes retention occasionally.
7. Exits `0`.

**Output:** normally none.

**Side effect:** appends to SQLite `hook_events`.

**Failure behavior:** fail-open through Python runtime.

**Runtime quality:** solid base substrate. Risk is that downstream gates depend heavily on this table existing and matching actual runtime payload shapes.

### `thinking-gate` — `PreToolUse`

**Entry:** `thinking-gate/thinking-gate.py`

Trace:

1. Agent invokes script before a tool call.
2. Shared runtime loads config and checks `match.tools`.
3. Handler reads `session_id`, `tool_name`, `tool_input`.
4. If missing `session_id` or `tool_name`, allows silently.
5. If tool is one of configured `thinkingTools`, allows silently.
6. If tool is bootstrap `ToolSearch` with a sequential-thinking query, allows silently.
7. Otherwise:
   - Opens hooks DB.
   - Ensures `thinking_gate_consumptions` table.
   - Finds latest successful thinking event in `hook_events` within TTL.
   - Counts consumptions for that thinking event.
   - If under `maxToolUses`, inserts a consumption row and allows.
   - Otherwise emits deny JSON.
8. Deny output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "..."
  },
  "systemMessage": "..."
}
```

**Exit behavior:** always exits `0` unless the runtime itself exits due to fail-closed error. The decision rides in JSON.

**Runtime quality:** works as tested, but it depends on telemetry being enabled and correctly recording the thinking tool call. The config validator does not correctly fail when telemetry is missing.

### `loop-safety` — `PreToolUse`

**Entry:** `loop-safety/loop-guard.py`

Trace:

1. Agent invokes before matched tools: `Bash`, edits, `apply_patch`, and selected context-mode tools.
2. Shared runtime loads config and checks `match.tools`.
3. Handler reads `session_id`, `tool_name`, `tool_input`.
4. It builds an operation key:
   - Bash -> command/subcommand grouping, e.g. `bash:git:commit`
   - edit family -> `edit:<file>`
   - other tools -> `<tool>:<target>`
5. It opens `hook_events`.
6. It walks recent rows for this session newest-first.
7. For same operation:
   - success breaks chain
   - different error fingerprint breaks chain
   - repeated same error increments count
8. If `count >= hardMax`, emits PreToolUse deny JSON.
9. If `count >= softMax`, emits additional context.
10. Otherwise silently allows.

**Output examples:**

- Soft: `hookSpecificOutput.additionalContext` + `systemMessage`
- Hard: `hookSpecificOutput.permissionDecision = "deny"`

**Exit behavior:** intentionally always `0`; JSON carries the decision.

**Runtime quality:** good and fairly robust, assuming telemetry quality is high.

### `memory-normalizer` — `PostToolUse`

**Entry:** `memory-normalizer/normalize-after-store.py`

Trace:

1. Agent invokes after configured memory mutation tools.
2. Shared runtime loads config and checks exact `match.tools`.
3. Handler checks:
   - tool is configured
   - hook event is successful `PostToolUse`
   - response envelope does not signal error
4. `memory_delete` is audit-only.
5. It extracts candidate memory row IDs/hashes/content from `tool_input` and `tool_response`.
6. It opens `shared.paths.memoryDb`.
7. It queries memory rows by ID, content hash, hash prefix, raw content, or normalized content.
8. For each row:
   - builds retain payload
   - normalizes tags and memory type
   - updates `tags`, `memory_type`, `metadata`, `updated_at`, `updated_at_iso`
9. It writes an audit event to `hook_events`.
10. On exception, it attempts audit and then re-raises so the shared runtime fail-opens.

**Output:** none normally.

**Side effects:** memory DB updates and hook audit row.

**Runtime quality:** useful, but has config drift: it declares configurable write table/columns while hardcoding `memories` and specific columns.

### `quality-completion-gate` — `Stop`

**Entry:** `quality-completion-gate/quality-completion-gate.mjs`

**Config status:** disabled by default.

Trace when enabled:

1. Agent invokes on `Stop`.
2. Node `hookRuntime` loads config from `HOOKS_CONFIG_PATH` or `E:/hooks/config.json`.
3. If disabled, returns `{ continue: true }`.
4. Loads verify manifest.
5. Resolves git root.
6. Reads `git status --porcelain=v1 -z --untracked-files=all`.
7. Maps changed files to manifest domains.
8. Blocks if:
   - managed repo cannot be inspected
   - manifest missing
   - repo entry missing
   - unmatched files and `blockOnUnmatched !== false`
   - touched domain has no commands
   - commands fail
9. Runs manifest commands with timeout/budget.
10. On pass, returns `{ continue: true }`.
11. On failure, returns top-level `{ decision: "block", reason: "..." }`.
12. Repeated same failure eventually releases with `{ continue: true, systemMessage: "..." }`.

**Failure behavior:** fail-open in catch: returns `{ continue: true, systemMessage: "Quality completion gate skipped: ..." }`.

**Runtime quality:** good concept, but Node runtime lacks parity with Python runtime: no common event/match/failPolicy enforcement.

### `browser-verify-gate` — `Stop`

**Entry:** `browser-verify-gate/browser-verify-gate.py`

**Config status:** disabled by default.

Trace when enabled:

1. Agent invokes on `Stop`.
2. Shared Python runtime loads config.
3. Handler reads session ID and settings.
4. Opens telemetry DB read-only if it exists.
5. Finds rows for session after last stored Stop watermark and from `hook-telemetry`.
6. Counts tool uses and detects browser navigate/snapshot patterns.
7. If small turn or browser verified, stores watermark and allows.
8. If repeated blocks exceed limit, releases with `continue: true`.
9. Otherwise emits:

```json
{
  "decision": "block",
  "reason": "..."
}
```

**Runtime quality:** coherent but depends on telemetry and tool-name patterns. Missing `session_id` causes all no-session state to collide.

### `frontend-design-gate` — `Stop`

**Entry:** `frontend-design-gate/frontend-design-gate.py`

**Config status:** disabled by default.

Trace when enabled:

1. Agent invokes on `Stop`.
2. Shared Python runtime loads config.
3. Handler resolves git repo root.
4. Inventories `components/ui/<primitive>.tsx`.
5. Reads added lines from `git diff --unified=0 HEAD -- *.tsx *.jsx` plus untracked `.tsx/.jsx`.
6. Strips simple strings/comments.
7. Flags added raw primitives like `<button>` when a design-system equivalent exists.
8. Blocks with top-level `decision: "block"` or allows.
9. Repeated blocks eventually release with `continue: true`.

**Runtime quality:** practical and well-scoped, but git timeout is hardcoded to 5 seconds and not driven by config.

---

## 4. Config Audit

### High-level config findings

`config.json` is useful, but it is not yet a clean stable contract. It mixes:

- Runtime settings.
- Local machine paths.
- Migration notes.
- Documentation-only `_` fields.
- Script registry entries.
- Duplicated data that can drift.
- Disabled future hooks.
- Some keys that the runtime does not actually read.

The schema model is also only partially explicit. The generated schema has a strong generic shape and detailed `inject-protocol` settings, but most hook-specific settings are enforced only by imperative validation functions, not by rich JSON Schema definitions. The generic hook schema only has an `allOf` special case for `inject-protocol`.

### Config audit table

| Config key | Used where | Expected type | Actual behavior | Problem? | Recommended fix |
|---|---|---:|---|---|---|
| `$schema` | `_core/validate-runtime-hooks.mjs` | string | Must equal `./config.schema.json`. | Low | Fine. Keep. |
| `version` | config model | integer >= 1 | Validated only structurally. | Low | Add migration notes or changelog for version semantics. |
| `shared.paths.hooksDir` | validators, quality gate, state dirs | string path | Defaults and config assume `E:/hooks`. | High | Support repo-relative default or `HOOKS_HOME`. |
| `shared.paths.memoryDb` | inject helpers, memory normalizer, maintenance scripts | string path | Used as live SQLite DB path. | High portability risk | Do not default to machine-local path in committed config; use env override or local config overlay. |
| `shared.paths.hooksDb` | telemetry, gates | string path | Used for `hook_events` and gate state substrate. | Medium | Good setting, but validate DB/table readiness in diagnostics. |
| `shared.paths.skillsCatalog` | `index-skills.py` | string path | Used by skill indexer. | Low | Fine. |
| `shared.paths.qualityVerifyManifest` | quality gate | string path | Used as fallback manifest path. | Medium | Avoid duplicating with `quality-completion-gate.settings.verifyManifest`. |
| `shared.paths.skillsWarehouse` | unclear / mostly duplicated | string path | `skill-indexer` uses `scripts[].settings.scanRoots`, not this key. | Medium drift | Either derive `scanRoots` from this or remove. |
| `shared.paths.python` | `inject-protocol` helper execution | string command/path | Used by `execFileSync` to run Python helpers. | Low | Keep, but allow per-platform command. |
| `shared.runtime.pythonTimeoutMs` | `inject-protocol` | positive integer | Controls Python helper timeout. | Low | Fine. |
| `shared.runtime.gitTimeoutMs` | quality gate | positive integer | Used by quality gate; not used by frontend gate. | Medium | Make all git-using hooks use it. |
| `shared.runtime.verifyCommandTimeoutMs` | quality gate | positive integer | Used as default command timeout. | Low | Fine. |
| `shared.runtime.pythonEnv` | `inject-protocol` | object string map | Merged into helper env. | Low | Fine. |
| `shared.projects` | inject, memory normalizer, tag tools | array | Used for project detection. | Medium drift | Quality manifest separately duplicates repo roots; generate one from the other. |
| `shared.memoryTags` | memory retain/tag tools | object | Used for legacy tag rewrite, retired tags, cross-project tag. | Low | Fine. |
| `shared.stopwords` | inject-protocol, memory retain | string | Split into stopword set. | Low | Fine, though array would be clearer. |
| `hooks[].id` | all runtimes | string | Python scripts hardcode ID; Node derives from basename. | Medium | Add validator that script basename/declared ID match. |
| `hooks[].event` | config validator, external runtime | string or array | Validated, but Python runtime does not enforce event at runtime. | High | Add runtime event check. |
| `hooks[].match.tools` | Python runtime | array | Exact match or `"*"`. | Medium | Add regex/pattern support or document exact-only behavior. |
| `hooks[].script.path` | validators/docs | string | Used by validators, not used by hook scripts themselves. | Low | Fine. |
| `hooks[].script.runtime` | validators/docs | enum | Metadata only; no launcher consumes it. | Low | Fine if installer/launcher later uses it. |
| `hooks[].scope` | none found in runtime | object | Present on hooks, not enforced by scripts. | Medium | Either implement scope filtering or mark as metadata. |
| `hooks[].enabled` | all main hooks | boolean | Python runtime and Node hooks honor it. | Low | Good. |
| `hooks[].failPolicy` | Python runtime only | `"open"` / `"closed"` | Python wrapper enforces; Node runtimes generally fail-open regardless. | Medium | Add Node runtime parity or document Node hooks ignore it. |
| `inject-protocol.settings.terms` | inject-protocol | object | Drives token extraction and context prompts. | Low | Good. |
| `inject-protocol.settings.sources.protocol.file` | inject-protocol | string | Read relative to hook dir. | Low | Good. |
| `inject-protocol.settings.sources.memory` | inject-protocol / recall.py | object | Used to build recall query/config. | Low | Good. |
| `inject-protocol.settings.sources.skills` | inject-protocol / suggest.py | object | Used to build skill query/config. | Low | Good. |
| `inject-protocol.settings.output` | inject-core | object | Controls labels, budgets, cap. | Low | Good. |
| `hook-telemetry.settings.table` | telemetry/gates | SQL identifier string | Table created/used. | Low | Good. |
| `hook-telemetry.settings.retentionDays` | telemetry | integer >= 0 | Prunes every `retentionPruneEvery` rows. | Low | Good. |
| `hook-telemetry.settings.detailMaxChars` | telemetry | positive integer | Truncates error detail. | Low | Good. |
| `thinking-gate.settings.table` | thinking-gate | SQL identifier | Reads hook events. | Low | Good. |
| `thinking-gate.settings.consumptionTable` | thinking-gate | SQL identifier | Creates/uses grant consumption table. | Low | Good. |
| `thinking-gate.settings.ttlSeconds` | thinking-gate | positive integer | Used as top-level fallback if not in `grantPolicy`. | Low | Good but slightly oddly placed. |
| `thinking-gate.settings.grantPolicy.mode` | validator | string | Must be `bounded_tool_count`; handler does not branch on mode. | Low | Fine for now. |
| `thinking-gate.settings.grantPolicy.maxToolUses` | thinking-gate | positive integer | Controls consumptions per thinking event. | Low | Good. |
| `thinking-gate.settings.thinkingTools` | thinking-gate | string array | Exempt tools and grant source. | Low | Good. |
| `thinking-gate.settings.bootstrapTools` | thinking-gate | object | Allows `ToolSearch` only for configured search terms. | Low | Good. |
| `memory-normalizer.settings.sourceTools` | memory-normalizer | string array | Used for tool filtering, duplicated with `match.tools`. | Medium | Remove duplication or generate one from the other. |
| `memory-normalizer.settings.writes.memoryTable` | config only | SQL identifier | Declared but runtime hardcodes `memories`. | High | Use setting or remove from contract. |
| `memory-normalizer.settings.writes.columns` | config only | string array | Declared but runtime updates fixed columns. | Medium | Use for validation/introspection or remove. |
| `loop-safety.settings.softMax/hardMax/lookback` | loop-safety | positive integers | Used directly. | Low | Good. |
| `loop-safety.settings.subcommandTools` | loop-safety | object | Overrides Bash grouping. | Low | Good. |
| `loop-safety.settings.bashSkipTokens` | loop-safety | string array | Overrides wrapper-token handling. | Low | Good. |
| `loop-safety.settings.editFamily` | loop-safety | string array | Overrides edit-family tools. | Low | Good. |
| `quality-completion-gate.settings.verifyManifest` | quality gate | string path | Used before shared fallback. | Medium | Avoid duplicate manifest path with shared. |
| `quality-completion-gate.settings.authority` | validator only | fixed string | Enforces design: exit-codes-only. | Low | Fine as contract. |
| `quality-completion-gate.settings.maxRepeatedFailureBlocks` | quality gate | positive integer | Used for loop release. | Low | Good. |
| `quality-completion-gate.settings.totalBudgetMs` | quality gate | positive integer | Used for command budget. | Low | Good. |
| `quality-completion-gate.settings.inputs/nonAuthority` | validator/docs | string arrays | Not used by gate execution. | Low/Medium | Mark as documentation fields or remove. |
| `quality-completion-gate.settings.stateDir` | quality gate | optional string | Code supports it, config/model does not declare it. | Medium | Add to config/model or remove support. |
| `browser-verify-gate.settings.*` | browser gate | mixed | Used by disabled Stop gate. | Low | Good, but telemetry dependency validation is flawed. |
| `frontend-design-gate.settings.primitives` | frontend gate | object | Used by disabled Stop gate. | Low | Good. |
| `frontend-design-gate.settings.maxRepeatedBlocks/stateDir` | frontend gate | int/string | Used by Stop gate. | Low | Good. |
| `scripts[].settings` | maintenance scripts | mixed | Used by script-specific manual tools. | Medium | Good idea, but some paths duplicate `shared.paths`. |
| `scripts.tag-normalizer.settings.activeSlugs/projectSet` | tag normalizer | arrays | Duplicates `shared.projects`; script can derive fallback if omitted. | Medium | Remove duplication; derive from shared. |
| `_notWired` | none | object | Documentation-only migration note. | Low | Keep only if clearly marked non-contract. |

---

## 5. Bugs, Risks, and Drift

### 1. Hardcoded `E:/hooks` makes the repo non-portable

**Severity:** High
**Category:** portability, runtime failure, DX
**Files:** `config.json`, `_core/hook_runtime.py`, `_core/validate-runtime-hooks.mjs`, `_core/generate-config-schema.mjs`, tests

**What is wrong:** The default runtime assumes Windows path `E:/hooks`. Config, schema IDs, validator paths, generator defaults, tests, and manifests all hardcode this path.

Examples:

- `config.json` shared paths are all `E:/...`.
- Python runtime default config is `E:/hooks/config.json`.
- Runtime validator hardcodes `E:/hooks/config.schema.json`.
- Schema generator defaults to `E:/hooks/config.schema.json`.
- Tests read `E:/hooks/config.json` directly.

**Why it matters:** A clean clone on Linux, macOS, Windows C: drive, CI, or WSL will fail or inspect the wrong paths.

**Reproduce:** Clone anywhere other than `E:/hooks` and run:

```bash
node _core/validate-runtime-hooks.mjs
python thinking-gate/test-thinking-gate.py
```

**Best fix:** Introduce `HOOKS_HOME` / repo-root resolution. Defaults should be relative to the script/repo root. Keep `HOOKS_CONFIG_PATH` as override.

**Fix size:** Moderate.

### 2. The repo does not include actual Claude/Codex runtime wiring

**Severity:** High
**Category:** runtime failure, missing artifact, DX
**Files:** repo-level omission; `config.json` notes

**What is wrong:** The scripts exist, but the repo does not include the actual hook runtime configuration that would invoke them. The config says selected hooks are wired from live Codex config, but that live config is not in the repo.

**Why it matters:** `config.json` is a registry, not an installer. Without `~/.claude/settings.json`, `.claude/settings.json`, Codex `config.toml`, plugin config, or generated runtime config, the hooks do nothing.

**Reproduce:** Clone repo and run an agent without separate hook settings. None of these scripts are invoked automatically.

**Best fix:** Add:

- `examples/claude/settings.json`
- `examples/codex/config.toml` if Codex supports this hook model
- `scripts/install-hooks.mjs`
- `scripts/doctor.mjs`

The install/doctor should verify that each enabled hook in `config.json` is actually wired.

**Fix size:** Moderate.

### 3. Python shared runtime does not enforce hook event matching

**Severity:** High
**Category:** runtime failure, bad assumption
**File:** `_core/hook_runtime.py`

**What is wrong:** `run()` enforces enabled and `match.tools`, but it never checks `payload.hook_event_name` against the configured `hooks[].event`. It only reads `tool_name` for matching.

**Why it matters:** If external wiring is wrong, a hook can run on the wrong lifecycle event. For example, a `PreToolUse` gate could process a payload that was not actually a `PreToolUse` event, or a disabled/future Stop hook could emit irrelevant output.

**Reproduce:** Pipe a mismatched payload into a Python hook with a tool name that passes `match.tools`.

**Best fix:**

```python
def matches_event(hcfg: dict, event_name: str) -> bool:
    expected = hcfg.get("event")
    if not expected:
        return True
    events = expected if isinstance(expected, list) else [expected]
    return event_name in events
```

Then in `run()`:

```python
event_name = payload.get("hook_event_name", "")
if event_name and not matches_event(hcfg, event_name):
    sys.exit(EXIT_ALLOW)
```

Also add tests for event mismatch.

**Fix size:** Simple.

### 4. Missing hook config silently becomes enabled defaults

**Severity:** Medium
**Category:** runtime failure, config drift
**File:** `_core/hook_runtime.py`

**What is wrong:** `hook_cfg()` returns `{}` when a hook ID is missing. `is_enabled({})` returns `True`, and `fail_policy({})` returns `"open"`.

**Why it matters:** If a hook script is invoked but its config entry is absent, it can run with fallback defaults. For central config, absent should usually mean disabled or configuration error.

**Reproduce:** Remove `loop-safety` from config and invoke `loop-guard.py`.

**Best fix:** Decide contract:

- Safer default: missing hook config -> no-op with stderr warning.
- Strict mode: missing hook config -> fail according to global policy.

I recommend no-op by default:

```python
hcfg = hook_cfg(config, hook_id)
if not hcfg:
    print(f"[{hook_id}] missing config entry; disabled", file=sys.stderr)
    sys.exit(EXIT_ALLOW)
```

**Fix size:** Simple.

### 5. Telemetry dependency validation is logically incomplete

**Severity:** High
**Category:** config validation bug
**File:** `_core/config-model.mjs`

**What is wrong:** Validators for telemetry-dependent hooks only fail when telemetry exists and is explicitly disabled. They do **not** fail when telemetry is missing entirely.

Current pattern:

```js
const tel = hookById(config, 'hook-telemetry');
pushIf(errors, !(hook.enabled === true && isObject(tel) && tel.enabled === false), ...)
```

This passes when `tel` is not an object.

**Why it matters:** `thinking-gate`, `loop-safety`, and `browser-verify-gate` depend on `hook_events`. Missing telemetry should be a validation error when those gates are enabled.

**Reproduce:** Remove `hook-telemetry` from config while leaving `thinking-gate` enabled; run validator.

**Best fix:**

```js
if (hook.enabled === true) {
  pushIf(errors, isObject(tel) && tel.enabled === true, `${hook.id}.enabled requires hook-telemetry.enabled`);
}
```

Also validate telemetry has `PostToolUse` event and broad enough match.

**Fix size:** Simple.

### 6. `memory-normalizer.settings.writes.memoryTable` is declared but ignored

**Severity:** High
**Category:** config drift
**File:** `memory-normalizer/normalize-after-store.py`

**What is wrong:** Config declares:

```json
"writes": {
  "memoryTable": "memories",
  "columns": ["tags", "memory_type", "metadata", "updated_at", "updated_at_iso"]
}
```

But runtime hardcodes `memories` in queries and updates. The `UPDATE` statement directly targets `memories` and fixed columns.

**Why it matters:** The config looks more flexible than the code is. Changing `memoryTable` or `columns` would not do what the config implies.

**Reproduce:** Set `memory-normalizer.settings.writes.memoryTable` to another valid table and run the hook. It still queries/updates `memories`.

**Best fix:** Either:

- Use `settings.writes.memoryTable` via `safe_table`, and validate required columns exist, or
- Remove `memoryTable` / `columns` from stable config and make the fixed table explicit.

I recommend using the table setting but keeping the columns fixed until there is a real need for dynamic column mutation.

**Fix size:** Moderate.

### 7. Quality manifest omits implemented hook directories

**Severity:** High
**Category:** config drift, runtime failure
**File:** `quality-completion-gate/quality-verify-manifest.json`

**What is wrong:** The `hooks` repo domain includes many runtime directories, but omits `browser-verify-gate/` and `frontend-design-gate/`. The same manifest still runs tests/compile checks for browser gate files.

**Why it matters:** The `hooks` repo has `blockOnUnmatched: true`. If quality gate is enabled, changes inside those directories can be treated as unmatched and block completion for the wrong reason.

**Reproduce:** Enable quality gate, modify `browser-verify-gate/browser-verify-gate.py`, run Stop gate in the hooks repo.

**Best fix:** Add:

```json
"browser-verify-gate/",
"frontend-design-gate/"
```

to the `hooks.runtime.paths.prefixes` list.

**Fix size:** Simple.

### 8. Node runtime does not match Python runtime semantics

**Severity:** Medium
**Category:** maintainability, config drift
**Files:** `quality-completion-gate/quality-gate-core.mjs`, `inject-protocol/inject-protocol.mjs`

**What is wrong:** Python hooks use `_core/hook_runtime.py`; Node hooks use ad hoc runtimes. `quality-gate-core.mjs` loads config and checks `enabled`, but it does not enforce event, match, or failPolicy.

**Why it matters:** Same config keys mean different things depending on runtime language.

**Reproduce:** Set `quality-completion-gate.failPolicy = "closed"` and trigger a runtime error. It still fails open.

**Best fix:** Add `_core/hook-runtime.mjs` with parity:

- load config
- find hook config
- enabled check
- event check
- matcher check where relevant
- failPolicy behavior
- standard debug/error output

**Fix size:** Moderate.

### 9. `hooks[].scope` is not enforced

**Severity:** Medium
**Category:** config drift
**Files:** config + runtimes

**What is wrong:** Every hook has `scope.projects` and `scope.paths`, but I found no runtime enforcement of these fields.

**Why it matters:** Operators may believe hooks are scoped when they are not. That is especially risky for gates.

**Reproduce:** Set a hook scope to a project that does not match cwd. Invoke hook. It still runs if the external runtime invokes it.

**Best fix:** Implement scope filtering in shared runtimes:

- detect project from cwd
- match configured projects
- match path globs if payload includes file path or cwd

Or mark scope as metadata-only.

**Fix size:** Moderate.

### 10. Tests are useful but not portable

**Severity:** Medium
**Category:** DX, CI failure
**Files:** most tests

**What is wrong:** Many tests hardcode `E:/hooks`, read live config, and expect live memory DBs. These tests are more like local smoke tests than CI-grade verification.

**Why it matters:** These tests are more like local smoke tests than CI-grade verification.

**Reproduce:** Run tests from any non-`E:/hooks` checkout.

**Best fix:** Add test fixtures and derive repo root from test file location. Always set `HOOKS_CONFIG_PATH` to a temp config.

**Fix size:** Moderate.

### 11. `quality-completion-gate` executes manifest command strings through a shell

**Severity:** Medium
**Category:** security, portability
**File:** `quality-completion-gate/quality-gate-core.mjs`

**What is wrong:** Manifest commands are run via `execSync(command.command)`, which invokes a shell.

**Why it matters:** If the manifest becomes user-editable or generated from unsafe input, this is command injection. It also behaves differently across Windows shells, Bash, PowerShell, and CI.

**Reproduce:** Put shell metacharacters in a manifest command.

**Best fix:** Prefer:

```json
{ "cmd": "pnpm", "args": ["run", "ci:contracts"] }
```

Keep string commands only behind `"shell": true`.

**Fix size:** Moderate.

### 12. Frontend design gate ignores shared git timeout

**Severity:** Low
**Category:** config drift
**File:** `frontend-design-gate/frontend-design-gate.py`

**What is wrong:** `_git()` uses a hardcoded `timeout=5` instead of `shared.runtime.gitTimeoutMs`.

**Why it matters:** Large repos or slow Windows git calls may fail open unpredictably.

**Reproduce:** Run frontend gate in a slow repo.

**Best fix:** Pass configured timeout into git helpers.

**Fix size:** Simple.

### 13. Browser verify state collides when `session_id` is missing

**Severity:** Low
**Category:** runtime edge case
**File:** `browser-verify-gate/browser-verify-gate.py`

**What is wrong:** State file key hashes only `session_id`; missing session IDs all hash the empty string.

**Why it matters:** Multiple no-session invocations can share state.

**Reproduce:** Invoke Stop payloads without `session_id`.

**Best fix:** Use session ID if present, else hash cwd/repo root/transcript path.

**Fix size:** Simple.

### 14. Duplicate project detection logic exists in multiple languages/files

**Severity:** Low
**Category:** maintainability
**Files:** `_core/hook_runtime.py`, `inject-protocol/inject-core.mjs`, `memory-normalizer/memory_retain.py`

**What is wrong:** Project detection logic is duplicated in Python and Node.

**Why it matters:** Minor fixes can drift between runtimes.

**Best fix:** Add explicit conformance tests with shared fixtures, or generate project-detection fixtures consumed by both Python and Node.

**Fix size:** Simple.

---

## 6. Test and Verification Plan

### Existing tests

The repo already has a meaningful test suite:

- `_core/test-hook-runtime.py` tests read-only SQLite behavior.
- `quality-completion-gate/test-config-model.mjs` tests config validator semantics.
- `inject-protocol/test-inject-protocol-core.mjs` tests project detection and output capping.
- `hook-telemetry/test-log-event.py` tests structural status classification and disabled behavior.
- `thinking-gate/test-thinking-gate.py` tests planning grants, bootstrap tools, stale grants, failed grants, and consumption migration.
- `loop-safety/test-loop-guard.py` tests soft/hard thresholds, reset on success, subcommands, edit targets, and session isolation.
- `browser-verify-gate/test-browser-verify-gate.py` tests large/small turn behavior, browser verification, loop release, missing DB.
- `frontend-design-gate/test-frontend-design-gate.py` tests comment/string false positives, multiline JSX, backlog exclusion, and inventory gating.

The main weakness is **portability**, not test intent.

### Minimum command suite, current layout

Assuming the repo is installed at `E:/hooks`:

```bash
cd E:/hooks

node _core/validate-runtime-hooks.mjs
node quality-completion-gate/test-config-model.mjs
node inject-protocol/test-inject-protocol-core.mjs
node inject-protocol/test-inject-protocol-self-test.mjs
node quality-completion-gate/test-quality-gate-core.mjs

python _core/test-hook-runtime.py
python hook-telemetry/test-log-event.py
python thinking-gate/test-thinking-gate.py
python loop-safety/test-loop-guard.py
python memory-normalizer/test-memory-runtime.py
python memory-normalizer/normalize-after-store.py --self-test
python inject-protocol/test-recall-readonly.py
python inject-protocol/test-suggest-readonly.py
python inject-protocol/test-index-skills.py
python browser-verify-gate/test-browser-verify-gate.py
python frontend-design-gate/test-frontend-design-gate.py
```

### Minimal verification suite to add

Add a portable test runner:

```bash
node tests/run-all.mjs
```

That runner should create temp configs and set `HOOKS_CONFIG_PATH`.

Required tests:

| Area | Test |
|---|---|
| Config loading | Valid config loads from temp path. |
| Missing config | Each hook exits `0`, emits predictable stderr, no side effects. |
| Invalid config | `inject-protocol` exits `0` with config error; validator exits nonzero. |
| Unknown config keys | Validator rejects non-`_` unknown root keys and hook-specific unknown settings where schema supports it. |
| Missing hook entry | Hook should no-op or emit clear warning; define this contract. |
| Disabled hook | stdout empty, exit `0`, no DB writes. |
| Event mismatch | A `PostToolUse` payload sent to `PreToolUse` hook no-ops. |
| Payload parsing | Valid JSON, empty stdin, malformed JSON, BOM-prefixed JSON. |
| `UserPromptSubmit` | Prompt with enough terms emits protocol + optional diagnostics; no prompt emits only protocol. |
| `PostToolUse` telemetry | Success, failure, structured error, PostToolUseFailure. |
| `PreToolUse` thinking gate | Missing grant denies; fresh grant allows; exhausted/stale/failed grant denies. |
| `PreToolUse` loop safety | Soft/hard thresholds; success resets; different error breaks chain. |
| `PostToolUse` memory normalizer | Resolves by ID/hash/content; skips failed calls; audit-on-error. |
| `Stop` quality gate | No changes allow; unmatched block; command failure block; repeated failure release. |
| `Stop` browser gate | Missing DB allow; large no browser block; verified allow. |
| `Stop` frontend gate | Added raw primitive blocks; existing backlog ignored; components/ui ignored. |
| Cross-platform paths | Windows-style path strings on POSIX, POSIX paths on Windows, paths with spaces. |
| Stdout/stderr/exit | Snapshot expected stdout JSON, stderr, and exit code for every hook. |
| Idempotency | Telemetry append expected; memory normalizer second run skips; quality state resets after pass. |

---

## 7. Optimization Opportunities

### Must fix now

1. **Make runtime root portable.**
   Replace committed `E:/hooks` assumptions with `HOOKS_HOME`, `HOOKS_CONFIG_PATH`, and repo-relative defaults.

2. **Add runtime wiring templates or installer.**
   A central config is not enough. Add generated Claude/Codex wiring examples and a doctor command.

3. **Enforce event matching in Python and Node runtimes.**
   `hooks[].event` should be a runtime contract, not only a validator field.

4. **Fix telemetry dependency validation.**
   Enabled gates that read telemetry should require enabled telemetry.

5. **Fix quality manifest directory drift.**
   Add `browser-verify-gate/` and `frontend-design-gate/`.

6. **Resolve `memory-normalizer.settings.writes` drift.**
   Either use `memoryTable` / `columns` or remove them from stable config.

### Good next improvements

1. **Add `_core/hook-runtime.mjs`.**
   Bring Node hooks to parity with Python hooks.

2. **Make tests hermetic.**
   Use temp config, temp DBs, temp repos, repo-relative script paths.

3. **Strengthen `config.schema.json`.**
   Add hook-specific `$defs` for every known hook, not only `inject-protocol`.

4. **Introduce shared fixtures.**
   Add `tests/fixtures/payloads/*.json` for Claude/Codex sample payloads.

5. **Centralize tool groups.**
   Memory tool names, thinking tool aliases, edit family, browser tool patterns should be named groups in config or generated constants.

6. **Add `doctor` command.**
   Verify config, schema freshness, path existence, DB presence, hook wiring, executable availability, and sample payload behavior.

7. **Normalize command manifests.**
   Move from shell strings to `{cmd,args}` arrays with optional `shell: true`.

### Optional later cleanup

1. Replace frontend regex scanning with AST/TSX parser if false positives become expensive.
2. Add telemetry duration extraction if actual payloads contain timing.
3. Add dry-run modes for all gate hooks.
4. Add structured debug logs for every hook with `HOOK_DEBUG=1`.
5. Add config migrations for `version`.
6. Add generated docs from `config.json`.

---

## 8. Situational Hook Suggestions

Only a few additional hooks are worth adding. The repo already has enough hooks; the bigger need is consistency and verification.

| Hook name | Trigger | Purpose | Example behavior | Required config keys | Risk | Now or later |
|---|---|---|---|---|---|---|
| `config-consistency-gate` | `Stop` or `PostToolUse` for edits to `config.json`, schema, hook scripts | Prevent config/schema/runtime drift | If config changed, require validator + schema regeneration + relevant tests | `watchedFiles`, `requiredCommands`, `maxRepeatedBlocks` | Low; overlaps with quality gate | **Now**, preferably as quality manifest coverage rather than a separate hook |
| `runtime-wiring-doctor` | Manual script, maybe `SessionStart` warning | Verify enabled hooks are actually wired in Claude/Codex config | Warn if `config.json` enables `thinking-gate` but Claude settings do not invoke it | `runtimeConfigs`, `enabledHookIds`, `strict` | Low | **Now** |
| `source-grounding-gate` | `Stop` | Reduce unsupported claims of completion or external facts | Blocks when final answer claims tests passed but no test command telemetry exists | `claimPatterns`, `requiredEvidenceEvents`, `allowManualOverride` | Medium false positives | Later |
| `repo-context-loader` | `SessionStart` / `UserPromptSubmit` | Load repo-specific rules and quality manifest summary | Inject “this repo uses pnpm; run X for frontend changes” | `projectContexts`, `maxChars`, `files` | Low | Later |
| `dangerous-shell-gate` | `PreToolUse` for `Bash` | Prevent destructive shell commands outside safe roots | Deny `rm -rf`, `git reset --hard`, cloud delete commands unless cwd/project allowlisted | `denyPatterns`, `safeRoots`, `overrideToken` | Medium if too aggressive | Later |
| `agent-handoff-audit` | `Stop` | Produce structured summary of changes, tests, blocks, unresolved issues | Append JSONL handoff record to `.state/handoffs` | `stateDir`, `includeGitStatus`, `includeTelemetryWindow` | Low | Later |
| `multi-agent-edit-lock` | `PreToolUse` for edits | Reduce conflicting writes across agents | Warn/block if another session recently edited same file | `lockDb`, `ttlSeconds`, `tools` | Medium complexity | Later |

---

## 9. Recommended Fix Plan

### Immediate Fixes

1. **Add event matching to `_core/hook_runtime.py`.**

- **File:** `_core/hook_runtime.py`
- **Summary:** Add `matches_event`; no-op when `payload.hook_event_name` does not match configured `hooks[].event`.
- **Why:** Prevent wrong-event execution.
- **Risk:** Low. Could reveal miswired external runtime configs.
- **How to test:** Add mismatched payload tests for every Python hook.

2. **Treat missing hook config as disabled.**

- **File:** `_core/hook_runtime.py`
- **Summary:** If `hook_cfg()` returns `{}`, log warning and exit `0`.
- **Why:** Avoid hidden fallback behavior.
- **Risk:** Low.
- **How to test:** Invoke each hook with a config missing its entry.

3. **Fix telemetry dependency validation.**

- **File:** `_core/config-model.mjs`
- **Summary:** Enabled telemetry-dependent gates must require `hook-telemetry.enabled === true`.
- **Why:** Prevent impossible gate setups.
- **Risk:** Low.
- **How to test:** Remove telemetry hook and validate config should fail.

4. **Update quality verify manifest prefixes.**

- **File:** `quality-completion-gate/quality-verify-manifest.json`
- **Summary:** Add `browser-verify-gate/` and `frontend-design-gate/` to hooks runtime domain prefixes.
- **Why:** Prevent unmatched-file blocks for implemented hook dirs.
- **Risk:** Low.
- **How to test:** Modify files in those dirs and run quality gate.

5. **Resolve memory normalizer write-table config drift.**

- **File:** `memory-normalizer/normalize-after-store.py`, `config.json`, `_core/config-model.mjs`
- **Summary:** Either use `settings.writes.memoryTable` or remove it. I recommend using it with `safe_table`.
- **Why:** Config should not promise unused flexibility.
- **Risk:** Moderate because DB writes are involved.
- **How to test:** Temp memory DB with a non-default table name if supported, or validator rejects non-default.

6. **Add runtime wiring examples.**

- **Files:** `examples/claude/settings.json`, `examples/codex/config.toml` if applicable, `docs/runtime-wiring.md`
- **Summary:** Show exactly how enabled hooks are invoked.
- **Why:** Without this, the repo is not installable.
- **Risk:** Low.
- **How to test:** Manual dry-run / doctor script.

### Next Improvements

1. **Add `_core/hook-runtime.mjs`.**

- Bring Node hooks to parity with Python: config load, hook lookup, enabled, event, match, failPolicy, debug.

2. **Make validator and generator path-relative.**

- `_core/validate-runtime-hooks.mjs` should resolve schema path from config path or repo root.
- `_core/generate-config-schema.mjs` should default to `./config.schema.json`.

3. **Make tests portable.**

- Replace `Path("E:/hooks")` with repo root detection.
- Use temp config and DBs everywhere.
- Keep one optional local smoke test for real `E:/hooks`.

4. **Strengthen schema.**

- Add `$defs` for telemetry, thinking gate, loop safety, memory normalizer, quality gate, browser gate, frontend gate.
- Make `config.schema.json` a real editor contract, not just a generic shell.

5. **Add fixture payloads.**

Suggested files:

```text
tests/fixtures/payloads/user_prompt_submit.basic.json
tests/fixtures/payloads/pre_tool_use.bash.json
tests/fixtures/payloads/post_tool_use.success.json
tests/fixtures/payloads/post_tool_use.failure.json
tests/fixtures/payloads/stop.basic.json
```

6. **Add `scripts/doctor.mjs`.**

Checks:

- Config loads.
- Schema current.
- Enabled scripts exist.
- Required DB paths exist or can be initialized.
- External hook runtime config is present.
- Sample payloads produce expected stdout/exit.

### Later / Optional

1. Convert shell command strings in quality manifest to argv arrays.
2. Add cross-runtime conformance fixtures for project detection.
3. Add `HOOK_DEBUG` structured logs to Python hooks.
4. Add AST-based frontend detection if regex false positives become frequent.
5. Generate human docs from `config.json`.
6. Add optional `SessionStart` context hook after the core system is stable.

---

## 10. Final Recommendation

**Use this repo only after targeted fixes.**

It is not a throwaway prototype; the implementation is real. The telemetry substrate, thinking grant system, retry breaker, memory normalizer, and Stop gates are thoughtfully designed and have meaningful tests. The repo is closest to “ready” on a single Windows machine where `E:/hooks` is the canonical install path.

But as a configurable hook system for agent/workflow behavior, it needs a tightening pass before it should be treated as stable infrastructure.

**Decision: needs targeted fixes, not a full rewrite.**

The cleanest path is:

1. Keep the current directory shape.
2. Add shared Node runtime parity.
3. Make path resolution portable.
4. Enforce event matching.
5. Fix config drift.
6. Add runtime wiring artifacts.
7. Convert local tests into portable fixture-based tests.

After those changes, this can become a solid hook control plane. Without them, it remains a strong local setup with hidden assumptions.
