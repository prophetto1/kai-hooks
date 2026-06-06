#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { changedFiles, gitRoot, touchedDomains } from './quality-gate-core.mjs';

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

function write(repo, file, content = 'fixture') {
  const path = join(repo, ...file.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
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
    writeJson(configPath, configFor(manifestPath, stateDir));

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
    writeJson(configPath, configFor(manifestPath, stateDir, { totalBudgetMs: 25 }));

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
    const stateDir = join(root, 'state-file');
    write(repo, 'quality-completion-gate/failing.mjs', 'dirty');
    writeFileSync(stateDir, 'not a directory', 'utf8');
    writeJson(manifestPath, manifestFor(repo, [
      { label: 'always fails', command: 'node -e "process.exit(7)"', timeoutMs: 1000 }
    ]));
    writeJson(configPath, configFor(manifestPath, stateDir));

    const result = stopGate({ session_id: 'state-fail-session', cwd: repo, hook_event_name: 'Stop' }, { HOOKS_CONFIG_PATH: configPath });

    assert.equal(result.decision, 'block');
    assert.match(result.reason, /always fails/);

    rmSync(root, { recursive: true, force: true });
  });
}

testChangedFilesHandlesSpacesAndRenames();
testGitInspectionReturnsStructuredFailures();
testTouchedDomainsReportsUnmatchedNormalizedPaths();
testStopContinuationRerunsVerificationAndLoopsOut();
testStopBudgetLimitsSlowCommands();
testStateWriteFailureStillBlocks();
console.log('quality gate core tests passed');
