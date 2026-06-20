#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  blockReason,
  configuredChain,
  lastJsonLine,
} from './stop-completion-chain.mjs';

const hooks = [
  {
    id: 'memory-harvester',
    enabled: true,
    script: { path: 'memory-harvester/harvest-stop.py', runtime: 'python' },
  },
  {
    id: 'agent-diff-completion-gate',
    enabled: true,
    script: { path: 'agent-diff-completion-gate/agent-diff-completion-gate.mjs', runtime: 'node' },
  },
  {
    id: 'quality-completion-gate',
    enabled: true,
    script: { path: 'quality-completion-gate/quality-completion-gate.mjs', runtime: 'node' },
  },
];

const config = {
  hooks,
  scripts: [
    {
      id: 'stop-completion-chain',
      settings: {
        chain: ['memory-harvester', 'agent-diff-completion-gate', 'quality-completion-gate'],
      },
    },
  ],
};

assert.deepEqual(
  configuredChain(config).map((step) => step.id),
  ['memory-harvester', 'agent-diff-completion-gate', 'quality-completion-gate'],
  'stop-completion-chain must honor scripts[id=stop-completion-chain].settings.chain order',
);
assert.equal(configuredChain(config)[0].failOpenPreStep, true, 'memory-harvester remains fail-open pre-step');

const disabled = structuredClone(config);
disabled.hooks.find((hook) => hook.id === 'agent-diff-completion-gate').enabled = false;
assert.deepEqual(
  configuredChain(disabled).map((step) => step.id),
  ['memory-harvester', 'quality-completion-gate'],
  'disabled hooks are omitted from the configured stop chain',
);

assert.deepEqual(lastJsonLine('noise\n{"continue":true}\n'), { continue: true });
assert.equal(blockReason({ decision: 'block', reason: 'verify failed' }), 'verify failed');

console.log('stop-completion-chain tests passed');
