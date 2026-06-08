import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { TRUNCATION_MARKER, composeOutput, projectFromCwd } from './inject-core.mjs';

const PROJECTS = Object.freeze([
  { slug: 'kai-chattr', kind: 'rebuild', repoPath: 'E:/kai-chattr', aliases: [] },
  { slug: 'kai', kind: 'rebuild', repoPath: 'E:/kai-ai', aliases: ['kai-ai'] },
  { slug: 'chattr', kind: 'legacy', repoPath: 'E:/chattr', aliases: [] }
]);

test('projectFromCwd matches exact repoPath and child paths', () => {
  assert.equal(projectFromCwd('E:\\KAI-CHATTR', PROJECTS), 'kai-chattr');
  assert.equal(projectFromCwd('E:/kai-chattr/apps/web', PROJECTS), 'kai-chattr');
});

test('projectFromCwd matches aliases only as full path segments', () => {
  assert.equal(projectFromCwd('E:/scratch/kai-ai/tools', PROJECTS), 'kai');
  assert.equal(projectFromCwd('E:/scratch/not-kai-ai-copy/tools', PROJECTS), '');
});

test('projectFromCwd rejects substring lookalikes', () => {
  assert.equal(projectFromCwd('E:/sandbox/kai-chattr-copy', PROJECTS), '');
  assert.equal(projectFromCwd('E:/sandbox/mychattr', PROJECTS), '');
});

test('composeOutput caps at section boundaries with explicit marker', () => {
  const rules = 'RULES';
  const labels = { skills: '## Skills', memory: '## Memory' };
  const suggested = [{ name: 'systematic-debugging' }, { name: 'refactor' }];
  const memories = [{ text: 'memory text '.repeat(20).trim() }];
  const skillsSection = '\n\n## Skills\n- systematic-debugging\n- refactor';
  const cap = rules.length + skillsSection.length + 2 + TRUNCATION_MARKER.length;

  const output = composeOutput(rules, suggested, memories, labels, cap);

  assert.equal(output, `${rules}${skillsSection}\n\n${TRUNCATION_MARKER}`);
  assert.ok(output.length <= cap);
  assert.ok(!output.includes('## Memory'));
  assert.ok(!output.includes('memory text'));
});

test('composeOutput applies per-section budgets before the total cap', () => {
  const labels = { diagnostics: '## Diagnostics', skills: '## Skills', memory: '## Memory' };
  const output = composeOutput(
    'RULES',
    [{ name: 'systematic-debugging' }],
    [{ text: 'memory text '.repeat(50).trim() }],
    labels,
    500,
    { protocolChars: 100, diagnosticsChars: 100, skillsChars: 100, memoryChars: 120 },
    ['memory recall failed because sqlite is locked']
  );

  assert.match(output, /## Diagnostics/);
  assert.match(output, /## Skills/);
  assert.match(output, /## Memory/);
  assert.ok(output.length <= 500);
  assert.match(output, new RegExp(TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('active injector is wired to shared core helpers', () => {
  const source = readFileSync(new URL('./inject-protocol.mjs', import.meta.url), 'utf8');

  assert.match(source, /from '\.\/inject-core\.mjs'/);
  assert.match(source, /projectFromCwd\(cwd,\s*SHARED\.projects\.entries\)/);
  assert.match(source, /composeOutput\(\s*rules,\s*skillResult\.rows,\s*memoryResult\.rows,\s*labels,\s*S\.output\.capChars,\s*S\.output\.budgets,\s*diagnostics\s*\)/);
  assert.doesNotMatch(source, /c\.includes\('\/' \+ token\)/);
});
