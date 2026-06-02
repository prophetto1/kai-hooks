#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  generateConfigSchema,
  validateConfig,
} from '../lib/config-model.mjs';

const config = JSON.parse(readFileSync('E:/hooks/config.json', 'utf8'));

const current = validateConfig(config);
assert.deepEqual(current.errors, [], current.errors.join('\n'));

const badEvent = structuredClone(config);
badEvent.hooks[0].event = 'PromptSubmit';
const badEventResult = validateConfig(badEvent);
assert.ok(
  badEventResult.errors.some((error) => error.includes('hooks[0].event')),
  'invalid hook event must be rejected'
);

const badRuntime = structuredClone(config);
badRuntime.hooks[0].script.runtime = 'bash';
const badRuntimeResult = validateConfig(badRuntime);
assert.ok(
  badRuntimeResult.errors.some((error) => error.includes('hooks[0].script.runtime')),
  'invalid script runtime must be rejected'
);

const badTokenizer = structuredClone(config);
badTokenizer.hooks[0].settings.terms.tokenRegexFlags = 'g';
const badTokenizerResult = validateConfig(badTokenizer);
assert.ok(
  badTokenizerResult.errors.some((error) => error.includes('tokenRegexFlags')),
  'tokenizer flags must be validated against the model'
);

const badMemorySignal = structuredClone(config);
badMemorySignal.hooks[0].settings.sources.memory.scoring.signals.fts.weight = 1.2;
const badMemorySignalResult = validateConfig(badMemorySignal);
assert.ok(
  badMemorySignalResult.errors.some((error) => error.includes('memory.scoring.signals.fts.weight')),
  'memory scoring signal weights must be validated against the model'
);

const badSkillWeights = structuredClone(config);
badSkillWeights.hooks[0].settings.sources.skills.scoring.signals.fts.weight = 0.7;
const badSkillWeightsResult = validateConfig(badSkillWeights);
assert.ok(
  badSkillWeightsResult.errors.some((error) => error.includes('skills.scoring signal weights must sum to 1.0')),
  'skill scoring signal weights must sum to 1.0'
);

const schema = generateConfigSchema();
assert.equal(schema.$id, 'file:///E:/hooks/config.schema.json');
assert.ok(schema.$defs.hook.properties.event.enum.includes('UserPromptSubmit'));
assert.ok(schema.$defs.scriptRef.properties.runtime.enum.includes('node'));
assert.ok(schema.$defs.scriptRef.properties.runtime.enum.includes('python'));
assert.deepEqual(schema.$defs.injectSettings.properties.terms.properties.tokenRegexFlags.enum, ['gu']);
assert.equal(schema.$defs.scoreScale.properties.max.const, 100);
assert.equal(schema.$defs.memoryScoring.properties.missingSignalPolicy.const, 'drop-candidate');
assert.equal(schema.$defs.skillsScoring.properties.signals.properties.fts.$ref, '#/$defs/skillFtsSignal');

console.log('config model tests passed');
