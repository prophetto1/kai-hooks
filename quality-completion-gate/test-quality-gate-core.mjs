#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { changedFiles, gitRoot, runVerifyCommand, touchedDomains } from './quality-gate-core.mjs';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'quality-gate-core-'));
  try {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Quality Gate Test']);
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function withRepoAsync(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'quality-gate-core-'));
  try {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Quality Gate Test']);
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function write(repo, file, content = 'fixture') {
  const path = join(repo, ...file.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function lockPath(stateDir, repo) {
  return join(stateDir, 'locks', `${hash({ repoRoot: repo.replaceAll('\\', '/') })}.lock`);
}

function stopGate(payload, env) {
  const result = spawnSync('node', ['quality-completion-gate/quality-completion-gate.mjs'], {
    cwd: 'E:/hooks',
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startStopGate(payload, env) {
  const child = spawn('node', ['quality-completion-gate/quality-completion-gate.mjs'], {
    cwd: 'E:/hooks',
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  const chunks = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    chunks.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    chunks.stderr += chunk.toString();
  });
  child.stdin.end(JSON.stringify(payload));
  return { child, chunks };
}

function waitForStopGate(run) {
  return new Promise((resolve) => {
    run.child.on('close', (status) => {
      resolve({ status, stdout: run.chunks.stdout, stderr: run.chunks.stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function configFor(manifestPath, stateDir, settings = {}) {
  return {
    shared: {
      paths: {
        hooksDir: 'E:/hooks',
        qualityVerifyManifest: manifestPath
      },
      runtime: {
        gitTimeoutMs: 10000,
        verifyCommandTimeoutMs: 1000
      }
    },
    hooks: [
      {
        id: 'quality-completion-gate',
        enabled: true,
        settings: {
          verifyManifest: manifestPath,
          maxRepeatedFailureBlocks: 3,
          totalBudgetMs: 90000,
          stateDir,
          ...settings
        }
      }
    ]
  };
}

function manifestFor(repo, commands) {
  return {
    repos: [
      {
        name: 'fixture',
        root: repo,
        blockOnUnmatched: true,
        domains: {
          runtime: {
            paths: [{ prefixes: ['quality-completion-gate/'] }],
            commands
          }
        }
      }
    ]
  };
}

function testChangedFilesHandlesSpacesAndRenames() {
  withRepo((repo) => {
    write(repo, 'docs/old name.md', 'old');
    git(repo, ['add', 'docs/old name.md']);
    git(repo, ['commit', '-m', 'seed']);

    mkdirSync(join(repo, 'docs'), { recursive: true });
    renameSync(join(repo, 'docs', 'old name.md'), join(repo, 'docs', 'new name.md'));
    git(repo, ['add', '-A']);
    write(repo, 'quality-completion-gate/file with spaces.mjs', 'new');

    const result = changedFiles(repo, 10000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [
      'docs/new name.md',
      'quality-completion-gate/file with spaces.mjs'
    ]);
  });
}

function testGitInspectionReturnsStructuredFailures() {
  const result = gitRoot(join(tmpdir(), 'missing-quality-gate-repo'), 10000);
  assert.equal(result.ok, false);
  assert.equal(result.value, '');
  assert.match(result.error, /git/i);
}

function testTouchedDomainsReportsUnmatchedNormalizedPaths() {
  const repoEntry = {
    blockOnUnmatched: true,
    domains: {
      runtime: {
        paths: [{ prefixes: ['quality-completion-gate/'] }],
        commands: [{ label: 'runtime', command: 'node --version' }]
      }
    }
  };
  const { touched, unmatched } = touchedDomains(repoEntry, [
    'quality-completion-gate/file with spaces.mjs',
    'docs/new name.md'
  ]);
  assert.deepEqual([...touched.keys()], ['runtime']);
  assert.deepEqual(touched.get('runtime'), ['quality-completion-gate/file with spaces.mjs']);
  assert.deepEqual(unmatched, ['docs/new name.md']);
}

function testReportOnlyFailureStopsWithoutBlock() {
  withRepo((repo) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-gate-report-only-'));
    const manifestPath = join(root, 'manifest.json');
    const configPath = join(root, 'config.json');
    const stateDir = join(root, 'state');
    write(repo, 'quality-completion-gate/failing.mjs', 'dirty');
    writeJson(manifestPath, manifestFor(repo, [
      { label: 'always fails', command: 'node -e "process.exit(7)"', timeoutMs: 1000 }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir, { failureMode: 'report-only' }));

    const result = stopGate(
      { session_id: 'report-only-session', cwd: repo, hook_event_name: 'Stop' },
      { HOOKS_CONFIG_PATH: configPath },
    );

    assert.equal(result.continue, true);
    assert.equal(result.haltChain, true);
    assert.equal(result.decision, undefined);
    assert.match(result.systemMessage, /COMPLETION GATE FAILED \(report only/i);
    assert.match(result.systemMessage, /always fails/);

    rmSync(root, { recursive: true, force: true });
  });
}

function testStopContinuationRerunsVerificationAndLoopsOut() {
  withRepo((repo) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-gate-stop-'));
    const manifestPath = join(root, 'manifest.json');
    const configPath = join(root, 'config.json');
    const stateDir = join(root, 'state');
    write(repo, 'quality-completion-gate/failing.mjs', 'dirty');
    writeJson(manifestPath, manifestFor(repo, [
      { label: 'always fails', command: 'node -e "process.exit(7)"', timeoutMs: 1000 }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir, { failureMode: 'block' }));

    const env = { HOOKS_CONFIG_PATH: configPath };
    const payload = { session_id: 'loop-session', cwd: repo, hook_event_name: 'Stop' };
    const first = stopGate(payload, env);
    const second = stopGate({ ...payload, stop_hook_active: true }, env);
    const third = stopGate({ ...payload, stop_hook_active: true }, env);

    assert.equal(first.decision, 'block');
    assert.equal(second.decision, 'block');
    assert.equal(third.continue, true);
    assert.match(third.systemMessage, /repeated 3 times/i);

    rmSync(root, { recursive: true, force: true });
  });
}

function testStopBudgetLimitsSlowCommands() {
  withRepo((repo) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-gate-budget-'));
    const manifestPath = join(root, 'manifest.json');
    const configPath = join(root, 'config.json');
    const stateDir = join(root, 'state');
    write(repo, 'quality-completion-gate/slow.mjs', 'dirty');
    writeJson(manifestPath, manifestFor(repo, [
      {
        label: 'slow command',
        command: 'node -e "setTimeout(() => {}, 200)"',
        timeoutMs: 1000
      }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir, { failureMode: 'block', totalBudgetMs: 25 }));

    const result = stopGate({ session_id: 'budget-session', cwd: repo, hook_event_name: 'Stop' }, { HOOKS_CONFIG_PATH: configPath });

    assert.equal(result.decision, 'block');
    assert.match(result.reason, /budget/i);

    rmSync(root, { recursive: true, force: true });
  });
}

function testStateWriteFailureStillBlocks() {
  withRepo((repo) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-gate-state-fail-'));
    const manifestPath = join(root, 'manifest.json');
    const configPath = join(root, 'config.json');
    const stateDir = join(root, 'state');
    const statePath = join(stateDir, `${hash({ sessionId: 'state-fail-session' })}.json`);
    write(repo, 'quality-completion-gate/failing.mjs', 'dirty');
    mkdirSync(statePath, { recursive: true });
    writeJson(manifestPath, manifestFor(repo, [
      { label: 'always fails', command: 'node -e "process.exit(7)"', timeoutMs: 1000 }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir, { failureMode: 'block' }));

    const result = stopGate({ session_id: 'state-fail-session', cwd: repo, hook_event_name: 'Stop' }, { HOOKS_CONFIG_PATH: configPath });

    assert.equal(result.decision, 'block');
    assert.match(result.reason, /always fails/);

    rmSync(root, { recursive: true, force: true });
  });
}

function testRunVerifyCommandHonorsCommandEnv() {
  withRepo((repo) => {
    const result = runVerifyCommand(
      repo,
      {
        label: 'env command',
        command: 'node -e "if (process.env.QUALITY_GATE_ENV_TEST !== process.env.LOCALAPPDATA) process.exit(3)"',
        env: { QUALITY_GATE_ENV_TEST: '%LOCALAPPDATA%' },
        timeoutMs: 1000
      },
      1000
    );

    assert.equal(result.ok, true, result.output);
  });
}

async function testConcurrentQualityGateBlocksWithoutRunningCommandsTwice() {
  await withRepoAsync(async (repo) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-gate-single-flight-'));
    const manifestPath = join(root, 'manifest.json');
    const configPath = join(root, 'config.json');
    const stateDir = join(root, 'state');
    const markerPath = join(root, 'slow-command-started.txt').replaceAll('\\', '/');
    write(repo, 'quality-completion-gate/slow.mjs', 'dirty');
    writeJson(manifestPath, manifestFor(repo, [
      {
        label: 'slow pass',
        command: `node -e "require('fs').writeFileSync('${markerPath}', 'started'); setTimeout(() => {}, 750)"`,
        timeoutMs: 5000
      }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir, {
      totalBudgetMs: 5000,
      singleFlightStaleMs: 10000
    }));

    const env = { HOOKS_CONFIG_PATH: configPath };
    const payload = { session_id: 'single-flight-session', cwd: repo, hook_event_name: 'Stop' };
    const first = startStopGate(payload, env);
    await waitForFile(markerPath, 2000);

    const startedAt = Date.now();
    const second = stopGate({ ...payload, session_id: 'single-flight-session-2' }, env);
    assert.equal(second.continue, true);
    assert.equal(second.haltChain, true);
    assert.match(second.systemMessage, /already running/i);
    assert.ok(Date.now() - startedAt < 500, 'second gate should not wait for the slow command');

    const firstResult = await waitForStopGate(first);
    assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
    assert.deepEqual(JSON.parse(firstResult.stdout), { continue: true });

    rmSync(root, { recursive: true, force: true });
  });
}

function testDeadOwnerSingleFlightLockIsCleared() {
  withRepo((repo) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-gate-dead-lock-'));
    const manifestPath = join(root, 'manifest.json');
    const configPath = join(root, 'config.json');
    const stateDir = join(root, 'state');
    const path = lockPath(stateDir, repo);
    write(repo, 'quality-completion-gate/dirty.mjs', 'dirty');
    writeJson(manifestPath, manifestFor(repo, [
      { label: 'passes', command: 'node -e "process.exit(0)"', timeoutMs: 1000 }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir, {
      totalBudgetMs: 5000,
      singleFlightStaleMs: 60000
    }));
    mkdirSync(join(stateDir, 'locks'), { recursive: true });
    writeJson(path, {
      token: 'dead-owner',
      pid: 999999,
      repoRoot: repo.replaceAll('\\', '/'),
      startedAt: new Date().toISOString()
    });

    const result = stopGate({ session_id: 'dead-owner-session', cwd: repo, hook_event_name: 'Stop' }, { HOOKS_CONFIG_PATH: configPath });
    assert.deepEqual(result, { continue: true });
    assert.equal(existsSync(path), false);

    rmSync(root, { recursive: true, force: true });
  });
}

testChangedFilesHandlesSpacesAndRenames();
testGitInspectionReturnsStructuredFailures();
testTouchedDomainsReportsUnmatchedNormalizedPaths();
testReportOnlyFailureStopsWithoutBlock();
testStopContinuationRerunsVerificationAndLoopsOut();
testStopBudgetLimitsSlowCommands();
testStateWriteFailureStillBlocks();
testRunVerifyCommandHonorsCommandEnv();
await testConcurrentQualityGateBlocksWithoutRunningCommandsTwice();
testDeadOwnerSingleFlightLockIsCleared();
console.log('quality gate core tests passed');
