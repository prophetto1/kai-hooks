# Per-prompt protocol — apply, don't perform.

## mcp-router.Sequential thinking and Hindsight memory both in MCP-ROUTER

## A. Memory (mcp-router has vector and hindsight)
- Primary recall is the vector/SQLite store (`E:/_memory/memory-sqlite.db`) via MCP Router memory tools and hook-injected recall. Hindsight is not primary until backfilled from that store.
- Capture previous 3 exchanges: decisions, rules, project state, path/URL/ID pointers, corrections/mistake facts, non-obvious facts.
- Stop hook `memory-harvester` also scans the recent transcript and stores durable facts the agent did not explicitly save.
- Dedupe first (search existing vector memories -> `memory_store`/`memory_update` only when the fact is not already represented). Do not rely on Hindsight `sync_retain` as the canonical write path yet.

## B. Skills (invoke & follow — naming one ≠ using it)
- Load ≥1 matching skill per substantive turn (Tier-1 even on light turns; 2 for ideation→plan). Task mode is injected by task-mode-gate. After output: `verification-before-completion`; large diffs: `waza-hunt`. Catalog: `E:/hooks/skills-catalog.md`.

## C. Writing repo files
Conform to the repo's `contracts/`/`governance/` first — guardrails block non-conforming writes; no contract → nearest existing pattern.

## D. Standing rules
- Brevity. No fallbacks/loopholes — fix the real thing (no mocks, skip-flags, bypasses). Secrets via SOPS only; never ask the user to log in/re-auth. Each repo's docs-site holds the detail.
- Work on the branch that's already checked out; don't create new branches or worktrees unless the user explicitly asks.

## E. Repo changelogs
- Changelogs live at the root of each repo, not in the Planned store.
- Before claiming completion for any codebase change, update the matching repo-root changelog: `E:/hooks/changelog-hooks.md`, `E:/kai-chattr/CHANGELOG.md`, or `E:/jwc-global/CHANGELOG.md`.
- Do not call the Planned Stores API for changelog updates unless the user explicitly asks for Planned-store work.

## F. Verification integrity (fraud = blocked Stop)
- Fabricating verification is fraud: mocked Playwright API intercepts, citing PNGs from non-live runs (`run.json` without `liveApi:true`), or claiming verified/passing/done while the real stack is broken.
- Consequences: Stop blocked immediately; fraud strikes recorded per session; at 3 strikes report honestly to the user — do NOT claim done.
- Required: live verification only (`ui-snapshot-live.mjs`, `verify-platform-visual-manifest-live.mjs`). Restart dev servers after runtime changes yourself. Fix the real API/page — never bypass with mocks to satisfy the gate.

## G. Map
- Clean targets ← legacy sources (copy-only, governance-first, outside-in): **blockdata ← writing-system**, **kai-chattr ← chattr**. Both clean repos: Python FastAPI backend + Fumadocs devdocs.
