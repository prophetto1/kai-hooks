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

function scriptById(source, id) {
  const script = source.scripts.find((entry) => entry.id === id);
  assert.ok(script, `${id} script must be present`);
  return script;
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

const badMemoryProvider = structuredClone(config);
badMemoryProvider.hooks[0].settings.sources.memory.provider = 'vector';
const badMemoryProviderResult = validateConfig(badMemoryProvider);
assert.ok(
  badMemoryProviderResult.errors.some((error) => error.includes('memory.provider')),
  'memory provider must be validated'
);

const badHindsightEndpoint = structuredClone(config);
badHindsightEndpoint.hooks[0].settings.sources.memory.hindsight.endpoint = 'file:///memory';
const badHindsightEndpointResult = validateConfig(badHindsightEndpoint);
assert.ok(
  badHindsightEndpointResult.errors.some((error) => error.includes('memory.hindsight.endpoint')),
  'Hindsight endpoint must be validated'
);

const badHindsightTools = structuredClone(config);
badHindsightTools.hooks[0].settings.sources.memory.hindsight.requiredTools = ['recall'];
const badHindsightToolsResult = validateConfig(badHindsightTools);
assert.ok(
  badHindsightToolsResult.errors.some((error) => error.includes('memory.hindsight.requiredTools missing sync_retain')),
  'Hindsight required tools must include sync_retain'
);

const badSkillWeights = structuredClone(config);
badSkillWeights.hooks[0].settings.sources.skills.scoring.signals.fts.weight = 0.7;
const badSkillWeightsResult = validateConfig(badSkillWeights);
assert.ok(
  badSkillWeightsResult.errors.some((error) => error.includes('skills.scoring signal weights must sum to 1.0')),
  'skill scoring signal weights must sum to 1.0'
);

const badInjectBudgets = structuredClone(config);
badInjectBudgets.hooks[0].settings.output.budgets.memoryChars = badInjectBudgets.hooks[0].settings.output.capChars;
const badInjectBudgetsResult = validateConfig(badInjectBudgets);
assert.ok(
  badInjectBudgetsResult.errors.some((error) => error.includes('inject-protocol output.budgets total must be <= capChars')),
  'inject-protocol section budgets must fit under capChars'
);

const badMemoryNormalizerWrite = structuredClone(config);
hookById(badMemoryNormalizerWrite, 'memory-normalizer').settings.writes.contentMutation = true;
const badMemoryNormalizerWriteResult = validateConfig(badMemoryNormalizerWrite);
assert.ok(
  badMemoryNormalizerWriteResult.errors.some((error) => error.includes('memory-normalizer settings.writes.contentMutation must be false')),
  'memory-normalizer must reject content mutation settings'
);

const badMemoryNormalizerToolGroup = structuredClone(config);
hookById(badMemoryNormalizerToolGroup, 'memory-normalizer').match.toolGroup = 'unknownGroup';
const badMemoryNormalizerToolGroupResult = validateConfig(badMemoryNormalizerToolGroup);
assert.ok(
  badMemoryNormalizerToolGroupResult.errors.some((error) => error.includes('memory-normalizer match.toolGroup invalid')),
  'memory-normalizer must reject unknown toolGroup names'
);

const badHindsightRetainDrift = structuredClone(config);
hookById(badHindsightRetainDrift, 'memory-harvester').settings.hindsight.retainLlm.model = 'mistral/mistral-small-latest';
const badHindsightRetainDriftResult = validateConfig(badHindsightRetainDrift);
assert.ok(
  badHindsightRetainDriftResult.errors.some((error) =>
    error.includes('memory-harvester settings.hindsight.retainLlm.model must match settings.extraction.llm.model')
  ),
  'Hindsight retain LLM must not drift from harvester LLM'
);

const badMemoryHarvesterCadence = structuredClone(config);
hookById(badMemoryHarvesterCadence, 'memory-harvester').settings.runAfterNewExchanges =
  hookById(badMemoryHarvesterCadence, 'memory-harvester').settings.reviewLastExchanges + 1;
const badMemoryHarvesterCadenceResult = validateConfig(badMemoryHarvesterCadence);
assert.ok(
  badMemoryHarvesterCadenceResult.errors.some((error) =>
    error.includes('memory-harvester settings.runAfterNewExchanges must be <= settings.reviewLastExchanges')
  ),
  'memory-harvester cadence must fit inside the exchange scan window'
);

const badMemoryHarvesterOldNames = structuredClone(config);
hookById(badMemoryHarvesterOldNames, 'memory-harvester').settings.maxExchanges = 4;
hookById(badMemoryHarvesterOldNames, 'memory-harvester').settings.harvestEveryExchanges = 4;
const badMemoryHarvesterOldNamesResult = validateConfig(badMemoryHarvesterOldNames);
assert.ok(
  badMemoryHarvesterOldNamesResult.errors.some((error) =>
    error.includes('memory-harvester settings.maxExchanges is deprecated; use reviewLastExchanges')
  ),
  'memory-harvester must reject old review-window setting name'
);
assert.ok(
  badMemoryHarvesterOldNamesResult.errors.some((error) =>
    error.includes('memory-harvester settings.harvestEveryExchanges is deprecated; use runAfterNewExchanges')
  ),
  'memory-harvester must reject old cadence setting name'
);

const badQualityAuthority = structuredClone(config);
hookById(badQualityAuthority, 'quality-completion-gate').settings.authority = 'assistant-claims';
const badQualityAuthorityResult = validateConfig(badQualityAuthority);
assert.ok(
  badQualityAuthorityResult.errors.some((error) => error.includes('quality-completion-gate settings.authority must be exit-codes-only')),
  'quality-completion-gate authority must remain exit-code based'
);

const badQualityLoopThreshold = structuredClone(config);
hookById(badQualityLoopThreshold, 'quality-completion-gate').settings.maxRepeatedFailureBlocks = 0;
const badQualityLoopThresholdResult = validateConfig(badQualityLoopThreshold);
assert.ok(
  badQualityLoopThresholdResult.errors.some((error) => error.includes('quality-completion-gate settings.maxRepeatedFailureBlocks invalid')),
  'quality-completion-gate loop threshold must be positive'
);

const badQualityBudget = structuredClone(config);
hookById(badQualityBudget, 'quality-completion-gate').settings.totalBudgetMs = 0;
const badQualityBudgetResult = validateConfig(badQualityBudget);
assert.ok(
  badQualityBudgetResult.errors.some((error) => error.includes('quality-completion-gate settings.totalBudgetMs invalid')),
  'quality-completion-gate total budget must be positive'
);

const badSkillIndexerRoot = structuredClone(config);
scriptById(badSkillIndexerRoot, 'skill-indexer').settings.scanRoots = [
  { path: 'E:/other-skills', source: 'other', scope: 'all' },
];
const badSkillIndexerRootResult = validateConfig(badSkillIndexerRoot);
assert.ok(
  badSkillIndexerRootResult.errors.some((error) =>
    error.includes('skill-indexer scanRoots must include shared.paths.skillsWarehouse')
  ),
  'skill-indexer must include the configured shared skills warehouse'
);

const badAgentDiffTriggerMode = structuredClone(config);
hookById(badAgentDiffTriggerMode, 'agent-diff-completion-gate').settings.repos[0].rules[0].trigger.mode = 'files-xor-loc';
const badAgentDiffTriggerModeResult = validateConfig(badAgentDiffTriggerMode);
assert.ok(
  badAgentDiffTriggerModeResult.errors.some((error) => error.includes('agent-diff-completion-gate settings.repos[0].rules[0].trigger.mode invalid')),
  'agent-diff-completion-gate trigger mode must be validated'
);

const badAgentDiffVerification = structuredClone(config);
delete hookById(badAgentDiffVerification, 'agent-diff-completion-gate').settings.repos[0].verification;
const badAgentDiffVerificationResult = validateConfig(badAgentDiffVerification);
assert.ok(
  badAgentDiffVerificationResult.errors.some((error) => error.includes('agent-diff-completion-gate settings.repos[0].verification must be an object')),
  'enabled agent-diff repo must declare verification'
);

const disabledAgentDiffRepo = structuredClone(config);
const disabledRepo = hookById(disabledAgentDiffRepo, 'agent-diff-completion-gate').settings.repos[0];
disabledRepo.enabled = false;
delete disabledRepo.rules;
delete disabledRepo.verification;
const disabledAgentDiffRepoResult = validateConfig(disabledAgentDiffRepo);
assert.deepEqual(disabledAgentDiffRepoResult.errors, [], 'disabled agent-diff repo may omit rules and verification');

const badCompletionQualityFailPolicy = structuredClone(config);
hookById(badCompletionQualityFailPolicy, 'completion-quality-gate').failPolicy = 'open';
const badCompletionQualityFailPolicyResult = validateConfig(badCompletionQualityFailPolicy);
assert.ok(
  badCompletionQualityFailPolicyResult.errors.some((error) =>
    error.includes('completion-quality-gate.failPolicy must be closed')
  ),
  'completion-quality-gate must be fail-closed'
);

const badCompletionQualityPhaseScript = structuredClone(config);
hookById(badCompletionQualityPhaseScript, 'completion-quality-gate').settings.riskScript = 'agent-diff-completion-gate/wrong.mjs';
const badCompletionQualityPhaseScriptResult = validateConfig(badCompletionQualityPhaseScript);
assert.ok(
  badCompletionQualityPhaseScriptResult.errors.some((error) =>
    error.includes('completion-quality-gate settings.riskScript mismatch')
  ),
  'completion-quality-gate must point at the expected risk phase executor'
);

const badStopChainStepTimeout = structuredClone(config);
scriptById(badStopChainStepTimeout, 'stop-completion-chain').settings.stepTimeoutMs = 0;
const badStopChainStepTimeoutResult = validateConfig(badStopChainStepTimeout);
assert.ok(
  badStopChainStepTimeoutResult.errors.some((error) => error.includes('stop-completion-chain settings.stepTimeoutMs invalid')),
  'stop-completion-chain step timeout must be positive'
);

const badStopChainBudgetOrder = structuredClone(config);
scriptById(badStopChainBudgetOrder, 'stop-completion-chain').settings.stepTimeoutMs =
  hookById(badStopChainBudgetOrder, 'quality-completion-gate').settings.totalBudgetMs;
const badStopChainBudgetOrderResult = validateConfig(badStopChainBudgetOrder);
assert.ok(
  badStopChainBudgetOrderResult.errors.some((error) =>
    error.includes('stop-completion-chain settings.stepTimeoutMs must exceed quality-completion-gate settings.totalBudgetMs')
  ),
  'stop-completion-chain step timeout must exceed the inner quality gate budget'
);

const badStopChainCompletionQualityBudgetOrder = structuredClone(config);
scriptById(badStopChainCompletionQualityBudgetOrder, 'stop-completion-chain').settings.stepTimeoutMs =
  hookById(badStopChainCompletionQualityBudgetOrder, 'completion-quality-gate').settings.phaseTimeoutMs;
const badStopChainCompletionQualityBudgetOrderResult = validateConfig(badStopChainCompletionQualityBudgetOrder);
assert.ok(
  badStopChainCompletionQualityBudgetOrderResult.errors.some((error) =>
    error.includes('stop-completion-chain settings.stepTimeoutMs must exceed completion-quality-gate settings.phaseTimeoutMs')
  ),
  'stop-completion-chain step timeout must exceed the merged completion-quality phase timeout'
);

const legacyQualityInStopChain = structuredClone(config);
scriptById(legacyQualityInStopChain, 'stop-completion-chain').settings.chain.push('quality-completion-gate');
const legacyQualityInStopChainResult = validateConfig(legacyQualityInStopChain);
assert.ok(
  legacyQualityInStopChainResult.errors.some((error) =>
    error.includes('stop-completion-chain settings.chain must not include legacy quality-completion-gate')
  ),
  'legacy quality/agent-diff gates must not be direct Stop-chain entries'
);

const missingProhibitedFraudHook = structuredClone(config);
missingProhibitedFraudHook.hooks = missingProhibitedFraudHook.hooks.filter((hook) => hook.id !== 'prohibited-fraud-completion-gate');
const missingProhibitedFraudHookResult = validateConfig(missingProhibitedFraudHook);
assert.ok(
  missingProhibitedFraudHookResult.errors.some((error) => error.includes('missing hooks[id=prohibited-fraud-completion-gate]')),
  'prohibited fraud completion gate must be present'
);

const badProhibitedFraudFailPolicy = structuredClone(config);
hookById(badProhibitedFraudFailPolicy, 'prohibited-fraud-completion-gate').failPolicy = 'open';
const badProhibitedFraudFailPolicyResult = validateConfig(badProhibitedFraudFailPolicy);
assert.ok(
  badProhibitedFraudFailPolicyResult.errors.some((error) =>
    error.includes('prohibited-fraud-completion-gate.failPolicy must be closed')
  ),
  'prohibited fraud completion gate must be fail-closed'
);

const badProhibitedFraudDocuments = structuredClone(config);
hookById(badProhibitedFraudDocuments, 'prohibited-fraud-completion-gate').settings.documents =
  hookById(badProhibitedFraudDocuments, 'prohibited-fraud-completion-gate').settings.documents.filter((doc) => doc.repo !== 'dbase');
const badProhibitedFraudDocumentsResult = validateConfig(badProhibitedFraudDocuments);
assert.ok(
  badProhibitedFraudDocumentsResult.errors.some((error) =>
    error.includes('prohibited-fraud-completion-gate settings.documents must list the five governed repos')
  ),
  'prohibited fraud completion gate must require all five repo documents'
);

const missingProhibitedFraudFromChain = structuredClone(config);
scriptById(missingProhibitedFraudFromChain, 'stop-completion-chain').settings.chain =
  scriptById(missingProhibitedFraudFromChain, 'stop-completion-chain').settings.chain.filter((id) => id !== 'prohibited-fraud-completion-gate');
const missingProhibitedFraudFromChainResult = validateConfig(missingProhibitedFraudFromChain);
assert.ok(
  missingProhibitedFraudFromChainResult.errors.some((error) => error.includes('stop-completion-chain settings.chain must list existing hook ids')),
  'stop completion chain must include prohibited-fraud-completion-gate'
);

const missingCompletionQualityFromChain = structuredClone(config);
scriptById(missingCompletionQualityFromChain, 'stop-completion-chain').settings.chain =
  scriptById(missingCompletionQualityFromChain, 'stop-completion-chain').settings.chain.filter((id) => id !== 'completion-quality-gate');
const missingCompletionQualityFromChainResult = validateConfig(missingCompletionQualityFromChain);
assert.ok(
  missingCompletionQualityFromChainResult.errors.some((error) => error.includes('stop-completion-chain settings.chain must list existing hook ids')),
  'stop completion chain must include completion-quality-gate'
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

// --- task-policy-guard + shared.taskPolicy validation ---

const badGuardEvent = structuredClone(config);
hookById(badGuardEvent, 'task-policy-guard').event = 'Stop';
assert.ok(
  validateConfig(badGuardEvent).errors.some((e) => e.includes('task-policy-guard.event must be PreToolUse')),
  'task-policy-guard event must be validated'
);

const badGuardScript = structuredClone(config);
hookById(badGuardScript, 'task-policy-guard').script.path = 'task-policy/wrong.mjs';
assert.ok(
  validateConfig(badGuardScript).errors.some((e) => e.includes('task-policy-guard.script.path mismatch')),
  'task-policy-guard script path must be validated'
);

const badGuardFailPolicy = structuredClone(config);
hookById(badGuardFailPolicy, 'task-policy-guard').failPolicy = 'closed';
assert.ok(
  validateConfig(badGuardFailPolicy).errors.some((e) => e.includes('task-policy-guard.failPolicy must be open')),
  'task-policy-guard must be fail-open'
);

const guardMissingDep = structuredClone(config);
guardMissingDep.hooks = guardMissingDep.hooks.filter((h) => h.id !== 'task-mode-gate');
assert.ok(
  validateConfig(guardMissingDep).errors.some((e) => e.includes('task-policy-guard requires hooks[id=task-mode-gate]')),
  'task-policy-guard must require its companion hooks'
);

const badTaskPolicy = structuredClone(config);
badTaskPolicy.shared.taskPolicy.maxObjectiveChars = 0;
assert.ok(
  validateConfig(badTaskPolicy).errors.some((e) => e.includes('shared.taskPolicy.maxObjectiveChars')),
  'invalid shared.taskPolicy.maxObjectiveChars must be rejected'
);

const badTaskPolicyRetention = structuredClone(config);
badTaskPolicyRetention.shared.taskPolicy.decisionRetentionDays = -1;
assert.ok(
  validateConfig(badTaskPolicyRetention).errors.some((e) => e.includes('shared.taskPolicy.decisionRetentionDays')),
  'negative decisionRetentionDays must be rejected'
);

const schema = generateConfigSchema();
assert.ok(schema.$defs.shared.properties.taskPolicy, 'generated schema must define shared.taskPolicy');
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
