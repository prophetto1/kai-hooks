#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  lintConfig,
  samplePayload,
  validateHookOutput,
} from './test-hook.mjs';

const config = JSON.parse(readFileSync('E:/hooks/config.json', 'utf8'));

assert.equal(samplePayload('UserPromptSubmit').hook_event_name, 'UserPromptSubmit');
assert.equal(samplePayload('PreToolUse').tool_name, 'Write');
assert.equal(samplePayload('Stop').reason, 'sample stop check');

assert.equal(
  validateHookOutput('PreToolUse', JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
  })).ok,
  true,
);
assert.equal(
  validateHookOutput('PreToolUse', JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'later' },
  })).ok,
  false,
);

const lint = lintConfig(config);
assert.deepEqual(lint.errors, [], lint.errors.join('\n'));

const stale = structuredClone(config);
stale.shared.paths.skillsWarehouse = 'E:/__skills';
stale.scripts.find((entry) => entry.id === 'skill-indexer').settings.scanRoots = [
  { path: 'E:/__skills', source: 'warehouse', scope: 'all' },
];
assert.ok(
  lintConfig(stale).errors.some((error) => error.includes('__skills')),
  'hook-dev linter must catch stale skill roots',
);

console.log('hook-dev-tools tests passed');
