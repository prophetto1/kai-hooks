## Temporary Manual Workflow Directive

- We are manually walking the depcruiser/OpenHands migration process one step at a time in `#newchat`.
- Claude reports the current process state for the group: what we just did, what landed, what is next, and where the work stands.
- Codex acts after Jon gives the go-ahead or a concrete instruction: organize the next step, execute according to the instruction, and report the result.
- Keep this directive visible during the manual run so agents do not lose the workflow context. Remove it when Jon ends the manual pass.

# Per-prompt protocol — apply, don't perform.

## A. Memory (memory-vector only)
- Recall before acting: `memory_search` the topic; never contradict a stored decision without flagging it.
- Capture from the last 1–3 exchanges: decisions, rules, project state, path/URL/ID pointers, corrections (`mistake_note_add`), non-obvious facts — not chatter or repo-derivable info. Dedupe first (`memory_search` → `memory_update` by `content_hash`, else `memory_store`); one atomic fact; `type` = decision|planning|reference|learning; tags = type + 1–3 topics; end rules with `Why:`. Corrections overwrite/delete the wrong entry — no stale entries, no "supersedes" narration.

## B. Skills (invoke & follow — naming one ≠ using it)
- Load ≥1 matching skill per substantive turn (Tier-1 even on light turns; 2 for ideation→plan). After output: `verification-before-completion`; first turn after an implementation: that, then `blind-implementation-review`. Catalog: `E:/hooks/skills-catalog.md`.

## C. Writing repo files
Conform to the repo's `contracts/`/`governance/` first — guardrails block non-conforming writes; no contract → nearest existing pattern.

## D. Standing rules
- Brevity. No fallbacks/loopholes — fix the real thing (no mocks, skip-flags, bypasses). Secrets via SOPS only; never ask the user to log in/re-auth. Each repo's docs-site holds the detail.

## E. Map
- Clean targets ← legacy sources (copy-only, governance-first, outside-in): **blockdata ← writing-system**, **kai-chattr ← chattr**. Both clean repos: Python FastAPI backend + Fumadocs devdocs.
- Per repo: contracts `governance/contracts/*.json`; docs `apps/devdocs/content/` (anchors: current-situation `internal/governance`, generated `contracts/`); live `<repo>-docs.pages.dev`. Ports/surfaces: the "Platform ports & surfaces" table in devdocs `content/index.mdx`.
