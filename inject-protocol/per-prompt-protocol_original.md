# Per-prompt protocol — apply, don't perform.

## mcp-router.Sequential thinking and memory-vector both in MCP-ROUTER

## A. Memory (mcp-router has vector and hindsight)
- Recall first: `memory_search`; 
- Capture previous 3 exchanges: decisions, rules, project state, path/URL/ID pointers, corrections (`mistake_note_add`), non-obvious facts. 
- Dedupe first (`memory_search` → `memory_update` by `content_hash`, else `memory_store`). 

## B. Skills (invoke & follow — naming one ≠ using it)
- Load ≥1 matching skill per substantive turn (Tier-1 even on light turns; 2 for ideation→plan). Task mode + required skills: `E:/hooks/_docs/task-mode-and-skills.md` (injected by task-mode-gate). After output: `verification-before-completion`; large diffs: `waza-hunt`. Catalog: `E:/hooks/skills-catalog.md`.

## C. Writing repo files
Conform to the repo's `contracts/`/`governance/` first — guardrails block non-conforming writes; no contract → nearest existing pattern.

## D. Standing rules
- Brevity. No fallbacks/loopholes — fix the real thing (no mocks, skip-flags, bypasses). Secrets via SOPS only; never ask the user to log in/re-auth. Each repo's docs-site holds the detail.
- Work on the branch that's already checked out; don't create new branches or worktrees unless the user explicitly asks.

## E. Planned store and changelogs
- The shared Planned store is served by the Neon-backed Stores API at `http://127.0.0.1:1721`, store `planned`.
- First read `planned/planned-store-worker-guide.md` for the detailed how-to. Find it through `GET /stores/planned/tree`, then read it with `GET /stores/planned/nodes/{node_id}`.
- Project folders are flat. Current roots: `jwc-global`, `kai-chattr`, `hooks`.
- Before claiming completion for any codebase change, update the matching project `changelog.md` in Planned.
- Minimum endpoints: `GET /stores/planned/tree`, `GET /stores/planned/nodes/{node_id}`, `PUT /stores/planned/nodes/{node_id}/content`, `POST /stores/planned/files`.

## F. Verification integrity (fraud = blocked Stop)
- Fabricating verification is fraud: mocked Playwright API intercepts, citing PNGs from non-live runs (`run.json` without `liveApi:true`), or claiming verified/passing/done while the real stack is broken.
- Consequences: Stop blocked immediately; fraud strikes recorded per session; at 3 strikes report honestly to the user — do NOT claim done.
- Required: live verification only (`ui-snapshot-live.mjs`, `verify-platform-visual-manifest-live.mjs`). Restart dev servers after runtime changes yourself. Fix the real API/page — never bypass with mocks to satisfy the gate.

## G. Map
- Clean targets ← legacy sources (copy-only, governance-first, outside-in): **blockdata ← writing-system**, **kai-chattr ← chattr**. Both clean repos: Python FastAPI backend + Fumadocs devdocs.
