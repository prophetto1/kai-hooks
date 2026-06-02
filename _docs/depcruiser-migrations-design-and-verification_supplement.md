# depcruiser-migrations - Supplement

Status: supplement to `depcruiser-migrations-design-and-verification.md`.

This document does not replace the base plan. It records corrections and more specific proposed implementations for the issues found during follow-up review. The base plan was produced by an outside worker, so direct conflicts should be corrected explicitly rather than inferred away.

## 1. Alignment Correction: Root Directory And Hook Id

Current base-plan state:

- Root bundle directory: `E:/hooks/depcruiser-migrations/`
- Draft hook id: `closure-gate`
- Draft hook entrypoint: `depcruiser-migrations/closure-gate.mjs`
- Runtime helper derives hook id from entrypoint filename, so `closure-gate.mjs` looks up `hooks[id="closure-gate"]`.

System direction:

- Root directories under `E:/hooks` should read as hook directories unless they are explicitly shared infrastructure such as `_core/`.
- A root hook directory whose configured hook id is unrelated creates the same kind of naming drift already seen with `telemetry/` vs `hook-telemetry`.

Recommended correction:

Use `depcruiser-migrations` as the hook id and root directory name. Rename the hook entrypoint to match the id:

```text
E:/hooks/depcruiser-migrations/depcruiser-migrations.mjs
E:/hooks/depcruiser-migrations/closure-gate-core.mjs
```

Keep `closure` wording for internal concepts where it is mechanism-accurate: closure manifest, closure reconcile, closure verdicts. The hook package is the migration control plane; the pre-edit closure gate is one behavior inside it.

Config shape:

```json
{
  "id": "depcruiser-migrations",
  "name": "Depcruiser Migration Gate",
  "category": "gate",
  "event": "PreToolUse",
  "match": { "tools": ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"] },
  "script": { "path": "depcruiser-migrations/depcruiser-migrations.mjs", "runtime": "node" },
  "enabled": false,
  "failPolicy": "open"
}
```

Why this is preferred:

- It preserves the outside worker's root bundle name.
- It removes the root-dir/hook-id mismatch.
- It avoids a future operator wondering whether `depcruiser-migrations/` is a hook, a docs bundle, or a generic scripts directory.
- It keeps one hook directory with all related files, matching the current `E:/hooks` cleanup direction.

Required code impact:

- Rename `closure-gate.mjs` to `depcruiser-migrations.mjs`, or update the runtime helper to accept an explicit id. Renaming is simpler and preserves the existing id-from-filename convention.
- Update `closure-gate.register.json`, `README.md`, and quality gate commands to reference the new entrypoint.
- Update any output strings from `[closure-gate]` to `[depcruiser-migrations]` unless the message is specifically about closure verdicts.

## 2. Skill Path Correction

Current verified skill path:

```text
E:/hooks/depcruiser-migrations/initialize-depcruiser-migrations/SKILL.md
```

This file exists inside the hook bundle. Any review note or implementation step claiming the skill is at the bundle root should be corrected.

Recommended discovery wiring:

- Add `E:/hooks/depcruiser-migrations` to `skill-indexer.settings.scanRoots`.
- Keep the nested skill path as-is. The indexer recursively scans `**/SKILL.md`, so the nested path is valid.
- Replace the stale `skills-catalog.md` entry `install-closure-tooling` with `initialize-depcruiser-migrations`.
- Run the skill indexer after catalog and scan-root changes.

No file move is required for the skill.

## 3. Stronger Reconcile Design

Current weakness:

`validate-closure-manifest.mjs --mode reconcile` compares basenames only, and it warns rather than blocks when:

- a module marked `cut` is still present in the target trace;
- the target closure contains unexpected local modules.

This is too weak for a completion gate. A completion gate should fail on unadjudicated structural drift, not log it as advisory text.

### 3.1 Recommended Reconcile Contract

Reconcile should compare normalized repo-relative paths, never basenames.

For every donor module:

- `verdict: "port"` requires `target_path` and requires that exact normalized target path to appear in the target closure.
- `verdict: "adapter"` requires `target_path` and requires that exact normalized target path to appear in the target closure.
- `verdict: "cut"` requires that no banned target path for that donor module appears in the target closure.

For every target-local module in the traced target closure:

- it must be one of the expected `port` or `adapter` target paths; or
- it must be explicitly listed in a manifest-level `target_extras` allowlist with a reason.

Anything else is a blocking failure.

### 3.2 Manifest Extension

Add a `target_extras` array for target-native modules that are intentionally in the target closure but do not map to a donor module.

Example:

```json
{
  "target_extras": [
    {
      "path": "src/app/router.tsx",
      "reason": "target app shell imports the ported route"
    },
    {
      "path": "src/lib/chattr-session-adapter.ts",
      "reason": "target runtime adapter"
    }
  ]
}
```

Rules:

- `target_extras[].path` must be repo-relative.
- It must not be absolute.
- It must not contain `..`.
- Each extra must have a non-empty reason.
- Extras are allowed only in the target closure; they do not relax donor verdict requirements.

### 3.3 Reconcile Algorithm

Inputs:

- `--manifest <source-manifest.json>`
- `--target <target.depcruise.json>`
- optional `--target-root <absolute repo root>`
- optional `--target-prefix <repo-relative prefix>` repeated or comma-separated

Algorithm:

1. Load the manifest and target depcruise JSON.
2. Normalize every path to repo-relative POSIX form:
   - replace backslashes with `/`;
   - strip leading `./`;
   - strip `targetRoot` prefix if an absolute path is provided;
   - reject paths containing `..`;
   - reject paths outside the target root.
3. Validate manifest invariants:
   - every `port` and `adapter` module has `target_path`;
   - no duplicate `target_path` across `port` and `adapter`;
   - every `target_path` is inside the approved target prefix;
   - every verdict is one of `port`, `adapter`, `cut`;
   - every `target_extras[].path` has a reason and is inside the approved target prefix.
4. Build `expectedPresent` from `port` and `adapter` target paths.
5. Build `allowedExtras` from `target_extras`.
6. Build `targetLocal` from `target.modules[].source`, restricted to local file extensions.
7. Fail if any `expectedPresent` path is missing from `targetLocal`.
8. Fail if any `cut` module is present in `targetLocal` at a banned path.
9. Fail if any target-local module is neither expected nor allowed.
10. Fail if `target.summary.error > 0` when the target JSON comes from dependency-cruiser JSON mode.
11. Print a concise pass/fail summary and exit non-zero on every blocking issue.

### 3.4 Cut Handling

The original donor `source` path is not always a meaningful target path. Use this cut rule:

- If a `cut` module has `target_path`, treat that as the banned target path.
- If a `cut` module has `banned_target_paths`, block any of those.
- If neither exists, block a target module only when its normalized path equals the donor `source` path.

Recommended manifest addition for cuts:

```json
{
  "source": "src/legacy/AgentPanel.tsx",
  "verdict": "cut",
  "banned_target_paths": [
    "src/legacy/AgentPanel.tsx",
    "src/components/AgentPanel.tsx"
  ],
  "cut_reason": "replaced by target-native worker panel"
}
```

### 3.5 Required Reconcile Tests

Add tests for:

- missing `port` target path blocks;
- missing `adapter` target path blocks;
- duplicate target paths block;
- unexpected target module blocks;
- unexpected target module listed in `target_extras` passes;
- cut source still present blocks;
- cut banned target path present blocks;
- basename collision does not pass accidentally;
- path traversal in `target_path` blocks;
- dependency-cruiser JSON `summary.error > 0` blocks.

This converts reconcile from advisory comparison into an actual completion gate.

## 4. Correct Target Matching Implementation

Current weakness:

The proposed `active.json` uses `targetGlob`, but current gate code uses substring matching. A value like `apps/web/src/**` will not behave like a glob and can silently fail to guard intended files.

Recommended correction:

Do not use glob semantics unless a real glob library is added and tested. Prefer deterministic prefix and explicit-file matching with no new dependency.

Replace `targetGlob` with:

```json
{
  "targetRoot": "E:/kai-chattr",
  "targetCwd": "E:/kai-chattr/apps/web",
  "targetEntry": "apps/web/src/routes/conversation.tsx",
  "guardedPrefixes": ["apps/web/src/"],
  "guardedFiles": ["apps/web/src/routes/conversation.tsx"]
}
```

### 4.1 Matching Rules

For `Edit`, `Write`, `MultiEdit`, and `NotebookEdit`:

1. Read `tool_input.file_path`.
2. Resolve it to an absolute path:
   - if already absolute, normalize it;
   - if relative, resolve against `payload.cwd` when present, otherwise against `active.targetRoot`.
3. Compute repo-relative path from `active.targetRoot`.
4. If the path is outside `targetRoot`, allow.
5. If the repo-relative path equals any `guardedFiles` entry, guard it.
6. If the repo-relative path starts with any `guardedPrefixes` entry, guard it.
7. Otherwise allow.

For `apply_patch`:

1. Extract file paths from patch headers:
   - `*** Add File: <path>`
   - `*** Update File: <path>`
   - `*** Delete File: <path>`
   - `*** Move to: <path>`
2. Resolve each path using the same rules.
3. If any changed path is guarded, apply the closure verdict gate.
4. If no changed path is guarded, allow.

### 4.2 State Validation For Target Matching

Before matching, validate:

- `targetRoot` is an absolute path.
- `targetCwd` is an absolute path inside `targetRoot`.
- `targetEntry`, `guardedPrefixes`, and `guardedFiles` are repo-relative.
- No guarded path contains `..`.
- `guardedPrefixes` end in `/`.
- `targetEntry` is included in `guardedFiles` or under a guarded prefix.

Invalid active state should produce a deny decision with a repair instruction, not silently allow edits.

## 5. More Specific `.state` Arming Draft

The base plan is right that per-migration arming does not belong in `config.json`. `config.json` is the operator-locked declaration of hooks and scripts. A migration arm is runtime state.

However, `.state` arming must be specified as a control-plane state file, not just a worker-writable JSON blob.

### 5.1 State Directory

Use:

```text
E:/hooks/.state/depcruiser-migrations/
  active.json
  events.jsonl
```

`active.json` is the single active migration grant. `events.jsonl` is the append-only audit log for arm, disarm, replace, validation failure, and completion events.

### 5.2 `active.json` Schema

Recommended shape:

```json
{
  "version": 1,
  "status": "armed",
  "name": "conversation-page",
  "repo": "kai-chattr",
  "donorRoot": "E:/kai-chattr/_references/openhands/frontend",
  "donorEntry": "src/routes/conversation.tsx",
  "targetRoot": "E:/kai-chattr",
  "targetCwd": "E:/kai-chattr/apps/web",
  "targetEntry": "apps/web/src/routes/conversation.tsx",
  "guardedPrefixes": ["apps/web/src/"],
  "guardedFiles": ["apps/web/src/routes/conversation.tsx"],
  "manifestDir": "E:/hooks/depcruiser-migrations/manifests/conversation-page",
  "sourceManifest": "E:/hooks/depcruiser-migrations/manifests/conversation-page/conversation-page.source-manifest.json",
  "donorTrace": "E:/hooks/depcruiser-migrations/manifests/conversation-page/before-edit.donor.json",
  "targetTrace": "E:/hooks/depcruiser-migrations/manifests/conversation-page/after-edit.target.json",
  "armedAt": "2026-06-02T00:00:00Z",
  "armedBy": "codex",
  "reason": "Port OpenHands conversation page into kai-chattr",
  "expiresAt": "2026-06-03T00:00:00Z"
}
```

Required fields:

- `version`
- `status`
- `name`
- `repo`
- `donorRoot`
- `donorEntry`
- `targetRoot`
- `targetCwd`
- `targetEntry`
- `guardedPrefixes`
- `manifestDir`
- `sourceManifest`
- `armedAt`
- `armedBy`
- `reason`

Optional fields:

- `guardedFiles`
- `donorTrace`
- `targetTrace`
- `expiresAt`

### 5.3 State Authority

Do not instruct agents to hand-edit `active.json`.

Add small scripts:

```text
depcruiser-migrations/arm-migration.mjs
depcruiser-migrations/disarm-migration.mjs
depcruiser-migrations/validate-active-state.mjs
```

`arm-migration.mjs` must:

- validate all input paths;
- require source manifest path;
- refuse to overwrite an existing armed state unless `--replace` is passed;
- write `active.json` atomically through a temp file and rename;
- append an `arm` event to `events.jsonl`;
- print the armed migration summary.

`disarm-migration.mjs` must:

- append a `disarm` event to `events.jsonl`;
- remove or rewrite `active.json` atomically;
- require a reason.

`validate-active-state.mjs` must:

- validate schema and path constraints;
- exit non-zero on malformed state;
- print the guarded target and manifest paths.

### 5.4 Gate Behavior With State

If `active.json` does not exist:

- allow; no migration is armed.

If `active.json` exists and is valid:

- apply target matching;
- if an edit targets guarded files, require source manifest existence and all verdicts set;
- deny with an actionable reason when manifest or verdicts are incomplete.

If `active.json` exists but is invalid:

- deny edit tools with a repair instruction.

If `active.json` exists but `expiresAt` is in the past:

- deny guarded edits with a message to disarm or renew the migration.

This is stricter than fail-open for malformed state, but it is appropriate because malformed active state means a live guard is ambiguous. Script crashes may still fall under hook `failPolicy: open`; known invalid state should be an intentional deny.

### 5.5 Audit Events

Append JSONL rows like:

```json
{
  "ts": "2026-06-02T00:00:00Z",
  "event": "arm",
  "name": "conversation-page",
  "repo": "kai-chattr",
  "targetEntry": "apps/web/src/routes/conversation.tsx",
  "actor": "codex",
  "reason": "Port OpenHands conversation page into kai-chattr"
}
```

Audit events should be append-only. They are not the source of truth for the active migration; `active.json` is.

### 5.6 Quality Gate Visibility

Because `.state` is outside git and outside the completion-gate matched surface, the live verification command must print state context every time it runs:

- armed migration name;
- target repo;
- target entry;
- source manifest path;
- target trace path;
- reconcile result.

This gives operator-visible evidence even though the arm state itself is runtime state.

## 6. Updated Implementation Sequence

Use this amended sequence before implementation:

1. Align hook package identity:
   - choose `depcruiser-migrations` as hook id;
   - rename entrypoint to `depcruiser-migrations.mjs`;
   - update draft register and README.
2. Fix hooks repo completion matching:
   - replace stale `closure-gate/` prefix with `depcruiser-migrations/`;
   - consider the broader stale prefix sweep separately.
3. Keep skill file where it is:
   - `depcruiser-migrations/initialize-depcruiser-migrations/SKILL.md`;
   - add bundle root to scan roots;
   - update catalog.
4. Implement state scripts:
   - `arm-migration.mjs`;
   - `disarm-migration.mjs`;
   - `validate-active-state.mjs`.
5. Update the gate to read validated `.state/depcruiser-migrations/active.json`.
6. Replace `targetGlob` with `guardedPrefixes` and `guardedFiles`.
7. Implement `verify-active-closure.mjs`.
8. Strengthen `validate-closure-manifest.mjs --mode reconcile` to block on exact path mismatches, cut leftovers, unexpected target nodes, path traversal, duplicate targets, and dependency-cruiser JSON errors.
9. Add tests for state validation, path matching, apply_patch path extraction, and strict reconcile.
10. Only after those pass, make operator-locked config and catalog edits.

## 7. Supplement Verification Checklist

Run after implementing this supplement:

```powershell
node E:/hooks/_core/validate-runtime-hooks.mjs
node --check E:/hooks/depcruiser-migrations/depcruiser-migrations.mjs
node --check E:/hooks/depcruiser-migrations/arm-migration.mjs
node --check E:/hooks/depcruiser-migrations/disarm-migration.mjs
node --check E:/hooks/depcruiser-migrations/validate-active-state.mjs
node --check E:/hooks/depcruiser-migrations/verify-active-closure.mjs
node --check E:/hooks/depcruiser-migrations/validate-closure-manifest.mjs
```

Add and run focused tests:

```powershell
node E:/hooks/depcruiser-migrations/test-active-state.mjs
node E:/hooks/depcruiser-migrations/test-target-matching.mjs
node E:/hooks/depcruiser-migrations/test-closure-reconcile.mjs
```

Minimum expected outcomes:

- unarmed gate allows edits;
- malformed active state denies edit tools;
- valid active state guards exact files and prefixes;
- apply_patch paths are extracted and guarded;
- missing manifest denies guarded edits;
- manifest with `TBD` verdicts denies guarded edits;
- all verdicts set allows guarded edits;
- strict reconcile blocks missing ports, leftover cuts, unexpected target nodes, duplicate target paths, path traversal, and depcruise JSON errors;
- strict reconcile allows declared `target_extras`.

