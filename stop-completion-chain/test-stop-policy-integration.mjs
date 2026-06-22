#!/usr/bin/env node
/**
 * End-to-end Stop task-policy regression suite (the 16 named acceptance
 * scenarios). Chain-level scenarios spawn the real stop-completion-chain against
 * a temp repo + cloned temp config + temp manifest + written envelope. Policy
 * decision scenarios assert the exact functions the chain composes.
 *
 * No live product server, browser, network request, SOPS secret, or product
 * repository mutation is used. Fixtures are temporary git repos + local JSON.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ENVELOPE_SCHEMA_VERSION,
  captureBaseline,
  failureFingerprint,
  mergeDirectives,
  parseDirectives,
  selectGates,
  sessionRepoKey,
  taskRelativeChanges,
} from '../task-policy/task-policy-core.mjs';
import {
  HARD_NON_REDIRECT,
  buildQualityCommands,
  forbiddenClassesFromDirectives,
} from './stop-completion-chain.mjs';
import { decideGuard } from '../task-policy/task-policy-guard.mjs';
import { gitRoot as qGitRoot, normalizeAbsolute } from '../quality-completion-gate/quality-gate-core.mjs';
import { codexStopStatusMessages, isNeutralStopStatus } from '../_core/validate-runtime-hooks.mjs';

const HOOKS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAIN = join(HOOKS_ROOT, 'stop-completion-chain', 'stop-completion-chain.mjs');
const REAL_CONFIG = JSON.parse(readFileSync(join(HOOKS_ROOT, 'config.json'), 'utf8'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([name, 'pass', '']);
  } catch (error) {
    results.push([name, 'fail', error.message]);
  }
}
function defer(name, why) {
  results.push([name, 'defer', why]);
}

/* ---------- fixtures ---------- */

function gitInit(root) {
  execFileSync('git', ['-C', root, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@e.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T'], { stdio: 'ignore' });
}
function commitAll(root, msg) {
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', msg], { stdio: 'ignore' });
}
function canonicalRoot(root) {
  // Exactly what the gate/chain compute, so manifest root + envelope key match.
  return normalizeAbsolute(qGitRoot(root, 5000).value);
}

function makeTempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'stop-policy-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  gitInit(repo);
  const stateDir = join(dir, 'state').replaceAll('\\', '/');
  const manifestPath = join(dir, 'manifest.json').replaceAll('\\', '/');
  const configPath = join(dir, 'config.json').replaceAll('\\', '/');
  return { dir, repo, stateDir, manifestPath, configPath };
}

function writeManifest(env, repoRoot, domains) {
  writeFileSync(env.manifestPath, JSON.stringify({
    version: 1,
    repos: [{ name: 'fixture', root: repoRoot, blockOnUnmatched: false, domains }],
  }, null, 2));
}

function writeConfig(env, chain) {
  const config = structuredClone(REAL_CONFIG);
  config.shared.paths.qualityVerifyManifest = env.manifestPath;
  config.shared.paths.hooksDb = join(env.dir, 'hooks.db').replaceAll('\\', '/'); // absent → no fraud
  config.shared.taskPolicy = { ...(config.shared.taskPolicy || {}), stateDir: env.stateDir };
  for (const hook of config.hooks) {
    if (hook.id === 'quality-completion-gate') {
      hook.settings = { ...(hook.settings || {}), stateDir: env.stateDir, verifyManifest: env.manifestPath };
    }
    if (hook.id === 'agent-diff-completion-gate') {
      hook.settings = { ...(hook.settings || {}), stateDir: env.stateDir };
    }
  }
  const chainScript = config.scripts.find((s) => s.id === 'stop-completion-chain');
  chainScript.settings = { ...(chainScript.settings || {}), chain };
  writeFileSync(env.configPath, JSON.stringify(config, null, 2));
}

function writeEnvelope(env, repoRoot, sessionId, envelope) {
  const path = join(env.stateDir, 'envelopes', `${sessionRepoKey(sessionId, repoRoot)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(envelope, null, 2));
}

function baseEnvelope(repoRoot, sessionId, overrides = {}) {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    taskId: 'task-' + sessionId,
    sessionId,
    repoRoot,
    mode: 'implement',
    objective: 'fixture task',
    allowedScopes: [],
    forbiddenScopes: [],
    selectedRoutes: [],
    userDirectives: [],
    baseline: { commit: '', dirtyFingerprints: {} },
    telemetryWatermark: 0,
    checkpointDone: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastUserMessageHash: 'h',
    ...overrides,
  };
}

function runChain(env, repo, sessionId) {
  const out = execFileSync('node', [CHAIN], {
    input: JSON.stringify({ session_id: sessionId, cwd: repo, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    env: { ...process.env, HOOKS_CONFIG_PATH: env.configPath },
    maxBuffer: 8 * 1024 * 1024,
  });
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) { try { return JSON.parse(lines[i]); } catch { /* keep */ } }
  }
  return {};
}

const PASS_CMD = 'node -e "process.exit(0)"';
function failWithCount(countPath) {
  const p = countPath.replaceAll('\\', '/');
  return `node -e "const fs=require('fs');const p='${p}';fs.writeFileSync(p,String((Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)||0)+1));process.exit(1)"`;
}

/* ---------- synthetic command sets for policy decisions ---------- */
const QCMDS = [
  { id: 'fixture.config-contract', command: 'pnpm run check:config', classes: ['quality', 'config', 'targeted'] },
  { id: 'fixture.api-all-tests', command: 'uv run python -m pytest tests/ -q', classes: ['quality', 'full-suite'] },
];
const CAROPS_CMDS = [{ id: 'carops.config-contract', command: 'pnpm run check:config', classes: ['quality', 'config', 'targeted'] }];
const DELTA = { ok: true, uncertain: false, changedFiles: ['apps/web/x.ts'], fingerprint: 'fp-x' };
function envWith(directives = [], extra = {}) {
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, userDirectives: mergeDirectives([], directives), selectedRoutes: [], ...extra };
}

/* ================= 16 named scenarios ================= */

// 1
test('read-only-skips-all-heavy-completion-gates', () => {
  const gates = selectGates({ envelope: envWith(parseDirectives('read-only please')), delta: DELTA, qualityCommands: QCMDS });
  assert.ok(gates.every((g) => g.selection === 'skip' && g.failureDisposition === 'none'));
  // end-to-end: chain emits both skip and never blocks
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    const root = canonicalRoot(env.repo);
    writeManifest(env, root, { web: { paths: [{ prefixes: ['apps/web/'] }], commands: [{ label: 'q', command: PASS_CMD }] } });
    writeConfig(env, ['quality-completion-gate']);
    writeEnvelope(env, root, 's1', baseEnvelope(root, 's1', { userDirectives: mergeDirectives([], parseDirectives('read-only')), baseline: captureBaseline(env.repo) }));
    mkdirSync(join(env.repo, 'apps', 'web'), { recursive: true });
    writeFileSync(join(env.repo, 'apps', 'web', 'x.ts'), 'dirty');
    const out = runChain(env, env.repo, 's1');
    assert.equal(out.decision, undefined, 'read-only must not block');
    assert.ok(/quality=skip/.test(out.systemMessage || ''), out.systemMessage);
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 2
test('bypass-playwright-skips-browser-but-keeps-relevant-quality', () => {
  const gates = selectGates({ envelope: envWith(parseDirectives('do not run Playwright')), delta: DELTA, qualityCommands: QCMDS });
  assert.equal(gates.find((g) => g.gate === 'agent-diff-completion-gate').selection, 'skip');
  assert.equal(gates.find((g) => g.gate === 'quality-completion-gate').selection, 'run');
});

// 3
test('sidebar-layout-task-reports-oauth-api-findings-only', () => {
  // scope-locked layout task → dispositions are report-only (cannot block on unrelated)
  const gates = selectGates({ envelope: envWith(parseDirectives('do not change scope'), { allowedScopes: ['apps/web/'] }), delta: DELTA, qualityCommands: QCMDS, applicability: () => true });
  assert.ok(gates.every((g) => g.selection === 'skip' || g.failureDisposition === 'report-only'));
});

// 4
test('selected-ui-route-allows-browser-gate', () => {
  const gates = selectGates({ envelope: envWith([], { selectedRoutes: ['/dashboard'] }), delta: DELTA, qualityCommands: QCMDS, applicability: () => true });
  assert.equal(gates.find((g) => g.gate === 'agent-diff-completion-gate').selection, 'run');
});

// 5
test('no-task-relative-delta-skips-heavy-gates', () => {
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    const root = canonicalRoot(env.repo);
    writeManifest(env, root, { web: { paths: [{ prefixes: [''] }], commands: [{ label: 'q', command: PASS_CMD }] } });
    writeConfig(env, ['quality-completion-gate']);
    writeEnvelope(env, root, 's5', baseEnvelope(root, 's5', { baseline: captureBaseline(env.repo) }));
    const out = runChain(env, env.repo, 's5');
    assert.equal(out.decision, undefined);
    assert.ok(/quality=skip/.test(out.systemMessage || ''), out.systemMessage);
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 6
test('carops-config-only-selects-config-contract-only', () => {
  const gates = selectGates({ envelope: envWith([]), delta: { ok: true, uncertain: false, changedFiles: ['check.config.ts'], fingerprint: 'fp-c' }, qualityCommands: CAROPS_CMDS, applicability: () => true });
  const quality = gates.find((g) => g.gate === 'quality-completion-gate');
  assert.equal(quality.selection, 'run');
  assert.deepEqual(quality.commandIds, ['carops.config-contract']);
});

// 7
test('unchanged-blocker-is-not-rerun', () => {
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    const root = canonicalRoot(env.repo);
    const baseline = captureBaseline(env.repo);
    // commit a change during the task so there is a stable task delta
    mkdirSync(join(env.repo, 'app'), { recursive: true });
    writeFileSync(join(env.repo, 'app', 'feature.ts'), 'one'); commitAll(env.repo, 'task');
    const countPath = join(env.dir, 'runcount.txt');
    writeManifest(env, root, { code: { paths: [{ prefixes: ['app/'] }], commands: [{ label: 'q', command: failWithCount(countPath) }] } });
    writeConfig(env, ['quality-completion-gate']);
    writeEnvelope(env, root, 's7', baseEnvelope(root, 's7', { baseline }));
    const first = runChain(env, env.repo, 's7');
    assert.equal(first.decision, 'block', 'first run blocks on failing command: ' + JSON.stringify(first));
    assert.ok(/commands:/.test(first.reason || ''), 'block reason includes structured command detail: ' + JSON.stringify(first));
    const countAfterFirst = readFileSync(countPath, 'utf8');
    const second = runChain(env, env.repo, 's7');
    const countAfterSecond = readFileSync(countPath, 'utf8');
    assert.equal(countAfterSecond, countAfterFirst, 'command must NOT run again on unchanged blocker');
    assert.ok(/not rerun|unchanged input/i.test(second.reason || second.systemMessage || ''), 'second run reports unchanged blocker without rerun: ' + JSON.stringify(second));
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 8
test('stale-static-status-label-fails-runtime-validation', () => {
  assert.equal(isNeutralStopStatus('Running completion gates (quality, Playwright, review)'), false);
  assert.equal(isNeutralStopStatus('Evaluating Stop policy'), true);
  const fragment = readFileSync(join(HOOKS_ROOT, 'examples', 'codex', 'stop-hooks.fragment.toml'), 'utf8');
  assert.ok(codexStopStatusMessages(fragment).every(isNeutralStopStatus), 'example Codex Stop status must be neutral');
});

// 9
test('does-not-escalate-unrelated-browser-or-api-errors', () => {
  // scope-locked → any finding is report-only, never block
  const gates = selectGates({ envelope: envWith(parseDirectives('do not change scope')), delta: DELTA, qualityCommands: QCMDS, applicability: () => true });
  assert.ok(!gates.some((g) => g.failureDisposition === 'block'));
});

// 10
test('preexisting-dirty-files-are-not-task-changes', () => {
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    writeFileSync(join(env.repo, 'pre.ts'), 'dirty'); // pre-existing dirt
    const baseline = captureBaseline(env.repo);
    const delta = taskRelativeChanges(env.repo, baseline);
    assert.ok(!delta.changedFiles.includes('pre.ts'));
    assert.equal(delta.changedFiles.length, 0);
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 11
test('committed-during-task-files-remain-task-changes', () => {
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    const baseline = captureBaseline(env.repo);
    writeFileSync(join(env.repo, 'feature.ts'), 'new'); commitAll(env.repo, 'task');
    const delta = taskRelativeChanges(env.repo, baseline);
    assert.ok(delta.changedFiles.includes('feature.ts'));
    // chain selects quality=run for a non-empty delta
    const gates = selectGates({ envelope: envWith([]), delta, qualityCommands: QCMDS, applicability: () => true });
    assert.equal(gates.find((g) => g.gate === 'quality-completion-gate').selection, 'run');
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 12
test('missing-or-stale-envelope-runs-no-heavy-gate', () => {
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    const root = canonicalRoot(env.repo);
    writeManifest(env, root, { web: { paths: [{ prefixes: [''] }], commands: [{ label: 'q', command: PASS_CMD }] } });
    writeConfig(env, ['quality-completion-gate']);
    // no envelope written
    const out = runChain(env, env.repo, 'no-envelope');
    assert.equal(out.decision, undefined);
    assert.ok(/NOT run/i.test(out.systemMessage || ''), 'must say verification not performed: ' + out.systemMessage);
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 13
test('latest-explicit-directive-wins', () => {
  const merged = mergeDirectives(parseDirectives('read-only', '2026-01-01T00:00:00Z'), parseDirectives('you may edit now', '2026-01-02T00:00:00Z'));
  assert.ok(!merged.some((d) => d.kind === 'read-only'), 'later lift clears read-only');
});

// 14
test('integrity-policy-cannot-be-overridden', () => {
  const env = makeTempEnv();
  try {
    writeFileSync(join(env.repo, 'a.ts'), 'a'); commitAll(env.repo, 'init');
    const root = canonicalRoot(env.repo);
    const hooksDb = join(env.dir, 'hooks.db').replaceAll('\\', '/');
    // seed a fraudulent telemetry row
    execFileSync(process.env.HOOKS_PYTHON || 'python', ['-c', `
import sqlite3,sys
con=sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE hook_events(id INTEGER PRIMARY KEY, session_id TEXT, hook_id TEXT, tool_name TEXT, target TEXT, detail TEXT)")
con.execute("INSERT INTO hook_events(session_id,hook_id,tool_name,target,detail) VALUES('s14','hook-telemetry','Bash','x','node ui-snapshot.mjs --mock page.route')")
con.commit();con.close()
`, hooksDb]);
    writeManifest(env, root, { web: { paths: [{ prefixes: [''] }], commands: [{ label: 'q', command: PASS_CMD }] } });
    const config = structuredClone(REAL_CONFIG);
    config.shared.paths.qualityVerifyManifest = env.manifestPath;
    config.shared.paths.hooksDb = hooksDb;
    config.shared.taskPolicy = { ...(config.shared.taskPolicy || {}), stateDir: env.stateDir };
    config.scripts.find((s) => s.id === 'stop-completion-chain').settings = { chain: ['quality-completion-gate'] };
    writeFileSync(env.configPath, JSON.stringify(config, null, 2));
    // even with a read-only envelope (which would skip gates), integrity still blocks
    writeEnvelope(env, root, 's14', baseEnvelope(root, 's14', { userDirectives: mergeDirectives([], parseDirectives('read-only')), baseline: captureBaseline(env.repo) }));
    const out = runChain(env, env.repo, 's14');
    assert.equal(out.decision, 'block', 'integrity fraud must block even under read-only: ' + JSON.stringify(out));
    assert.ok(/integrity/i.test(out.reason || ''), out.reason);
  } finally { rmSync(env.dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
});

// 15
test('pretool-guard-denies-forbidden-heavy-command', () => {
  const d = decideGuard({
    toolName: 'Bash',
    toolInput: { command: 'uv run python -m pytest tests/ -q' },
    envelope: { schemaVersion: ENVELOPE_SCHEMA_VERSION, repoRoot: 'E:/repo', userDirectives: parseDirectives('do not run the full test suite') },
    envelopeOk: true,
  });
  assert.equal(d.action, 'deny');
});

// 16
test('report-only-output-has-no-remediation-directive', () => {
  // The chain's report-only message carries the hard non-redirect statement and
  // no imperative remediation verbs.
  const msg = `${HARD_NON_REDIRECT}`;
  assert.ok(/report-only/i.test(msg) || /must not be edited/i.test(msg));
  assert.ok(!/\b(fix|rerun|remediate|run waza|load skill)\b/i.test(msg.replace('rerun, or remediated', '')), 'no imperative remediation step');
  // forbiddenClassesFromDirectives is the chain mechanism that keeps browser/full-suite out
  assert.deepEqual(forbiddenClassesFromDirectives(parseDirectives('do not run Playwright')), ['browser']);
});

/* ---------- report ---------- */
let failed = 0;
let deferred = 0;
for (const [name, status, msg] of results) {
  if (status === 'fail') { failed += 1; console.error(`FAIL: ${name}\n      ${msg}`); }
  else if (status === 'defer') { deferred += 1; console.error(`DEFER: ${name} — ${msg}`); }
}
const passed = results.filter((r) => r[1] === 'pass').length;
if (failed) {
  console.error(`\nstop-policy-integration: ${failed} failed, ${passed} passed, ${deferred} deferred`);
  process.exit(1);
}
console.log(`stop-policy-integration: ${passed} passed, ${deferred} deferred (of ${results.length} named scenarios)`);
