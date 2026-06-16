import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'agent-diff-completion-gate.mjs');

assert.ok(existsSync(SCRIPT), 'agent-diff-completion-gate.mjs exists');
execFileSync(process.execPath, ['--check', SCRIPT], { stdio: 'pipe' });

console.log('agent-diff-completion-gate smoke: syntax ok');
