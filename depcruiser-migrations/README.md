# depcruiser-migrations

Self-contained bundle for depcruiser-driven page migration — extracting a frontend page/entry
and its TypeScript import-closure out of a donor repo into a target repo. Lives under `E:/hooks/`
for now because there's no separate plugin dir yet.

Dir name = the job (migration). Internal files keep `closure-*` names because they're mechanism-
accurate: the gate checks the import **closure**, the manifest **is** one. The hook id is still
`closure-gate` (= filename), unchanged by the rename.

## What's in here
- `initialize-depcruiser-migrations/SKILL.md` — agent-facing how-to: inquire → install → trace →
  generate → arm. This is what a worker invokes to start a migration.
- `closure-gate.mjs` — the PreToolUse gate (JSON decision, exits 0, fail-open).
- `closure-gate-core.mjs` — framework primitives (mirrors `quality-gate-core.mjs`) + closure helpers.
- `generate-closure-manifest.mjs` — donor depcruise trace → `<name>.source-manifest.json` (verdicts start `TBD`).
- `validate-closure-manifest.mjs` — `--mode verdicts` (the gate calls this) and `--mode reconcile` (the quality gate calls this).
- `dependency-cruiser.cjs` — rule config for the target trace (no-circular, no-unresolvable, scaffold ban).
- `closure-gate.register.json` — DRAFT config.json entry + verify-manifest domain. Not live until merged.
- `manifests/<name>/` — generated artifacts land here (donor trace, manifest, target trace).

## What the gate does
Before an edit to the armed migration's target page, the gate requires that the page's import
closure has been traced and every node in the closure manifest carries a verdict
(`port` / `adapter` / `cut`). No manifest, or any node still `TBD` → the edit is denied. The graph
work is dependency-cruiser only (a strict superset of madge); `--ts-pre-compilation-deps` is
required or type-only edges drop from the closure.

## Lifecycle (per migration)
The `initialize-depcruiser-migrations` skill performs steps 1–4. Steps 5+ are the worker's.
1. **Install** dependency-cruiser in donor + target if missing (per-repo devDependency).
2. **Trace donor**, run from the donor repo so its tsconfig + node_modules resolve, output to the bundle:
   `npx depcruise --no-config --output-type json --ts-config <donor-tsconfig> --ts-pre-compilation-deps <donor-entry> > E:/hooks/depcruiser-migrations/manifests/<name>/before-edit.donor.json`
3. **Generate**:
   `node E:/hooks/depcruiser-migrations/generate-closure-manifest.mjs E:/hooks/depcruiser-migrations/manifests/<name>/before-edit.donor.json E:/hooks/depcruiser-migrations/manifests/<name>/<name>.source-manifest.json --entry <donor-entry>`
4. **Arm**: set `settings.active.name` (+ optional `targetGlob`) on the config.json entry. (Operator lock step for now; see below.)
5. Fill every verdict in the manifest → gate stops blocking → port in `port_order` (leaves first).
6. Completion is enforced by `quality-completion-gate` via the `closure` verify-manifest domain
   (depcruise rules, `tsc --noEmit`, reconcile) — all exit-code authority.
7. Disarm (`active.name` → null); knip sweep before merge.

## To go live (Jon's lock steps — not done by the agent)
- Merge `closure-gate.register.json#hookEntry` into `config.json` `hooks[]`, regenerate
  `config.schema.json` from `_core/config-model.mjs`, run `_core/validate-runtime-hooks.mjs`.
- Add `closure-gate.register.json#verifyManifestDomain` to the target repo in
  `quality-completion-gate/quality-verify-manifest.json`.
- Add this bundle path to the skill-indexer `scanRoots`, or `initialize-depcruiser-migrations`
  won't be discoverable to invoke.
- Flip the entry `enabled: true`.

## Known follow-ups
- **Arming is a config.json edit (operator lock domain).** The skill emits the arm line for the
  operator rather than self-arming. Moving `active.name` to the `.state/` substrate would make it
  worker-writable (true one-command initiate) — pending a read of the existing `.state/` schema to
  avoid contract drift.
