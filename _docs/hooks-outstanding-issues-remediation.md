# Hooks System — Outstanding Issues & Remediation (Dev Instructions)

Date: 2026-06-05
Author: Claude (systematic-debugging + waza-hunt verification pass)
Scope: live `E:/hooks` code only. Every item below was confirmed against current source — not assumed. Plan-level findings (the two-tier telemetry plan) are tracked separately in `_docs/two-tier-telemetry-implementation-plan-evaluation.md` and are NOT in the running system yet.

Protocol reminder: one production file at a time, TDD (RED → GREEN), verify with the full suite + `node _core/validate-runtime-hooks.mjs` after each slice.

## Resolution status — 2026-06-05 (all patched & verified)

- **Issue 1 (index-skills.py non-atomic rebuild): RESOLVED.** Atomic `BEGIN IMMEDIATE` build with rollback-on-error, `--dry-run`, and a zero-collected data-loss guard; `HOOKS_CONFIG_PATH` now honored for sandboxing. New `inject-protocol/test-index-skills.py` (RED→GREEN) wired into the manifest.
- **Issue 2 (hook-telemetry untested): RESOLVED.** New `hook-telemetry/test-log-event.py` covers structural status classification, PostToolUseFailure, the no-text-scan guarantee, disabled gating, and detail truncation; wired into the manifest.
- **Issue 3 (recall.py/suggest.py duplication): RESOLVED BY REMOVAL.** The entire `inject-protocol-complex` profile was retired (config.json hook, config-model validator + schema enum, tests, manifest refs, and the directory). One canonical injector remains, so the helpers are no longer duplicated.
- Minor items (injector self-test `.state` write, maintenance-tool guardrails, deliberately shallow shell parsing) remain as previously noted — low priority / accepted.

---

## Already resolved — no action needed (verified)

| Area | Status | Evidence |
|---|---|---|
| loop-safety throws on missing `hook_events` table | Fixed | `loop-safety/loop-guard.py:136` `_table_exists`, `:146` guard; `test-loop-guard.py` covers it |
| Duplicate validator script entry in `config.json` | Fixed | only `"id": "runtime-hooks-validator"` remains (`config.json:490`); `validate-runtime-hooks` id removed |
| Empty orphan `governance-gate/` | Removed | `ls governance-gate` → not found |
| depcruiser bundle / manifest / catalog references | Retired | manifest prefixes + `skills-catalog.md` entry removed; dedicated docs `git rm`'d (2 historical _docs plans still mention it by design) |

---

## ISSUE 1 — `index-skills.py` rebuilds the live skills index non-atomically (data-loss window)

**Severity:** Significant (manual tool, but mutates the live memory DB consumed by the inject hooks)

**Status:** Confirmed present.

**Evidence (`inject-protocol/index-skills.py`):**
- `:219` `conn = sqlite3.connect(DB)` (DB = live `shared.paths.memoryDb`)
- `:220` `DROP TABLE IF EXISTS skills`
- `:221` `DROP TABLE IF EXISTS skills_fts`
- `:222` / `:233` recreate `skills` + `skills_fts`
- `:235-243` insert loop, `:244` single `conn.commit()`
- `:253` only `--list` is handled; there is **no `--dry-run`**

**Why it matters:** Python's `sqlite3` is not in autocommit for DML, but the `DROP`/`CREATE` DDL at `:220-233` runs before any `INSERT` opens a transaction — so the **DROPs commit immediately**, then the rows are inserted in a separate transaction committed at `:244`. If the process is interrupted (crash, Ctrl-C, timeout) any time between the DROP and the final commit, `skills`/`skills_fts` are left **empty but present**. The inject hooks' `suggest.py` then returns zero skills until a clean rerun, with no error surfaced. There is also a brief empty-table window on every successful run during which a concurrent inject read sees no skills.

What the script already does well (keep these): it aborts **before** touching the DB when the curated allowlist is empty (`:206-208`) or no scan roots exist (`:210-214`).

**Resolution (build-then-swap, atomic):**
1. Collect skills into memory first (already done at `:216`).
2. Build into temp tables `skills_new` / `skills_fts_new`, populate them, then swap inside **one explicit transaction**:
   ```
   conn.execute("BEGIN IMMEDIATE")
   # create skills_new / skills_fts_new, insert all rows
   conn.execute("DROP TABLE IF EXISTS skills")
   conn.execute("DROP TABLE IF EXISTS skills_fts")
   conn.execute("ALTER TABLE skills_new RENAME TO skills")
   conn.execute("ALTER TABLE skills_fts_new RENAME TO skills_fts")
   conn.commit()
   ```
   This guarantees readers always see the old tables until the swap, and a crash rolls back to the old data (never empty).
3. Add `--dry-run`: run `collect()` + print the by-source / indexed / missing report and exit **without** opening a write connection (use `connect_readonly` only if you must read).
4. On any exception during the build, `conn.rollback()` and exit non-zero with a clear message; never leave the live tables dropped.

**Verification (new `inject-protocol/test-index-skills.py`, subprocess harness like `thinking-gate/test-thinking-gate.py`):**
- temp `memoryDb` + temp scan root with 2-3 fixture `SKILL.md` files + a temp `skills-catalog.md` allowlist via `HOOKS_CONFIG_PATH`.
- assert `--dry-run` reports counts and leaves the DB unchanged (no `skills` table created if absent; existing rows untouched).
- assert a normal run populates `skills`/`skills_fts`.
- assert a simulated mid-build failure leaves the **previous** `skills` rows intact (inject a forced error before the swap; confirm old data survives).

---

## ISSUE 2 — `hook-telemetry/log-event.py` has no dedicated test

**Severity:** Significant (telemetry is the load-bearing substrate `loop-safety` counts; its own docstring says so)

**Status:** Confirmed present.

**Evidence:** `ls hook-telemetry/` → `log-event.py` only (plus `__pycache__`). No `test-*.py`. The manifest's `hooks python compile` lists `log-event.py` for **compile only** — there is no functional test of its handler. Every other hook now has one (loop-safety got `test-loop-guard.py` this session; thinking-gate, memory-normalizer, inject all have tests).

**Why it matters:** `log-event.py`'s status classification (`envelope_error`: `is_error`/`success:false`/non-zero `exit_code`/`status` string) and retention pruning are untested. A regression in status derivation silently corrupts the signal `loop-safety` depends on — and nothing would catch it.

**Resolution (new `hook-telemetry/test-log-event.py`, subprocess harness):**
1. Temp config (`shared.paths.hooksDb` → temp file), `hook-telemetry` enabled, `script.path` = `hook-telemetry/log-event.py`, via `HOOKS_CONFIG_PATH`.
2. Feed `PostToolUse` payloads and assert one `hook_events` row each with correct `status`:
   - success (`tool_response.exit_code = 0`) → `status="ok"`
   - non-zero exit / `success:false` / `is_error:true` / `status:"failed"` → `status="error"` (one case each — locks `envelope_error`)
   - `hook_event_name="PostToolUseFailure"` → `status="error"`
   - a successful tool whose output text contains "error:" → still `status="ok"` (locks the no-text-scan guarantee)
3. Assert `detail` is populated only on error and truncated to `detailMaxChars`.
4. Assert `match.tools` exclusion and `enabled:false` both produce **no** row.
5. (Optional) assert retention pruning fires at the `retentionPruneEvery` boundary when `retentionDays > 0`.

Add the test to `quality-completion-gate/quality-verify-manifest.json` (`hooks` repo `runtime` domain) and to the `py_compile` command.

---

## ISSUE 3 — `recall.py` / `suggest.py` are byte-identical copies across the two inject dirs

**Severity:** Significant (drift risk: a fix applied to one is silently missed in the other — exactly how fixed bugs reappear)

**Status:** Confirmed present.

**Evidence (SHA-256):**
- `inject-protocol/recall.py` == `inject-protocol-complex/recall.py` → `bd097c9f…2ff56e`
- `inject-protocol/suggest.py` == `inject-protocol-complex/suggest.py` → `b333850a…eb6f16`

The `.mjs` entrypoints were de-duplicated via `inject-protocol/inject-core.mjs` (Slices 9-11), but the Python helpers were left as copies.

**Why it matters:** The audit's P1 read-only-SQLite fix had to be applied to four files instead of two; the next fix to recall/suggest scoring will face the same trap, and the disabled complex profile makes the stale copy easy to overlook.

**Resolution — pick one, then add a regression guard:**
- **A (share):** make `inject-protocol/recall.py` + `suggest.py` canonical; have `inject-protocol-complex/inject-protocol-complex.mjs` invoke `../inject-protocol/recall.py` / `../inject-protocol/suggest.py` (mirror the `inject-core.mjs` sharing) and delete the complex copies.
- **B (retire):** if the complex profile is staying disabled/deprecated, delete the complex copies and the complex hook's helper references.

Either way, add a regression test (extend `inject-protocol/test-inject-protocol-core.mjs`, which already does static wiring assertions): assert there is a single canonical helper — e.g., that `inject-protocol-complex/inject-protocol-complex.mjs` references `../inject-protocol/recall.py` / `suggest.py`, or that the complex copies do not exist. This makes silent drift fail CI.

---

## Minor / accepted (no fix required unless you want it)

- **Injector `--self-test` writes a `.state` event.** `inject-protocol.mjs` emits `safeEvent('start', …)` at module top on every invocation, including `--self-test`. Harmless (gitignored runtime state) but means the self-test is not truly read-only. Resolve by skipping the start/exit events when `--self-test` is present, if a no-write probe is wanted.
- **`memory-normalizer/maintain-existing-memories.py` near-duplicate scan is O(n²)** with dry-run-default guards only. Manual tool; fine at current store size (~500-700 rows). Add a row-count cap/`--max-rows` guard before it's pointed at a large store.
- **Shallow shell parsing in `loop-safety` / `quality-gate`** is a deliberate, documented tradeoff for trusted local config — not a defect. Leave as-is.

## Pre-implementation guard rail (not a current bug)

When the two-tier telemetry plan is implemented, it must keep `loop-safety`'s failure events visible in-session (see C1 in `two-tier-telemetry-implementation-plan-evaluation.md`). Today telemetry is synchronous, so `loop-safety` works; do not let the queue path defer ordinary failure events behind the Stop-only drain.
