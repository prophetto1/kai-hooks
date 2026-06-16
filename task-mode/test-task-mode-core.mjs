import assert from 'node:assert/strict';
import { classifyMode, isMutatingTool, parseExplicitMode } from './task-mode-core.mjs';

assert.equal(parseExplicitMode('mode: refactor\nExtract module'), 'refactor');
assert.equal(classifyMode('code review this PR'), 'review');
assert.equal(classifyMode('fix the failing websocket test'), 'fix');
assert.equal(classifyMode('how does auth work'), 'explore');
assert.equal(isMutatingTool('Read'), false);
assert.equal(isMutatingTool('Write'), true);

console.log('task-mode-core tests passed');
