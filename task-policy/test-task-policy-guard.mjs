import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { decideGuard, evaluate, shellIsReadOnlySafe } from './task-policy-guard.mjs';
import { DEFAULT_TASK_POLICY, ENVELOPE_SCHEMA_VERSION, taskPolicyConfig, writeEnvelope } from './task-policy-core.mjs';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true, '']);
  } catch (error) {
    checks.push([name, false, error.message]);
  }
}

const config = DEFAULT_TASK_POLICY;
function envWith(directives = [], extra = {}) {
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, repoRoot: 'E:/repo', userDirectives: directives, allowedScopes: [], forbiddenScopes: [], ...extra };
}
const RO = [{ kind: 'read-only', value: 'on' }];
const BROWSER = [{ kind: 'browser-verification', value: 'skip' }];
const FULL = [{ kind: 'full-suite', value: 'skip' }];

function expectDeny(decision, reasonCode) {
  assert.equal(decision.action, 'deny', `expected deny, got ${decision.action}`);
  if (reasonCode) assert.equal(decision.reasonCode, reasonCode, `reasonCode ${decision.reasonCode} !== ${reasonCode}`);
}
function expectAllow(decision) {
  assert.equal(decision.action, 'allow', `expected allow, got ${decision.action} (${decision.reasonCode})`);
}

/* --- read-only --- */

check('read-only mutation denial (Edit blocked)', () => {
  expectDeny(decideGuard({ toolName: 'Edit', toolInput: { file_path: 'E:/repo/a.ts' }, envelope: envWith(RO), envelopeOk: true, config }), 'read-only');
});

check('read-only allows read-only shell discovery (git status)', () => {
  expectAllow(decideGuard({ toolName: 'Bash', toolInput: { command: 'git status' }, envelope: envWith(RO), envelopeOk: true, config }));
});

check('read-only blocks heavy shell command too', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'npx playwright test' }, envelope: envWith(RO), envelopeOk: true, config }));
});

check('read-only allows safe discovery shell (git status, grep, ls, cat)', () => {
  for (const cmd of ['git status', 'git -C E:/repo diff', 'grep foo src', 'ls -la', 'cat file.txt', 'rg pattern', 'git log --oneline -5']) {
    expectAllow(decideGuard({ toolName: 'Bash', toolInput: { command: cmd }, envelope: envWith(RO), envelopeOk: true, config }));
  }
});

check('read-only denies unknown/mutating shell commands', () => {
  for (const cmd of ['rm -rf x', 'git commit -m x', 'npm install', 'node build.mjs', 'python deploy.py', 'mkdir y', 'mv a b']) {
    expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: cmd }, envelope: envWith(RO), envelopeOk: true, config }), 'read-only-shell');
  }
});

check('read-only denies compound command with an unsafe segment', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'git status && rm -rf x' }, envelope: envWith(RO), envelopeOk: true, config }), 'read-only-shell');
});

check('read-only denies write redirection but allows >/dev/null', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'cat a > out.txt' }, envelope: envWith(RO), envelopeOk: true, config }), 'read-only-shell');
  expectAllow(decideGuard({ toolName: 'Bash', toolInput: { command: 'grep foo src 2>/dev/null' }, envelope: envWith(RO), envelopeOk: true, config }));
});

check('read-only denies mutating find (-delete/-exec)', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'find . -name "*.tmp" -delete' }, envelope: envWith(RO), envelopeOk: true, config }), 'read-only-shell');
  expectAllow(decideGuard({ toolName: 'Bash', toolInput: { command: 'find . -name "*.ts"' }, envelope: envWith(RO), envelopeOk: true, config }));
});

check('shellIsReadOnlySafe unit cases', () => {
  assert.equal(shellIsReadOnlySafe('git status'), true);
  assert.equal(shellIsReadOnlySafe('git commit -m x'), false);
  assert.equal(shellIsReadOnlySafe('ls && cat f'), true);
  assert.equal(shellIsReadOnlySafe('ls && rm f'), false);
  assert.equal(shellIsReadOnlySafe('node x.mjs'), false);
});

/* --- browser / full-suite --- */

check('browser-command denial under browser-skip directive', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'node scripts/dev/ui-snapshot-live.mjs' }, envelope: envWith(BROWSER), envelopeOk: true, config }), 'directive-forbids-browser');
});

check('browser command allowed when no browser directive (selected route may run)', () => {
  expectAllow(decideGuard({ toolName: 'Bash', toolInput: { command: 'npx playwright test' }, envelope: envWith([]), envelopeOk: true, config }));
});

check('full-suite denial under full-suite directive', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'uv run python -m pytest tests/ -q' }, envelope: envWith(FULL), envelopeOk: true, config }), 'directive-forbids-full-suite');
});

check('targeted test allowed under full-suite directive', () => {
  expectAllow(decideGuard({ toolName: 'Bash', toolInput: { command: 'pnpm run check:config' }, envelope: envWith(FULL), envelopeOk: true, config }));
});

/* --- scope --- */

check('scope-prefix denial: mutation outside allowed scope', () => {
  const env = envWith([], { allowedScopes: ['apps/web/'] });
  expectDeny(decideGuard({ toolName: 'Write', toolInput: { file_path: 'E:/repo/services/api/x.py' }, envelope: env, envelopeOk: true, config }), 'outside-allowed-scope');
});

check('scope allows mutation inside allowed scope', () => {
  const env = envWith([], { allowedScopes: ['apps/web/'] });
  expectAllow(decideGuard({ toolName: 'Write', toolInput: { file_path: 'E:/repo/apps/web/x.ts' }, envelope: env, envelopeOk: true, config }));
});

check('forbidden-scope denial', () => {
  const env = envWith([], { forbiddenScopes: ['services/api/'] });
  expectDeny(decideGuard({ toolName: 'Edit', toolInput: { file_path: 'E:/repo/services/api/x.py' }, envelope: env, envelopeOk: true, config }), 'forbidden-scope');
});

/* --- missing envelope --- */

check('missing-envelope heavy-command denial (policy-unavailable)', () => {
  expectDeny(decideGuard({ toolName: 'Bash', toolInput: { command: 'uv run python -m pytest tests/ -q' }, envelope: null, envelopeOk: false, config }), 'policy-unavailable');
});

check('missing-envelope allows ordinary mutation (only heavy is governed without policy)', () => {
  expectAllow(decideGuard({ toolName: 'Edit', toolInput: { file_path: 'E:/repo/a.ts' }, envelope: null, envelopeOk: false, config }));
});

/* --- cannot be disabled by prompt text --- */

check('guard cannot be bypassed by a fake allow field in tool input', () => {
  expectDeny(decideGuard({ toolName: 'Edit', toolInput: { file_path: 'E:/repo/a.ts', allow: true, bypassPolicy: true }, envelope: envWith(RO), envelopeOk: true, config }), 'read-only');
});

/* --- evaluate() wiring + fast path --- */

check('evaluate fast-path allows read-only tools regardless', () => {
  const out = evaluate({ session_id: 's', tool_name: 'Read', cwd: process.cwd() }, { enabled: true, shared: {} });
  assert.equal(out.continue, true);
});

check('evaluate denies forbidden heavy command end-to-end (pretool-guard-denies-forbidden-heavy-command)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-guard-'));
  try {
    execFileSync('git', ['-C', root, 'init'], { stdio: 'ignore' });
    const shared = { taskPolicy: { ...DEFAULT_TASK_POLICY, stateDir: join(root, '.state') } };
    const cfg = taskPolicyConfig(shared);
    // resolve canonical repo root the way the guard will
    const repoRoot = root.replaceAll('\\', '/');
    writeEnvelope(cfg, 'sess', repoRoot, envWith(FULL, { repoRoot }));
    const out = evaluate(
      { session_id: 'sess', tool_name: 'Bash', tool_input: { command: 'uv run python -m pytest tests/ -q' }, cwd: root },
      { enabled: true, shared },
    );
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(/full-suite/.test(out.systemMessage));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

let failed = 0;
for (const [name, ok, message] of checks) {
  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${name}\n      ${message}`);
  }
}
if (failed) {
  console.error(`\ntask-policy-guard: ${failed}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`task-policy-guard tests passed (${checks.length} checks)`);
