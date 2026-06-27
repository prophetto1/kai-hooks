import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_TASK_POLICY,
  ENVELOPE_SCHEMA_VERSION,
  appendDecision,
  buildDecision,
  captureBaseline,
  classifyCommand,
  commandIsAllowed,
  createOrAmendEnvelope,
  deriveObjective,
  failureFingerprint,
  isContinuationPrompt,
  mergeDirectives,
  parseDirectives,
  parseScopesAndRoutes,
  readDecisions,
  readEnvelope,
  selectGates,
  taskRelativeChanges,
  unchangedFailure,
  writeEnvelope,
} from './task-policy-core.mjs';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true, '']);
  } catch (error) {
    checks.push([name, false, error.message]);
  }
}

function gitInit(root) {
  execFileSync('git', ['-C', root, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
}
function gitCommitAll(root, message) {
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', message], { stdio: 'ignore' });
}

/* --- directives + objective --- */

check('parseDirectives recognizes read-only / browser / full-suite / scope-lock', () => {
  assert.equal(parseDirectives('please keep this read-only').some((d) => d.kind === 'read-only'), true);
  assert.equal(parseDirectives('do not run Playwright here').some((d) => d.kind === 'browser-verification'), true);
  assert.equal(parseDirectives('skip the full backend test suite').some((d) => d.kind === 'full-suite'), true);
  assert.equal(parseDirectives('do not change scope').some((d) => d.kind === 'scope-lock'), true);
});

check('latest-directive-wins: lift clears prior restriction', () => {
  const prior = parseDirectives('read-only please', '2026-01-01T00:00:00.000Z');
  const later = parseDirectives('you may edit now', '2026-01-02T00:00:00.000Z');
  const merged = mergeDirectives(prior, later);
  assert.equal(merged.some((d) => d.kind === 'read-only'), false, 'lift must clear read-only');
});

check('latest-directive-wins: newer value supersedes for same kind', () => {
  const prior = [{ kind: 'browser-verification', value: 'skip', sourceHash: 'a', observedAt: '2026-01-01T00:00:00.000Z' }];
  const later = [{ kind: 'browser-verification', value: 'skip', sourceHash: 'b', observedAt: '2026-01-02T00:00:00.000Z' }];
  const merged = mergeDirectives(prior, later);
  const active = merged.filter((d) => d.kind === 'browser-verification');
  assert.equal(active.length, 1);
  assert.equal(active[0].sourceHash, 'b');
});

check('parseScopesAndRoutes normalizes scopes and routes', () => {
  const out = parseScopesAndRoutes('scope: apps/web/ forbid-scope: services/api/ routes: /dashboard, settings');
  assert.deepEqual(out.allowedScopes, ['apps/web/']);
  assert.deepEqual(out.forbiddenScopes, ['services/api/']);
  assert.deepEqual(out.selectedRoutes, ['/dashboard', '/settings']);
});

check('deriveObjective redacts secrets and strips directives', () => {
  const obj = deriveObjective('implement sidebar read-only token=abcd1234abcd1234abcd1234abcd1234');
  assert.equal(/abcd1234abcd1234/.test(obj), false, 'secret leaked into objective');
  assert.equal(/read-only/i.test(obj), false, 'directive leaked into objective');
  assert.equal(obj.includes('implement sidebar'), true);
});

check('deriveObjective bounds length', () => {
  const obj = deriveObjective('x'.repeat(1000), { maxObjectiveChars: 50 });
  assert.equal(obj.length <= 50, true);
});

check('isContinuationPrompt detects continuation language', () => {
  assert.equal(isContinuationPrompt('continue'), true);
  assert.equal(isContinuationPrompt('also wire the route'), true);
  assert.equal(isContinuationPrompt('implement a brand new auth system'), false);
});

/* --- envelope lifecycle --- */

check('createOrAmendEnvelope starts a new baseline for substantive prompt', () => {
  const env = createOrAmendEnvelope({
    existing: null,
    prompt: 'implement the settings sidebar layout',
    mode: 'implement',
    sessionId: 's1',
    repoRoot: 'E:/repo',
    baseline: { commit: 'abc', dirtyFingerprints: {} },
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(env.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(env.baseline.commit, 'abc');
  assert.ok(env.taskId);
});

check('createOrAmendEnvelope amends on directive-only prompt (preserves baseline + taskId)', () => {
  const base = createOrAmendEnvelope({
    existing: null,
    prompt: 'implement the settings sidebar layout',
    mode: 'implement',
    sessionId: 's1',
    repoRoot: 'E:/repo',
    baseline: { commit: 'abc', dirtyFingerprints: {} },
    now: '2026-01-01T00:00:00.000Z',
  });
  const amended = createOrAmendEnvelope({
    existing: base,
    prompt: 'do not run Playwright',
    mode: 'implement',
    sessionId: 's1',
    repoRoot: 'E:/repo',
    baseline: { commit: 'SHOULD_NOT_REPLACE', dirtyFingerprints: {} },
    now: '2026-01-01T01:00:00.000Z',
  });
  assert.equal(amended.taskId, base.taskId, 'directive-only prompt must not start a new task');
  assert.equal(amended.baseline.commit, 'abc', 'baseline must be preserved on amend');
  assert.equal(amended.userDirectives.some((d) => d.kind === 'browser-verification'), true);
});

check('createOrAmendEnvelope starts new baseline for substantive follow-up', () => {
  const base = createOrAmendEnvelope({
    existing: null, prompt: 'implement settings sidebar', sessionId: 's1', repoRoot: 'E:/repo',
    baseline: { commit: 'abc', dirtyFingerprints: {} }, now: '2026-01-01T00:00:00.000Z',
  });
  const next = createOrAmendEnvelope({
    existing: base, prompt: 'now build a completely different oauth login flow', sessionId: 's1', repoRoot: 'E:/repo',
    baseline: { commit: 'def', dirtyFingerprints: {} }, now: '2026-01-01T02:00:00.000Z',
  });
  assert.notEqual(next.taskId, base.taskId, 'substantive new prompt must start a new task');
  assert.equal(next.baseline.commit, 'def');
});

check('envelope atomic persistence roundtrip + version rejection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-env-'));
  try {
    const config = { ...DEFAULT_TASK_POLICY, stateDir: join(dir, '.state') };
    const env = createOrAmendEnvelope({
      existing: null, prompt: 'implement settings sidebar', sessionId: 's1', repoRoot: 'E:/repo',
      baseline: { commit: 'abc', dirtyFingerprints: {} }, now: '2026-01-01T00:00:00.000Z',
    });
    writeEnvelope(config, 's1', 'E:/repo', env);
    const read = readEnvelope(config, 's1', 'E:/repo');
    assert.equal(read.ok, true);
    assert.equal(read.envelope.taskId, env.taskId);

    writeEnvelope(config, 's1', 'E:/repo', { ...env, schemaVersion: 999 });
    const stale = readEnvelope(config, 's1', 'E:/repo');
    assert.equal(stale.ok, false);
    assert.equal(stale.envelope, null);
    assert.ok(stale.reason.startsWith('unsupported-version'));

    const missing = readEnvelope(config, 'other', 'E:/repo');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

/* --- git baseline + task-relative changes --- */

check('taskRelativeChanges: committed-during-task files are task changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-git-'));
  try {
    gitInit(root);
    writeFileSync(join(root, 'a.txt'), 'a');
    gitCommitAll(root, 'init');
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'committed.txt'), 'new');
    gitCommitAll(root, 'task commit');
    const delta = taskRelativeChanges(root, baseline);
    assert.equal(delta.ok, true, `delta uncertain: ${delta.reason}`);
    assert.equal(delta.changedFiles.includes('committed.txt'), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

check('taskRelativeChanges: pre-existing unchanged dirt is NOT a task change', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-git-'));
  try {
    gitInit(root);
    writeFileSync(join(root, 'a.txt'), 'a');
    gitCommitAll(root, 'init');
    writeFileSync(join(root, 'preexisting.txt'), 'dirty'); // untracked dirt before task
    const baseline = captureBaseline(root);
    const delta = taskRelativeChanges(root, baseline);
    assert.equal(delta.changedFiles.includes('preexisting.txt'), false);
    assert.equal(delta.changedFiles.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

check('taskRelativeChanges: pre-existing dirt the task modifies IS a task change', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-git-'));
  try {
    gitInit(root);
    writeFileSync(join(root, 'a.txt'), 'a');
    gitCommitAll(root, 'init');
    writeFileSync(join(root, 'preexisting.txt'), 'dirty');
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'preexisting.txt'), 'dirty + task change');
    const delta = taskRelativeChanges(root, baseline);
    assert.equal(delta.changedFiles.includes('preexisting.txt'), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

check('taskRelativeChanges: deletion during task is a task change', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-git-'));
  try {
    gitInit(root);
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'b.txt'), 'b');
    gitCommitAll(root, 'init');
    const baseline = captureBaseline(root);
    rmSync(join(root, 'b.txt'));
    const delta = taskRelativeChanges(root, baseline);
    assert.equal(delta.changedFiles.includes('b.txt'), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

check('taskRelativeChanges: clean repo with no changes has no delta', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-git-'));
  try {
    gitInit(root);
    writeFileSync(join(root, 'a.txt'), 'a');
    gitCommitAll(root, 'init');
    const baseline = captureBaseline(root);
    const delta = taskRelativeChanges(root, baseline);
    assert.equal(delta.changedFiles.length, 0);
    assert.equal(delta.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

/* --- command classification --- */

check('classifyCommand uses explicit classes when present', () => {
  assert.deepEqual(classifyCommand({ command: 'whatever', classes: ['config', 'targeted'] }), ['config', 'targeted']);
});

check('classifyCommand infers full-suite and browser', () => {
  assert.equal(classifyCommand({ command: 'uv run python -m pytest tests/ -q' }).includes('full-suite'), true);
  assert.equal(classifyCommand({ command: 'node scripts/dev/ui-snapshot-live.mjs' }).includes('browser'), true);
});

check('commandIsAllowed respects directives', () => {
  const ro = [{ kind: 'read-only', value: 'on' }];
  const fs = [{ kind: 'full-suite', value: 'skip' }];
  assert.equal(commandIsAllowed(['quality', 'targeted'], ro), false);
  assert.equal(commandIsAllowed(['quality', 'full-suite'], fs), false);
  assert.equal(commandIsAllowed(['quality', 'targeted'], fs), true);
});

/* --- gate selection --- */

const QCMDS = [
  { id: 'carops.config-contract', command: 'pnpm run check:config', classes: ['quality', 'config', 'targeted'] },
  { id: 'kai.api-all-tests', command: 'uv run python -m pytest tests/ -q', classes: ['quality', 'full-suite'] },
];

function env(directives = [], extra = {}) {
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, userDirectives: directives, ...extra };
}
const DELTA = { ok: true, uncertain: false, changedFiles: ['apps/web/x.ts'], fingerprint: 'fp1' };

check('selectGates: read-only skips all heavy gates', () => {
  const gates = selectGates({ envelope: env([{ kind: 'read-only', value: 'on' }]), delta: DELTA, qualityCommands: QCMDS });
  assert.equal(gates.every((g) => g.selection === 'skip' && g.failureDisposition === 'none'), true);
});

check('selectGates: no delta skips heavy gates', () => {
  const gates = selectGates({ envelope: env([]), delta: { ok: true, uncertain: false, changedFiles: [], fingerprint: '' }, qualityCommands: QCMDS });
  assert.equal(gates.find((g) => g.gate === 'completion-quality-gate').selection, 'skip');
});

check('selectGates: full-suite directive filters full-suite command, keeps targeted', () => {
  const gates = selectGates({ envelope: env([{ kind: 'full-suite', value: 'skip' }]), delta: DELTA, qualityCommands: QCMDS });
  const quality = gates.find((g) => g.gate === 'completion-quality-gate');
  assert.equal(quality.selection, 'run');
  assert.deepEqual(quality.commandIds, ['carops.config-contract']);
});

check('selectGates: full-suite directive with only full-suite commands still runs risk phase', () => {
  const gates = selectGates({ envelope: env([{ kind: 'full-suite', value: 'skip' }]), delta: DELTA, qualityCommands: [QCMDS[1]] });
  const quality = gates.find((g) => g.gate === 'completion-quality-gate');
  assert.equal(quality.selection, 'run');
  assert.deepEqual(quality.commandIds, []);
});

check('selectGates: browser directive keeps quality phase and marks risk phase skipped', () => {
  const gates = selectGates({ envelope: env([{ kind: 'browser-verification', value: 'skip' }]), delta: DELTA, qualityCommands: QCMDS });
  const quality = gates.find((g) => g.gate === 'completion-quality-gate');
  assert.equal(quality.selection, 'run');
  assert.equal(quality.reasonCodes.includes('risk-phase-browser-skipped'), true);
});

check('selectGates: scope-lock makes dispositions report-only', () => {
  const gates = selectGates({ envelope: env([{ kind: 'scope-lock', value: 'on' }]), delta: DELTA, qualityCommands: QCMDS, applicability: () => true });
  assert.equal(gates.find((g) => g.gate === 'completion-quality-gate').failureDisposition, 'report-only');
});

check('selectGates: uncertain delta skips heavy gates', () => {
  const gates = selectGates({ envelope: env([]), delta: { ok: false, uncertain: true, changedFiles: [], fingerprint: '' }, qualityCommands: QCMDS });
  assert.equal(gates.every((g) => g.selection === 'skip'), true);
  assert.equal(gates[0].reasonCodes.includes('policy-uncertain'), true);
});

/* --- decision records --- */

check('buildDecision sanitizes unrelated findings (drops raw fields)', () => {
  const decision = buildDecision({
    taskId: 't1',
    repoRoot: 'E:/repo',
    delta: DELTA,
    gates: [{
      gate: 'completion-quality-gate', selection: 'run', failureDisposition: 'report-only', reasonCodes: ['task-relevant'], commandIds: [],
      unrelatedFindings: [{ title: 'oauth error', file: 'services/api/oauth.py', rawOutput: 'SECRET STACKTRACE', commandId: 'kai.api' }],
    }],
    now: '2026-01-01T00:00:00.000Z',
  });
  const finding = decision.gates[0].unrelatedFindings[0];
  assert.equal('rawOutput' in finding, false, 'raw output must be stripped');
  assert.equal(finding.file, 'services/api/oauth.py');
});

check('appendDecision bounds records to maxDecisionRecords', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-dec-'));
  try {
    const config = { ...DEFAULT_TASK_POLICY, stateDir: join(dir, '.state'), maxDecisionRecords: 3, decisionRetentionDays: 0 };
    for (let i = 0; i < 6; i += 1) {
      appendDecision(config, 's1', 'E:/repo', buildDecision({ taskId: `t${i}`, repoRoot: 'E:/repo', delta: DELTA, gates: [], now: `2026-01-0${i + 1}T00:00:00.000Z` }));
    }
    const decisions = readDecisions(config, 's1', 'E:/repo');
    assert.equal(decisions.length, 3, 'must keep only the last 3');
    assert.equal(decisions[decisions.length - 1].taskId, 't5');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

check('unchangedFailure detects a repeated blocker by fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fp-'));
  try {
    const config = { ...DEFAULT_TASK_POLICY, stateDir: join(dir, '.state') };
    const fp = failureFingerprint('completion-quality-gate', ['carops.config-contract'], 'fp1');
    const decision = buildDecision({ taskId: 't1', repoRoot: 'E:/repo', delta: DELTA, gates: [{ gate: 'completion-quality-gate', selection: 'run', failureDisposition: 'block', reasonCodes: [], commandIds: ['carops.config-contract'], blocking: true }], now: '2026-01-01T00:00:00.000Z' });
    decision.gates[0].failureFingerprint = fp;
    appendDecision(config, 's1', 'E:/repo', decision);
    const seen = unchangedFailure(config, 's1', 'E:/repo', 'completion-quality-gate', fp);
    assert.equal(seen.seen, true);
    const notSeen = unchangedFailure(config, 's1', 'E:/repo', 'completion-quality-gate', 'different');
    assert.equal(notSeen.seen, false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

/* --- report --- */

let failed = 0;
for (const [name, ok, message] of checks) {
  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${name}\n      ${message}`);
  }
}
if (failed) {
  console.error(`\ntask-policy-core: ${failed}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`task-policy-core tests passed (${checks.length} checks)`);
