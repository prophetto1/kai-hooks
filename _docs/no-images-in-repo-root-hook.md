# Hook needed: block image/screenshot writes to repo root

**Status:** Requested — not yet implemented. Author: Claude (on Jon's instruction, 2026-06-08).
**Priority:** High (public-repo hygiene).

## Problem

Agents repeatedly save browser/Playwright **screenshots to the repository root**
(`./<name>.png`), because the screenshot MCP tools resolve a bare `filename` relative
to the current working directory — which is the repo root. On a **public repo** this is
unacceptable: clutter, and accidental-commit risk via `git add -f` or a loosened ignore.

Jon has observed this happen *repeatedly* ("hundreds of images"). A **memory/preference is
advisory** and has failed to hold — the agent forgets across turns/sessions. The rule must
be **enforced by the harness**, not left to agent discretion.

## The rule

- **Never** write image files to a repo root.
- Session/scratch screenshots go to the **gitignored** `docs/images/scratch/` (already
  ignored in kai-chattr via `.gitignore` `docs/` + `docs/images/scratch/`).
- Clean stray root captures + `.playwright-mcp/` with `rm` via the Bash tool (PowerShell
  `Remove-Item` on repo paths is sandbox-blocked in this environment).

## Why a hook (not a memory)

Per the Claude Code hooks model, **PreToolUse** can return a decision of `deny` with a
reason, and the harness blocks the call before it runs — deterministic, model-agnostic,
survives across sessions. This is the correct substrate for a "whenever X, never Y" rule.
(Memories are injected as advisory context and are skippable; hooks are not.)

## Proposed hook design

- **Event:** `PreToolUse`
- **Matchers (screenshot-producing tools):**
  - `mcp__plugin_playwright_playwright__browser_take_screenshot`
  - `mcp__mcp-router__browser_take_screenshot`
  - `mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot`
  - `mcp__Claude_Preview__preview_screenshot`
  - (extend with any future browser/computer-use screenshot tools that accept a path)
- **Logic:** read the tool input's output path (`filename` / `path` / `target`). **Deny** when
  the resolved path:
  - has no directory component (bare filename → lands at cwd/root), **or**
  - resolves to the repo root, **or**
  - is not under an allowlisted sink: `docs/images/scratch/` (or the OS temp dir).
  - Return `permissionDecision: "deny"` + reason: *"Screenshots must be written under
    `docs/images/scratch/` (gitignored), never the repo root. Re-issue with that path."*
- **Optional companion guard:** also match the `Write` tool and deny when the target path is
  a repo-root file with an image extension (`.png/.jpg/.jpeg/.gif/.webp`).
- **Out of scope / lower priority:** `.playwright-mcp/` auto-creates at repo root but is
  already gitignored; optionally add a periodic clean or relocate its output dir.

## Allowed sink

`docs/images/scratch/` — gitignored, designated for regenerated-per-session captures.

## Scope

Apply to all repos (at minimum all public repos). Centralize the implementation in
`E:/hooks` alongside the existing thinking-gate / skill-enforcement hooks rather than
per-repo `settings.json`, so it is consistent everywhere.

## References

- Claude Code hooks (PreToolUse deny semantics; verified 2026-06-02 against the official
  hooks docs): `permissionDecision` allow/deny/ask returned inside `hookSpecificOutput`.
- Companion memory: `no-screenshots-in-repo-root` (agent-side convention).
