import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

function runSelfTest(scriptPath, expectedId) {
  const stdout = execFileSync(process.execPath, [scriptPath, '--self-test'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    },
    maxBuffer: 10 * 1024 * 1024
  });

  assert.ok(stdout.trim(), `${expectedId} self-test must emit JSON`);
  const data = JSON.parse(stdout);
  assert.equal(data.id, expectedId);
  assert.equal(data.configLoaded, true);
  assert.equal(data.configControlsRuntime, true);
  assert.equal(data.protocolExists, true);
  assert.equal(data.memoryDbExists, true);
  assert.equal(data.memoryProvider, 'sqlite');
  assert.equal(data.memoryFallbackProvider, 'none');
  assert.equal(data.hindsightEndpoint, 'http://127.0.0.1:10003/mcp/collective/');
  assert.equal(data.injectRuntime.pythonMaxBufferBytes, 10485760);
  assert.equal(data.injectRuntime.transcriptTailBytes, 262144);
  assert.equal(data.memoryRecall.max, 4);
  assert.equal(data.memoryRecall.snippetChars, 900);
  assert.equal(data.memoryRecall.minTerms, 3);
  assert.equal(data.memoryRecall.candidatePool, 16);
  assert.equal(data.memoryScoring.relativeFloor, 65);
  assert.equal(data.memoryScoring.signals.fts.weight, 0.60);
  assert.equal(data.memoryScoring.signals.recency.weight, 0.25);
  assert.equal(data.memoryScoring.signals.recency.halfLifeDays, 14);
  assert.equal(data.memoryScoring.signals.confidence.weight, 0.15);
  assert.ok(Array.isArray(data.extractedTerms));
  assert.ok(data.sourceResults && typeof data.sourceResults === 'object');
  assert.ok(data.sourceResults.skills && typeof data.sourceResults.skills.ok === 'boolean');
  assert.ok(data.sourceResults.memory && typeof data.sourceResults.memory.ok === 'boolean');
  assert.ok(data.outputBudgets && Number.isInteger(data.outputBudgets.protocolChars));
}

runSelfTest(join(root, 'inject-protocol/inject-protocol.mjs'), 'inject-protocol');
console.log('inject protocol self-test verifier passed');
