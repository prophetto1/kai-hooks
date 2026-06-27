#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  blockReason,
  lastJsonLine,
  phaseInput,
  shouldRunQualityPhase,
  shouldRunRiskPhase,
} from './completion-quality-core.mjs';

assert.deepEqual(lastJsonLine('noise\n{"continue":true}\n'), { continue: true });
assert.equal(blockReason({ decision: 'block', reason: 'quality failed' }), 'quality failed');
assert.equal(blockReason({ continue: false, systemMessage: 'risk failed' }), 'risk failed');
assert.equal(blockReason({ continue: true }), null);

const input = {
  cwd: 'E:/kai-chattr',
  taskPolicy: {
    gate: 'completion-quality-gate',
    taskChangedFiles: ['apps/web/src/app.tsx'],
    commandIds: [],
    forbiddenClasses: ['browser'],
  },
};

assert.equal(shouldRunRiskPhase(input), false, 'browser-verification directive skips only the risk phase');
assert.equal(shouldRunRiskPhase({ taskPolicy: { forbiddenClasses: [] } }), true);
assert.equal(shouldRunQualityPhase(input), false, 'empty commandIds skip only the quality phase');
assert.equal(shouldRunQualityPhase({ taskPolicy: { commandIds: ['q'] } }), true);
assert.equal(shouldRunQualityPhase({}), true, 'direct invocation keeps legacy quality behavior');
assert.deepEqual(
  phaseInput(input, 'quality-completion-gate').taskPolicy,
  {
    gate: 'quality-completion-gate',
    taskChangedFiles: ['apps/web/src/app.tsx'],
    commandIds: [],
    forbiddenClasses: ['browser'],
  },
  'phase input must preserve the shared task-relative changed-file model',
);

console.log('completion-quality-gate tests passed');
