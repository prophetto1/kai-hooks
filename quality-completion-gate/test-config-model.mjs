#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  generateConfigSchema,
  validateConfig,
} from '../_core/config-model.mjs';

const config = JSON.parse(readFileSync('E:/hooks/config.json', 'utf8'));

function hookById(source, id) {
  const hook = source.hooks.find((entry) => entry.id === id);
  assert.ok(hook, `${id} hook must be present`);
  return hook;
}

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

const badComplexScript = structuredClone(config);
hookById(badComplexScript, 'inject-protocol-complex').script.path = 'inject-protocol/inject-protocol.mjs';
const badComplexScriptResult = validateConfig(badComplexScript);
assert.ok(
  badComplexScriptResult.errors.some((error) => error.includes('inject-protocol-complex.script.path mismatch')),
  'inject-protocol-complex script path must be semantically validated'
);

const badMemoryNormalizerWrite = structuredClone(config);
hookById(badMemoryNormalizerWrite, 'memory-normalizer').settings.writes.contentMutation = true;
const badMemoryNormalizerWriteResult = validateConfig(badMemoryNormalizerWrite);
assert.ok(
  badMemoryNormalizerWriteResult.errors.some((error) => error.includes('memory-normalizer settings.writes.contentMutation must be false')),
  'memory-normalizer must reject content mutation settings'
);

const badMemoryNormalizerSourceTools = structuredClone(config);
const memoryNormalizerWithDrift = hookById(badMemoryNormalizerSourceTools, 'memory-normalizer');
memoryNormalizerWithDrift.settings.sourceTools = memoryNormalizerWithDrift.settings.sourceTools.filter((tool) => tool !== 'memory_update');
const badMemoryNormalizerSourceToolsResult = validateConfig(badMemoryNormalizerSourceTools);
assert.ok(
  badMemoryNormalizerSourceToolsResult.errors.some((error) => error.includes('memory-normalizer match.tools must equal settings.sourceTools')),
  'memory-normalizer must reject sourceTools drift from match.tools'
);

const badQualityAuthority = structuredClone(config);
hookById(badQualityAuthority, 'quality-completion-gate').settings.authority = 'assistant-claims';
const badQualityAuthorityResult = validateConfig(badQualityAuthority);
assert.ok(
  badQualityAuthorityResult.errors.some((error) => error.includes('quality-completion-gate settings.authority must be exit-codes-only')),
  'quality-completion-gate authority must remain exit-code based'
);

const badThinkingTools = structuredClone(config);
const thinkingGate = hookById(badThinkingTools, 'thinking-gate');
assert.equal(thinkingGate.settings.toolClasses, undefined, 'thinking-gate must not define toolClasses');
assert.equal(thinkingGate.settings.readOnlyShellPrefixes, undefined, 'thinking-gate must not define readOnlyShellPrefixes');
assert.equal(thinkingGate.settings.grantPolicy.consumeReadOnly, undefined, 'thinking-gate must not define read-only grant exemptions');
thinkingGate.settings.thinkingTools = [];
const badThinkingToolsResult = validateConfig(badThinkingTools);
assert.ok(
  badThinkingToolsResult.errors.some((error) => error.includes('thinking-gate settings.thinkingTools')),
  'thinking-gate must require at least one configured thinking tool'
);

const badThinkingConsumptionTable = structuredClone(config);
hookById(badThinkingConsumptionTable, 'thinking-gate').settings.consumptionTable = 'bad-table-name';
const badThinkingConsumptionTableResult = validateConfig(badThinkingConsumptionTable);
assert.ok(
  badThinkingConsumptionTableResult.errors.some((error) => error.includes('thinking-gate settings.consumptionTable')),
  'thinking-gate consumption table must be a SQL identifier'
);

const badThinkingBootstrap = structuredClone(config);
hookById(badThinkingBootstrap, 'thinking-gate').settings.bootstrapTools.ToolSearch = [];
const badThinkingBootstrapResult = validateConfig(badThinkingBootstrap);
assert.ok(
  badThinkingBootstrapResult.errors.some((error) => error.includes('thinking-gate settings.bootstrapTools')),
  'thinking-gate bootstrap tools must use non-empty term arrays'
);

const badThinkingGrant = structuredClone(config);
hookById(badThinkingGrant, 'thinking-gate').settings.grantPolicy.maxToolUses = 0;
const badThinkingGrantResult = validateConfig(badThinkingGrant);
assert.ok(
  badThinkingGrantResult.errors.some((error) => error.includes('thinking-gate settings.grantPolicy.maxToolUses')),
  'thinking-gate bounded grant count must be positive'
);

const badThinkingToolClass = structuredClone(config);
hookById(badThinkingToolClass, 'thinking-gate').settings.toolClasses = { readOnly: ['Read'] };
const badThinkingToolClassResult = validateConfig(badThinkingToolClass);
assert.ok(
  badThinkingToolClassResult.errors.some((error) => error.includes('thinking-gate settings.toolClasses is not supported')),
  'thinking-gate tool classes must be rejected'
);

const badReadOnlyPolicy = structuredClone(config);
hookById(badReadOnlyPolicy, 'thinking-gate').settings.grantPolicy.consumeReadOnly = false;
const badReadOnlyPolicyResult = validateConfig(badReadOnlyPolicy);
assert.ok(
  badReadOnlyPolicyResult.errors.some((error) => error.includes('thinking-gate settings.grantPolicy.consumeReadOnly is not supported')),
  'thinking-gate read-only grant exemptions must be rejected'
);

const schema = generateConfigSchema();
const hookEventSchema = schema.$defs.hook.properties.event;
assert.equal(schema.$id, 'file:///E:/hooks/config.schema.json');
assert.ok(hookEventSchema.oneOf[0].enum.includes('UserPromptSubmit'));
assert.ok(hookEventSchema.oneOf[1].items.enum.includes('PostToolUse'));
assert.ok(schema.$defs.scriptRef.properties.runtime.enum.includes('node'));
assert.ok(schema.$defs.scriptRef.properties.runtime.enum.includes('python'));
assert.deepEqual(schema.$defs.injectSettings.properties.terms.properties.tokenRegexFlags.enum, ['gu']);
assert.equal(schema.$defs.scoreScale.properties.max.const, 100);
assert.equal(schema.$defs.memoryScoring.properties.missingSignalPolicy.const, 'drop-candidate');
assert.equal(schema.$defs.skillsScoring.properties.signals.properties.fts.$ref, '#/$defs/skillFtsSignal');

console.log('config model tests passed');
