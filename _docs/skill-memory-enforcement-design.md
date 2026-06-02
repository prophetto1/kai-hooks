# Skill + Memory Enforcement — Design (REVIEW BEFORE WIRING)

Status: **proposal only.** Nothing here is live. Review, then we wire.

## Problem
The per-prompt hook fires and shows, but agents skip the *effortful optional* steps — they don't recall memory, don't open the catalog, don't invoke skills — because finishing the user's request is the reward and those steps don't speed that up. Instruction can't fix this. Two structural moves:

- **PUSH** — the hook does the recall + names the skill, so there's no step to skip.
- **GATE** — a `PreToolUse` deny blocks feature-code writes until a skill was actually invoked.

## Verified facts (grounding)
- Memory DB `E:/memory/memory-sqlite.db` has an FTS5 table **`memory_content_fts`** → keyword recall is one fast SQL `MATCH` query, **no embedding model, no timeout risk.**
- `python` is available on this box (no `sqlite3` CLI). So the DB can be read with **zero npm deps** via a python subprocess.
- `memories` table holds entries; `metadata` table holds store metadata. (Exact column names for content/tags/hash to be confirmed at build — one `.schema memories` check.)

## Open verifications before wiring (must confirm)
1. **UserPromptSubmit stdin** — exact JSON field carrying the user prompt (log one fire to confirm; likely `prompt`).
2. **PreToolUse contract** — for Claude Code: the deny JSON shape + that `transcript_path` is provided so the gate can detect a prior `Skill` call. For **Codex**: whether `codex_hooks` supports a PreToolUse-equivalent **with deny** (if not, the gate is Claude-Code-only and Codex relies on push only). ← biggest unknown.
3. **`memories` columns** — confirm content/tags/type/hash names for the SELECT.

---

## Piece 1 — Smart inject hook (PUSH)  ·  replaces `inject-protocol.mjs`
Runs on `UserPromptSubmit`. Emits, inline, every turn: **rules + auto-recalled memories + suggested skill(s)**, budgeted under the ~2 KB inline cap.

**Flow:**
1. Read stdin JSON → extract the prompt text.
2. Load rules from `per-prompt-protocol.md`.
3. **Recall:** FTS-query the prompt's salient terms against `memory_content_fts` → top 3 entries (short snippets).
4. **Suggest:** keyword/tag-match the prompt to a catalog group → 1–2 candidate skills.
5. **Budget:** rules first; append recall + suggestions only while under the cap; drop recall snippets first if over.
6. **Fail-open:** any error → emit just the rules (never block the prompt).

```js
#!/usr/bin/env node
// UserPromptSubmit hook (PUSH) — rules + auto-recall + skill suggestion. Fail-open.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const DB = 'E:/memory/memory-sqlite.db';
const CAP = 3500;            // total additionalContext char budget (tune to real cap)
const MAX_MEM = 3, MAX_SNIP = 220;

function readStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
function getPrompt(raw) { try { return (JSON.parse(raw).prompt || '').toString(); } catch { return ''; } }

// salient terms: words >3 chars, dedup, cap 8
function terms(p){ return [...new Set((p.toLowerCase().match(/[a-z0-9_-]{4,}/g)||[]))].slice(0,8); }

// FTS recall via python (no npm dep). Returns [{snippet}]
function recall(p){
  const t = terms(p); if(!t.length) return [];
  const q = t.map(w=>`"${w}"`).join(' OR ');
  const py = `
import sqlite3,sys
db,q=sys.argv[1],sys.argv[2]
c=sqlite3.connect(db)
try:
  rows=c.execute("SELECT content FROM memory_content_fts WHERE memory_content_fts MATCH ? ORDER BY rank LIMIT ?",(q,${MAX_MEM})).fetchall()
  for (r,) in rows: print(r.replace(chr(10),' ')[:${MAX_SNIP}])
except Exception: pass
`;
  try { return execFileSync('python',['-c',py,DB,q],{encoding:'utf8',timeout:4000}).split('\n').filter(Boolean); }
  catch { return []; }
}

// crude prompt→skill suggestion (starter map; refine from skills-catalog.md)
const MAP = [
  [/figma/,'figma-* (see catalog)'],
  [/\b(sql|postgres|query|schema|migration|neon)\b/,'supabase-postgres-best-practices'],
  [/\b(deploy|release|ship|rollback|ci)\b/,'deploy-checklist'],
  [/\b(bug|error|crash|failing|broken|debug)\b/,'systematic-debugging'],
  [/\b(plan|design|architecture|feature|build|implement)\b/,'waza-think → investigating-and-writing-plan'],
  [/\b(review|pr|diff|merge)\b/,'waza-check'],
  [/\b(test|tdd|coverage)\b/,'test-driven-development'],
  [/\b(repo|clone|library|port|adopt)\b/,'repo-compatibility-investigator'],
];
function suggest(p){ const o=[]; for(const [re,s] of MAP) if(re.test(p)) o.push(s); return o.slice(0,2); }

const rules = (()=>{ try{return readFileSync(join(here,'per-prompt-protocol.md'),'utf8').trim();}catch{return '';} })();
const prompt = getPrompt(readStdin());
let out = rules;
if (prompt) {
  const mems = recall(prompt), sk = suggest(prompt);
  let extra = '';
  if (sk.length)   extra += `\n\n## Suggested skill(s) for this task\n- ${sk.join('\n- ')}`;
  if (mems.length) extra += `\n\n## Recalled memories (auto)\n- ${mems.join('\n- ')}`;
  if ((out+extra).length <= CAP) out += extra;
  else { // over budget: keep suggestions, trim recall
    const justSk = sk.length ? `\n\n## Suggested skill(s) for this task\n- ${sk.join('\n- ')}` : '';
    out = (rules+justSk).slice(0, CAP);
  }
}
if (!out) process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput:{ hookEventName:'UserPromptSubmit', additionalContext: out } }));
process.exit(0);
```

**Result:** recall = mechanical (100%); the right skill is named in front of the agent, so the only remaining act is the invocation. The two skipped steps disappear.

---

## Piece 2 — PreToolUse skill-gate (FORCE)  ·  new `skill-gate.mjs`
Runs on `PreToolUse` for `Write|Edit`. Blocks the save if it targets **feature code** and **no skill was invoked this turn.**

**Flow:**
1. Read stdin → `tool_input.file_path` + `transcript_path`.
2. **Scope:** only gate code files under feature dirs (`apps/`, `src/`, `services/`, `web/`, `packages/`) with code extensions; **never** gate docs/config/governance/memory/hooks/tests.
3. **Detect skill:** scan the transcript from the last user message onward for a `Skill` tool_use. Found → allow. Not found → **deny** with a reason naming a suggested skill.
4. **Fail-open:** any error → allow (never hard-block on a hook crash).

```js
#!/usr/bin/env node
// PreToolUse gate — deny feature-code writes until a skill was invoked this turn. Fail-open.
import { readFileSync } from 'node:fs';
function stdin(){ try{return JSON.parse(readFileSync(0,'utf8'));}catch{return {};} }

const ALLOW_DENY = /(^|\/)(apps|src|services|web|packages)\//; // candidate feature paths
const CODE = /\.(ts|tsx|js|jsx|py|go|rs)$/;
const EXEMPT = /(docs?|governance|contracts|hooks|memory|\.test\.|\.spec\.|README)/i;

const inp = stdin();
const file = (inp.tool_input && (inp.tool_input.file_path || inp.tool_input.path)) || '';
const tpath = inp.transcript_path || '';

function gated(f){ return f && ALLOW_DENY.test(f) && CODE.test(f) && !EXEMPT.test(f); }
function skillUsedThisTurn(tp){
  try {
    const lines = readFileSync(tp,'utf8').trim().split('\n');
    // walk back to last user message; if we see a Skill tool_use after it, pass
    for (let i=lines.length-1;i>=0;i--){
      const e = JSON.parse(lines[i]);
      if (e.role==='user' || e.type==='user') return false;       // reached turn start, no skill seen
      const s = JSON.stringify(e);
      if (s.includes('"name":"Skill"') || s.includes('tool_use') && /Skill/.test(s)) return true;
    }
  } catch { return true; } // can't read transcript → fail-open (allow)
  return true;
}

if (gated(file) && !skillUsedThisTurn(tpath)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput:{
      hookEventName:'PreToolUse',
      permissionDecision:'deny',
      permissionDecisionReason:`Skill-gate: load the relevant skill before writing ${file}. No Skill invocation seen this turn. (Schema/feature dir → use the matching skill from E:/hooks/skills-catalog.md.)`
    }
  }));
  process.exit(0);
}
process.exit(0); // allow
```

**Result:** a zero-skill feature build becomes impossible — the save is denied until a real `Skill` call happened. It checks for an **actual invocation**, not a mention, so no theater. Chat/docs/config edits are untouched.

---

## Wiring (when approved — shown, not applied)
**Claude Code** `~/.claude/settings.json`:
```json
"hooks": {
  "UserPromptSubmit": [{ "hooks":[{ "type":"command","command":"node E:/hooks/inject-protocol.mjs" }] }],
  "PreToolUse":      [{ "matcher":"Write|Edit","hooks":[{ "type":"command","command":"node E:/hooks/skill-gate.mjs" }] }]
}
```
**Codex** `~/.codex/config.toml`: UserPromptSubmit already points at the same `.mjs` (push works as-is). PreToolUse gate **only if** Codex supports it (verification #2).

## Build order
1. **P1 push** — low risk, immediate. Verify stdin field, ship.
2. **P2 gate** — after confirming the PreToolUse deny schema + transcript detection; start **narrow + permissive**, widen as it proves out.

## Still unsolved: CAPTURE
Neither piece forces *saving* memories. Options for later: a `Stop`-hook reminder, or a periodic "anything to save?" nudge. Not in this design.
```
