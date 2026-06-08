# Per-prompt protocol — apply, don't perform.

## A. Memory (memory-vector only - check mcp-router)
- Recall first: `memory_search`; 
- Capture previous 3 exchanges: decisions, rules, project state, path/URL/ID pointers, corrections (`mistake_note_add`), non-obvious facts. 
- Dedupe first (`memory_search` → `memory_update` by `content_hash`, else `memory_store`). 

## B. Skills (invoke & follow — naming one ≠ using it)
- Load ≥1 matching skill per substantive turn (Tier-1 even on light turns; 2 for ideation→plan). After output: `verification-before-completion`; first turn after an implementation: that, then `blind-implementation-review`. Catalog: `E:/hooks/skills-catalog.md`.

## C. Writing repo files
Conform to the repo's `contracts/`/`governance/` first — guardrails block non-conforming writes; no contract → nearest existing pattern.

## D. Standing rules
- Brevity. No fallbacks/loopholes — fix the real thing (no mocks, skip-flags, bypasses). Secrets via SOPS only; never ask the user to log in/re-auth. Each repo's docs-site holds the detail.

## E. Map
- Clean targets ← legacy sources (copy-only, governance-first, outside-in): **blockdata ← writing-system**, **kai-chattr ← chattr**. Both clean repos: Python FastAPI backend + Fumadocs devdocs.