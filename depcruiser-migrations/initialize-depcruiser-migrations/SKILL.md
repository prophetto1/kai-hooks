---
name: initialize-depcruiser-migrations
description: >-
  Initialize a depcruiser-driven migration — extract a specific frontend page/entry and its
  TypeScript import-closure out of a donor repo and set it up to be ported into a target repo.
  Use when the user wants to migrate, port, extract, or "slice" a page/route/component (and
  everything it transitively imports) from one codebase into another. Triggers: "migrate this
  page from <repo>", "port <page> into <repo>", "extract this component into my app", "start /
  initialize a depcruiser migration", "slice <entry> out of <donor>". This skill sets up the
  trace + closure manifest so the closure-gate can enforce the port; it does NOT itself port code.
---

# initialize-depcruiser-migrations

Stands up one migration: trace a donor page's import closure, write the closure manifest, and arm
the gate. This skill performs steps 0–5 below. It does **not** port code — after it runs, the worker
adjudicates verdicts and ports, the closure-gate enforces order, and quality-completion-gate verifies
the result.

Bundle home: `E:/hooks/depcruiser-migrations/`. Scripts and the `closure-gate` hook live here;
per-migration artifacts land in `manifests/<name>/`.

## 0. Gather before doing anything
Ask the user and do not proceed until you have all four. The closure is computed from a single
entry file — a repo alone is not enough.
- **donor repo** — absolute path to the source codebase.
- **donor entry** — the specific file to migrate, repo-relative (e.g. `src/routes/conversation.tsx`).
  A page / route / component entry, not "the repo."
- **target repo** — absolute path to the destination codebase.
- **target landing** — where the entry lands in the target (so verdicts can carry `target_path`,
  which the completion-side reconcile depends on).

Pick a short `<name>` for the migration (e.g. `conversation-page`). Every path below keys off it.

## 1. Ensure dependency-cruiser is installed in BOTH repos
The donor needs it to trace (step 3); the target needs it for the completion-side rule check (and
uses its own `tsc` for the typecheck). For each repo, only if `dependency-cruiser` is not already a
devDependency, install it with that repo's package manager (detect by lockfile):
- `pnpm-lock.yaml` → `pnpm add -D dependency-cruiser`
- `package-lock.json` → `npm i -D dependency-cruiser`
- `yarn.lock` → `yarn add -D dependency-cruiser`

Do not reinstall if it is already present.

## 2. Create the artifact dir
```
mkdir -p E:/hooks/depcruiser-migrations/manifests/<name>
```

## 3. Trace the donor closure
Run from the **donor repo root** (so its tsconfig and node_modules resolve), redirect output to the
bundle:
```
npx depcruise --no-config --output-type json --ts-config <donor-tsconfig> --ts-pre-compilation-deps <donor-entry> > E:/hooks/depcruiser-migrations/manifests/<name>/before-edit.donor.json
```
- `--ts-pre-compilation-deps` is **required**, or type-only imports silently drop from the closure.
- `--no-config` because you are extracting someone else's tree, not enforcing rules on it.
- `<donor-tsconfig>` is the donor's tsconfig that carries its path aliases (often `tsconfig.json`).

## 4. Generate the closure manifest
```
node E:/hooks/depcruiser-migrations/generate-closure-manifest.mjs E:/hooks/depcruiser-migrations/manifests/<name>/before-edit.donor.json E:/hooks/depcruiser-migrations/manifests/<name>/<name>.source-manifest.json --entry <donor-entry>
```
This writes every node with `verdict: "TBD"`, plus a leaves-first `port_order`, `imported_by`,
`reachable_via` (value / type-only / dynamic), `external_deps`, and `unresolved`. If it reports
unresolved donor imports, surface them to the user — those are closure edges depcruise could not
follow and usually need an adapter or a missing tsconfig path.

## 5. Arm the gate
Arming sets `settings.active.name = "<name>"` on the `closure-gate` entry in `E:/hooks/config.json`.
**config.json is the operator's lock domain — the worker does not edit it.** Emit this for the
operator to apply, then stop:
```
config.json → hooks[id=closure-gate].settings.active.name = "<name>"
(optional: settings.active.targetGlob to scope which edits are guarded)
```
Once arming moves to the `.state/` substrate this becomes worker-writable; until then it is a handoff.

## After initialization — what the worker does next (NOT this skill)
1. **Adjudicate**: in `<name>.source-manifest.json`, set every node's `verdict` to
   `port | adapter | cut` (and `target_path` for port/adapter). The gate blocks edits to the target
   until zero nodes are `TBD`.
2. **Port** in `port_order` (leaves first, so you never reference a file you haven't created yet),
   following each verdict.
3. **Finish**: quality-completion-gate's `closure` domain runs depcruise rules + `tsc --noEmit` +
   reconcile (`target == donor − cuts + adapters`) in the target repo — exit-code authority.
4. **Disarm** (`active.name` → null); knip sweep before merge.
