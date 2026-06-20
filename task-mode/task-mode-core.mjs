/**
 * Shared task-mode classification, skill patterns, and session state.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const TASK_MODES = ['explore', 'implement', 'fix', 'refactor', 'review', 'docs'];

export const MODE_REQUIRED_SKILLS = {
  explore: [],
  implement: [
    'brainstorming',
    'waza-think',
    'investigating-and-writing-plan',
    'investigating-and-writing-plan-v2',
    'initiating-a-new-task',
  ],
  fix: ['waza-hunt', 'systematic-debugging', 'comprehensive-systematic-debugging', 'debug'],
  refactor: ['refactor', 'investigating-and-writing-plan', 'investigating-and-writing-plan-v2', 'waza-think'],
  review: [
    'code-review',
    'receiving-code-review',
    'blind-implementation-review',
    'requesting-code-review',
    'review-bugbot',
  ],
  docs: [],
};

export const MODE_SKILL_PATTERNS = Object.fromEntries(
  Object.entries(MODE_REQUIRED_SKILLS).map(([mode, skills]) => [
    mode,
    skills.flatMap((skill) => [skill, skill.replace(/-/g, ' '), `${skill}/skill.md`]),
  ]),
);

const IMPLEMENT_HINTS =
  /\b(implement|build|add|create|wire up|ship|scaffold|migrate|port)\b/i;
const FIX_HINTS = /\b(fix|bug|broken|failing|debug|error|crash|regression|repair)\b/i;
const REFACTOR_HINTS = /\b(refactor|restructure|extract|rename module|clean up|dedupe)\b/i;
const REVIEW_HINTS =
  /\b(code review|review this|review the|pr comment|pull request review|cold review|blind review)\b/i;
const DOCS_HINTS = /\b(docs only|documentation only|changelog|readme|typo in doc)\b/i;
const EXPLORE_HINTS = /\b(how does|explain|what is|why does|walk me through|describe)\b/i;

export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'SemanticSearch',
  'WebSearch',
  'WebFetch',
  'AskQuestion',
  'Await',
  'FetchMcpResource',
  'ListMcpResources',
  'SwitchMode',
]);

export const MUTATING_TOOLS = new Set([
  'Bash',
  'Shell',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'Delete',
  'Task',
  'StrReplace',
]);

export function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/');
}

export function repoRootForCwd(cwd, timeoutMs = 5000) {
  const normalized = normalizePath(cwd || process.cwd());
  try {
    return normalizePath(execFileSync('git', ['-C', normalized, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      windowsHide: true,
    }).trim());
  } catch {
    return normalized;
  }
}

export function sessionKey(sessionId, repoRoot) {
  return createHash('sha256').update(JSON.stringify({ sessionId: sessionId || '', repoRoot: repoRoot || '' })).digest('hex');
}

export function stateDir(settings) {
  return settings.stateDir || 'E:/hooks/.state/task-mode';
}

export function statePath(settings, sessionId, repoRoot) {
  return join(stateDir(settings), `${sessionKey(sessionId, repoRoot)}.json`);
}

export function readState(settings, sessionId, repoRoot) {
  try {
    return JSON.parse(readFileSync(statePath(settings, sessionId, repoRoot), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(settings, sessionId, repoRoot, value) {
  const path = statePath(settings, sessionId, repoRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // fail open
  }
}

export function parseExplicitMode(prompt) {
  const text = String(prompt || '').trim();
  const modeLine = text.match(/^mode:\s*(explore|implement|fix|refactor|review|docs)\b/im);
  if (modeLine) return modeLine[1].toLowerCase();
  const slash = text.match(/^\/(explore|implement|fix|refactor|review|docs)\b/im);
  if (slash) return slash[1].toLowerCase();
  return null;
}

export function classifyMode(prompt) {
  const explicit = parseExplicitMode(prompt);
  if (explicit) return explicit;

  const text = String(prompt || '');
  if (DOCS_HINTS.test(text)) return 'docs';
  if (REVIEW_HINTS.test(text)) return 'review';
  if (FIX_HINTS.test(text)) return 'fix';
  if (REFACTOR_HINTS.test(text)) return 'refactor';
  if (IMPLEMENT_HINTS.test(text)) return 'implement';
  if (EXPLORE_HINTS.test(text)) return 'explore';

  return 'explore';
}

export function isMutatingTool(toolName) {
  const name = String(toolName || '');
  if (READ_ONLY_TOOLS.has(name)) return false;
  if (MUTATING_TOOLS.has(name)) return true;
  if (/^mcp__.*__(ctx_batch_execute|ctx_execute|ctx_execute_file)/.test(name)) return true;
  return false;
}

export function hooksDbPath(runtime) {
  return runtime.shared?.paths?.hooksDb || 'E:/hooks/_db/hooks.db';
}

export function telemetryHighWatermark(sessionId, runtime) {
  const dbPath = hooksDbPath(runtime);
  if (!existsSync(dbPath) || !sessionId) return 0;

  try {
    const raw = execFileSync(
      process.env.HOOKS_PYTHON || 'python',
      [
        '-c',
        `
import sqlite3, sys
db, session_id = sys.argv[1], sys.argv[2]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
row = con.execute("SELECT COALESCE(MAX(id), 0) FROM hook_events WHERE session_id=?", (session_id,)).fetchone()
con.close()
print(int(row[0] or 0))
`,
        dbPath,
        sessionId,
      ],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    return Number.parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}

export function telemetryMatches(sessionId, sinceId, runtime, patterns) {
  const dbPath = hooksDbPath(runtime);
  if (!existsSync(dbPath) || !sessionId || !patterns.length) return false;

  try {
    const raw = execFileSync(
      process.env.HOOKS_PYTHON || 'python',
      [
        '-c',
        `
import json, sqlite3, sys
db, session_id, since_id = sys.argv[1], sys.argv[2], int(sys.argv[3])
patterns = [p.lower() for p in json.loads(sys.argv[4])]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute(
  "SELECT tool_name, target, detail FROM hook_events WHERE session_id=? AND id>? AND hook_id='hook-telemetry' ORDER BY id DESC LIMIT 300",
  (session_id, since_id),
).fetchall()
con.close()
blob = "\\n".join(" ".join(str(cell or "") for cell in row) for row in rows).lower()
print("1" if any(p in blob for p in patterns) else "0")
`,
        dbPath,
        sessionId,
        String(sinceId || 0),
        JSON.stringify(patterns),
      ],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    return raw === '1';
  } catch {
    return false;
  }
}

export function skillCheckpoint(sessionId, sinceId, runtime, mode) {
  const patterns = MODE_SKILL_PATTERNS[mode] || [];
  if (!patterns.length) return true;
  const thinkingPatterns = [
    'sequentialthinking',
    'sequential thinking',
    'sequential-thinking',
  ];
  return telemetryMatches(sessionId, sinceId, runtime, [...patterns, ...thinkingPatterns]);
}

export function modeInjectionBlock(mode) {
  const required = MODE_REQUIRED_SKILLS[mode] || [];
  const lines = [
    `## Task mode: ${mode}`,
    'Hooks classified this prompt. Mutating tools (Write/Edit/Shell) require a planning checkpoint first.',
  ];
  if (!required.length) {
    lines.push('No planning skill required for this mode — read/explore freely.');
    return lines.join('\n');
  }
  lines.push(
    'Before editing code, load and follow ONE of:',
    ...required.map((skill) => `- \`${skill}\``),
    'Or call sequential-thinking MCP once (counts as a planning checkpoint).',
    '',
    'Override classification: start prompt with `mode: implement` (or fix/refactor/review/explore/docs).',
    'Skill catalog: E:/hooks/skills-catalog.md',
  );
  return lines.join('\n');
}
