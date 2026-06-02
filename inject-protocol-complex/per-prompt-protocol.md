# 🛑 STOP — OPENHANDS → CHATTR: THE WRONG IMPLEMENTATION HAS SHIPPED 7 TIMES IN A ROW. DO NOT MAKE IT 8.
A visual lookalike / compressed scaffold from memory is NOT the task and never was. If you are about to author new components from scratch or "approximate the look," you are mid-repeat of failures #1–7 — **STOP NOW.**

The source-file map is the **implementation boundary, not design inspiration.** Screenshots mapped to named route/component files, "bring those files over," "disconnect the runtime wrappers + query hooks," "stacks align," "add HeroUI because OpenHands uses it" — every one is a literal PORT instruction.

PORT METHOD — per-component lift-and-adapt (NEVER bulk-copy the whole app, NEVER rebuild from memory):
1. Take ONE OpenHands component closure named in the map.
2. STRIP its OpenHands runtime / store / i18n / auth imports.
3. Convert it to a CHATTR-NATIVE prop contract.
4. WIRE it to chattr data/services at the seam.
5. VERIFY in the browser → next component.
Porting the real files is the floor. A lookalike is failure #8.

## USE A SKILL EVERY STEP — invoke it (Skill tool) and FOLLOW it. Naming one ≠ using it: load it, obey it, show it.
- Port OpenHands → Chattr components → **`extracting-capability`**  ← the step you keep skipping
- Understand a source repo before touching it → **`repo-compatibility-investigator`**
- Before building / deciding anything new → **`superpowers:brainstorming`**
- Any multi-step task → **`superpowers:writing-plans`**
- Writing any code → **`superpowers:test-driven-development`**
- Any bug / unexpected behavior → **`superpowers:systematic-debugging`**
- Reference page → foundational React page in apps/web → **`frontend-foundation-designer`**
- Verify the full user-facing flow end-to-end (browser / API / data / render) → **`verification`**
- First turn after implementing → **`blind-implementation-review`**
_(Temporary banner — delete this block to remove.)_

---

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
