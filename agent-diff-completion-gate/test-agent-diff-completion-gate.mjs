#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOOKS = 'E:/hooks';
const SCRIPT = join(HOOKS, 'agent-diff-completion-gate', 'agent-diff-completion-gate.mjs');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(repo, file, content = 'fixture\n') {
  const path = join(repo, ...file.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-diff-gate-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Agent Diff Gate Test']);
  write(repo, 'README.md', 'seed\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'seed']);
  write(repo, 'verify-live.mjs', `
import { mkdirSync, writeFileSync } from 'node:fs';
const runDir = 'docs/verification/test-run';
mkdirSync(runDir, { recursive: true });
writeFileSync(runDir + '/run.json', JSON.stringify({ liveApi: true, frontendLogin: true }));
writeFileSync(runDir + '/report.json', JSON.stringify([{ status: 'ok', screenshot: runDir + '/home.png' }]));
writeFileSync(runDir + '/home.png', 'png');
console.log('VERIFICATION_RUN_SUMMARY:' + JSON.stringify({ ok: true, runDir, timestamp: 'test' }));
`);
  return repo;
}

function configFor(repo, policyOverrides = {}) {
  const policy = {
    name: 'fixture',
    root: repo.replaceAll('\\', '/'),
    enabled: true,
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.py', '.json'],
    rules: [
      {
        name: 'runtime',
        paths: [{ prefixes: ['apps/', 'services/', 'scripts/'] }],
        trigger: {
          mode: 'files-or-loc',
          minChangedFiles: 2,
          minChangedLoc: 5,
        },
      },
    ],
    tiers: { largeLocMin: 20 },
    verification: {
      command: 'node verify-live.mjs',
      timeoutMs: 30000,
      label: 'fixture live verification',
      verificationDir: 'docs/verification',
      requireLiveApi: true,
      requireFrontendLogin: true,
    },
    ...policyOverrides,
  };
  return {
    shared: {
      paths: {
        hooksDb: join(repo, 'missing-hooks.db').replaceAll('\\', '/'),
      },
      runtime: {
        gitTimeoutMs: 10000,
        verifyCommandTimeoutMs: 30000,
      },
    },
    hooks: [
      {
        id: 'agent-diff-completion-gate',
        enabled: true,
        settings: {
          failureMode: 'block',
          maxRepeatedBlocks: 3,
          maxRemediationLoops: 3,
          locLargeMin: 20,
          stateDir: join(repo, '.state').replaceAll('\\', '/'),
          repos: [policy],
        },
      },
    ],
  };
}

function invoke(repo, config) {
  const configPath = join(repo, 'config.json');
  writeJson(configPath, config);
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    input: JSON.stringify({ session_id: `session-${Date.now()}-${Math.random()}`, cwd: repo, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    env: { ...process.env, HOOKS_CONFIG_PATH: configPath },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout || '{}');
}

function withRepo(fn) {
  const repo = initRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  }
}

function assertAllowed(result, message) {
  assert.deepEqual(result, { continue: true }, message);
}

function assertBlocked(result, match, message) {
  assert.equal(result.decision, 'block', message);
  assert.match(result.reason, match, message);
}

assert.ok(existsSync(SCRIPT), 'agent-diff-completion-gate.mjs exists');
execFileSync(process.execPath, ['--check', SCRIPT], { stdio: 'pipe' });

withRepo((repo) => {
  write(repo, 'docs/readme.md', 'outside\n');
  assertAllowed(invoke(repo, configFor(repo)), 'outside configured paths allows');
});

withRepo((repo) => {
  write(repo, 'apps/web/a.ts', 'one\n');
  write(repo, 'apps/web/b.ts', 'two\n');
  const result = invoke(repo, configFor(repo));
  assertBlocked(result, /Phase: verification-before-completion/, 'file-count threshold blocks');
  assert.match(result.reason, /runtime \(2 file\(s\), \d+ LOC\)/);
});

withRepo((repo) => {
  write(repo, 'apps/web/a.ts', '1\n2\n3\n4\n5\n');
  const result = invoke(repo, configFor(repo));
  assertBlocked(result, /Phase: verification-before-completion/, 'LOC threshold blocks');
  assert.match(result.reason, /runtime \(1 file\(s\), \d+ LOC\)/);
});

withRepo((repo) => {
  write(repo, 'apps/web/a.ts', 'one\n');
  assertAllowed(invoke(repo, configFor(repo)), 'below file and LOC thresholds allows');
});

withRepo((repo) => {
  write(repo, 'apps/web/a.ts', '1\n2\n3\n4\n5\n');
  assertAllowed(invoke(repo, configFor(repo, { enabled: false, reason: 'deferred' })), 'disabled repo policy allows');
});

withRepo((repo) => {
  write(repo, 'apps/web/a.ts', Array.from({ length: 20 }, (_, index) => String(index)).join('\n') + '\n');
  const result = invoke(repo, configFor(repo));
  assertBlocked(result, /waza-hunt/, 'large LOC tier includes waza-hunt requirement');
});

console.log('agent-diff-completion-gate tests passed');
