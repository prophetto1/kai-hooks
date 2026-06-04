#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { changedFiles, touchedDomains } from './quality-gate-core.mjs';

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

function testChangedFilesHandlesSpacesAndRenames() {
  withRepo((repo) => {
    write(repo, 'docs/old name.md', 'old');
    git(repo, ['add', 'docs/old name.md']);
    git(repo, ['commit', '-m', 'seed']);

    mkdirSync(join(repo, 'docs'), { recursive: true });
    renameSync(join(repo, 'docs', 'old name.md'), join(repo, 'docs', 'new name.md'));
    git(repo, ['add', '-A']);
    write(repo, 'quality-completion-gate/file with spaces.mjs', 'new');

    assert.deepEqual(changedFiles(repo, 10000), [
      'docs/new name.md',
      'quality-completion-gate/file with spaces.mjs'
    ]);
  });
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

testChangedFilesHandlesSpacesAndRenames();
testTouchedDomainsReportsUnmatchedNormalizedPaths();
console.log('quality gate core tests passed');
