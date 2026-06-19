const EVENT_ENUM = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'PreCompact',
  'PostCompact',
];

const RUNTIME_ENUM = ['node', 'python'];
const HOOK_CATEGORY_ENUM = ['push', 'gate', 'telemetry'];
const FAIL_POLICY_ENUM = ['open', 'closed'];
const PROJECT_KIND_ENUM = ['rebuild', 'legacy'];
const ADCG_TRIGGER_MODE_ENUM = ['files', 'loc', 'files-or-loc', 'files-and-loc'];
const MEMORY_PROVIDER_ENUM = ['hindsight', 'sqlite'];
const MEMORY_FALLBACK_PROVIDER_ENUM = ['sqlite', 'none'];
const HINDSIGHT_REQUIRED_TOOLS = ['recall', 'list_memories', 'reflect', 'sync_retain'];

export const TOKENIZER_CONFIG = Object.freeze({
  defaultCharClass: '\\p{L}\\p{N}_-',
  allowedFlags: ['gu'],
});

export const MEMORY_FILTER_IDS = Object.freeze([
  'not-deleted',
  'not-superseded',
]);

const ref = (name) => ({ $ref: `#/$defs/${name}` });
const stringArray = () => ({ type: 'array', items: { type: 'string' } });
const noteFields = () => ({ patternProperties: { '^_': true } });

function objectSchema({ required = [], properties = {}, additionalProperties = false, allOf, patternProperties } = {}) {
  const schema = { type: 'object' };
  if (required.length) schema.required = required;
  if (Object.keys(properties).length) schema.properties = properties;
  if (allOf) schema.allOf = allOf;
  if (patternProperties) schema.patternProperties = patternProperties;
  schema.additionalProperties = additionalProperties;
  return schema;
}

function arrayOf(items) {
  return { type: 'array', items };
}

function definitions() {
  const nonEmptyString = { type: 'string', minLength: 1 };
  const positiveNumber = { type: 'number', exclusiveMinimum: 0 };
  const positiveInteger = { type: 'integer', minimum: 1 };
  const score100 = { type: 'number', minimum: 0, maximum: 100 };
  const unitWeight = { type: 'number', minimum: 0, maximum: 1 };

  return {
    nonEmptyString,
    positiveNumber,
    positiveInteger,
    score100,
    unitWeight,
    stringArray: stringArray(),
    shared: objectSchema({
      required: ['paths', 'runtime', 'projects', 'memoryTags', 'stopwords'],
      properties: {
        paths: objectSchema({
          required: ['hooksDir', 'memoryDb', 'hooksDb', 'skillsCatalog', 'qualityVerifyManifest', 'skillsWarehouse', 'python'],
          properties: {
            hooksDir: ref('nonEmptyString'),
            memoryDb: ref('nonEmptyString'),
            hooksDb: ref('nonEmptyString'),
            skillsCatalog: ref('nonEmptyString'),
            qualityVerifyManifest: ref('nonEmptyString'),
            skillsWarehouse: ref('nonEmptyString'),
            python: ref('nonEmptyString'),
          },
        }),
        runtime: objectSchema({
          required: ['pythonTimeoutMs', 'gitTimeoutMs', 'verifyCommandTimeoutMs', 'pythonEnv'],
          properties: {
            pythonTimeoutMs: ref('positiveInteger'),
            gitTimeoutMs: ref('positiveInteger'),
            verifyCommandTimeoutMs: ref('positiveInteger'),
            pythonEnv: objectSchema({ additionalProperties: { type: 'string' } }),
          },
        }),
        projects: arrayOf(objectSchema({
          required: ['slug', 'kind', 'repoPath', 'aliases'],
          properties: {
            slug: ref('nonEmptyString'),
            kind: { enum: PROJECT_KIND_ENUM },
            repoPath: ref('nonEmptyString'),
            aliases: ref('stringArray'),
          },
        })),
        memoryTags: objectSchema({
          required: ['crossProjectTag', 'legacyRewrite', 'retiredTags'],
          properties: {
            crossProjectTag: ref('nonEmptyString'),
            legacyRewrite: objectSchema({ additionalProperties: { type: 'string' } }),
            retiredTags: ref('stringArray'),
          },
        }),
        stopwords: ref('nonEmptyString'),
      },
      ...noteFields(),
    }),
    hook: objectSchema({
      required: ['id', 'name', 'description', 'category', 'event', 'match', 'script', 'scope', 'enabled', 'failPolicy', 'settings'],
      properties: {
        id: ref('nonEmptyString'),
        name: ref('nonEmptyString'),
        description: { type: 'string' },
        category: { enum: HOOK_CATEGORY_ENUM },
        event: { oneOf: [{ enum: EVENT_ENUM }, { type: 'array', items: { enum: EVENT_ENUM }, minItems: 1 }] },
        match: { type: 'object' },
        script: ref('scriptRef'),
        scope: { type: 'object' },
        enabled: { type: 'boolean' },
        failPolicy: { enum: FAIL_POLICY_ENUM },
        settings: { type: 'object' },
      },
      allOf: [
        {
          if: { properties: { id: { enum: ['inject-protocol'] } } },
          then: { properties: { settings: ref('injectSettings') } },
        },
        {
          if: { properties: { id: { enum: ['agent-diff-completion-gate'] } } },
          then: { properties: { settings: ref('agentDiffSettings') } },
        },
      ],
    }),
    script: objectSchema({
      required: ['id', 'name', 'description', 'category', 'trigger', 'script', 'enabled', 'settings'],
      properties: {
        id: ref('nonEmptyString'),
        name: ref('nonEmptyString'),
        description: { type: 'string' },
        category: ref('nonEmptyString'),
        trigger: ref('nonEmptyString'),
        script: ref('scriptRef'),
        enabled: { type: 'boolean' },
        settings: { type: 'object' },
      },
      allOf: [
        {
          if: { properties: { id: { const: 'skill-indexer' } } },
          then: { properties: { settings: ref('skillIndexerSettings') } },
        },
      ],
    }),
    scriptRef: objectSchema({
      required: ['path', 'runtime'],
      properties: {
        path: ref('nonEmptyString'),
        runtime: { enum: RUNTIME_ENUM },
      },
    }),
    injectSettings: objectSchema({
      required: ['terms', 'sources', 'output'],
      properties: {
        terms: objectSchema({
          required: ['minLen', 'max', 'contextPrompts', 'tokenCharClass', 'tokenRegexFlags'],
          properties: {
            minLen: ref('positiveInteger'),
            max: ref('positiveInteger'),
            contextPrompts: { type: 'integer', minimum: 0 },
            tokenCharClass: ref('nonEmptyString'),
            tokenRegexFlags: { enum: TOKENIZER_CONFIG.allowedFlags },
          },
        }),
        sources: objectSchema({
          required: ['protocol', 'memory', 'skills'],
          properties: {
            protocol: objectSchema({
              required: ['file'],
              properties: { file: ref('nonEmptyString') },
              ...noteFields(),
            }),
            memory: ref('memorySource'),
            skills: ref('skillsSource'),
          },
        }),
        output: objectSchema({
          required: ['capChars', 'budgets', 'labels'],
          properties: {
            capChars: ref('positiveInteger'),
            budgets: objectSchema({
              required: ['protocolChars', 'diagnosticsChars', 'skillsChars', 'memoryChars'],
              properties: {
                protocolChars: ref('positiveInteger'),
                diagnosticsChars: ref('positiveInteger'),
                skillsChars: ref('positiveInteger'),
                memoryChars: ref('positiveInteger'),
              },
            }),
            labels: objectSchema({
              required: ['diagnostics', 'skills', 'memory'],
              properties: {
                diagnostics: ref('nonEmptyString'),
                skills: ref('nonEmptyString'),
                memory: ref('nonEmptyString'),
              },
            }),
          },
        }),
      },
      ...noteFields(),
    }),
    memorySource: objectSchema({
      required: [
        'provider',
        'hindsight',
        'ftsTable',
        'joinTable',
        'filters',
        'max',
        'snippetChars',
        'minTerms',
        'candidatePool',
        'scoring',
        'explain',
      ],
      properties: {
        provider: { enum: MEMORY_PROVIDER_ENUM },
        fallbackProvider: { enum: MEMORY_FALLBACK_PROVIDER_ENUM },
        fallbackOnEmpty: { type: 'boolean' },
        hindsight: ref('hindsightMemorySource'),
        ftsTable: ref('nonEmptyString'),
        joinTable: ref('nonEmptyString'),
        filters: arrayOf(objectSchema({
          required: ['id'],
          properties: {
            id: { enum: MEMORY_FILTER_IDS },
          },
        })),
        max: ref('positiveInteger'),
        snippetChars: ref('positiveInteger'),
        minTerms: ref('positiveInteger'),
        candidatePool: ref('positiveInteger'),
        scoring: ref('memoryScoring'),
        explain: ref('explainConfig'),
      },
      ...noteFields(),
    }),
    hindsightMemorySource: objectSchema({
      required: ['endpoint', 'bankId', 'tool', 'timeoutMs', 'requiredTools'],
      properties: {
        endpoint: ref('nonEmptyString'),
        bankId: ref('nonEmptyString'),
        tool: { const: 'recall' },
        timeoutMs: ref('positiveInteger'),
        requiredTools: ref('stringArray'),
      },
      ...noteFields(),
    }),
    scoreScale: objectSchema({
      required: ['min', 'max', 'baseline'],
      properties: {
        min: { const: 0 },
        max: { const: 100 },
        baseline: { const: 0 },
      },
    }),
    memoryScoring: objectSchema({
      required: ['scoreScale', 'missingSignalPolicy', 'minFinalScore', 'relativeFloor', 'signals'],
      properties: {
        scoreScale: ref('scoreScale'),
        missingSignalPolicy: { const: 'drop-candidate' },
        minFinalScore: ref('score100'),
        relativeFloor: ref('score100'),
        signals: objectSchema({
          required: ['fts', 'recency', 'confidence'],
          properties: {
            fts: ref('ftsSignal'),
            recency: ref('recencySignal'),
            confidence: ref('confidenceSignal'),
          },
        }),
      },
    }),
    skillsScoring: objectSchema({
      required: ['scoreScale', 'missingSignalPolicy', 'minFinalScore', 'relativeFloor', 'signals'],
      properties: {
        scoreScale: ref('scoreScale'),
        missingSignalPolicy: { const: 'drop-candidate' },
        minFinalScore: ref('score100'),
        relativeFloor: ref('score100'),
        signals: objectSchema({
          required: ['fts', 'overlap'],
          properties: {
            fts: ref('skillFtsSignal'),
            overlap: ref('overlapSignal'),
          },
        }),
      },
    }),
    ftsSignal: objectSchema({
      required: ['weight', 'transform'],
      properties: {
        weight: ref('unitWeight'),
        transform: { const: 'top-candidate-relative' },
      },
    }),
    recencySignal: objectSchema({
      required: ['weight', 'transform', 'halfLifeDays'],
      properties: {
        weight: ref('unitWeight'),
        transform: { const: 'half-life-decay' },
        halfLifeDays: ref('positiveNumber'),
      },
    }),
    confidenceSignal: objectSchema({
      required: ['weight', 'transform'],
      properties: {
        weight: ref('unitWeight'),
        transform: { const: 'stored-confidence' },
      },
    }),
    skillFtsSignal: objectSchema({
      required: ['weight', 'transform', 'fieldBoosts'],
      properties: {
        weight: ref('unitWeight'),
        transform: { const: 'top-candidate-relative' },
        fieldBoosts: objectSchema({
          required: ['name', 'description', 'content'],
          properties: {
            name: ref('unitWeight'),
            description: ref('unitWeight'),
            content: ref('unitWeight'),
          },
        }),
      },
    }),
    overlapSignal: objectSchema({
      required: ['weight', 'transform', 'minTerms'],
      properties: {
        weight: ref('unitWeight'),
        transform: { const: 'matched-terms-ratio' },
        minTerms: ref('positiveInteger'),
      },
    }),
    skillsSource: objectSchema({
      required: [
        'ftsTable',
        'joinTable',
        'max',
        'candidatePool',
        'scoring',
        'noiseTerms',
        'explain',
      ],
      properties: {
        ftsTable: ref('nonEmptyString'),
        joinTable: ref('nonEmptyString'),
        max: ref('positiveInteger'),
        candidatePool: ref('positiveInteger'),
        scoring: ref('skillsScoring'),
        noiseTerms: ref('stringArray'),
        explain: ref('explainConfig'),
      },
      ...noteFields(),
    }),
    explainConfig: objectSchema({
      required: ['enabled', 'includeInPrompt', 'includeInSelfTest'],
      properties: {
        enabled: { type: 'boolean' },
        includeInPrompt: { type: 'boolean' },
        includeInSelfTest: { type: 'boolean' },
      },
    }),
    skillIndexerSettings: objectSchema({
      required: ['scanRoots', 'skipPathContains', 'fts', 'dedupPrefer', 'curatedRegex'],
      properties: {
        scanRoots: arrayOf(objectSchema({
          required: ['path', 'source', 'scope'],
          properties: {
            path: ref('nonEmptyString'),
            source: ref('nonEmptyString'),
            scope: ref('nonEmptyString'),
          },
        })),
        skipPathContains: ref('stringArray'),
        fts: objectSchema({
          required: ['columns'],
          properties: {
            columns: {
              type: 'array',
              prefixItems: [{ const: 'name' }, { const: 'description' }, { const: 'content' }],
              items: false,
            },
          },
        }),
        dedupPrefer: ref('stringArray'),
        curatedRegex: ref('nonEmptyString'),
      },
    }),
    pathRule: objectSchema({
      properties: {
        prefixes: ref('stringArray'),
        contains: ref('stringArray'),
        extensions: ref('stringArray'),
        fileNames: ref('stringArray'),
        segments: ref('stringArray'),
        excludePrefixes: ref('stringArray'),
        excludeSegments: ref('stringArray'),
        excludeContains: ref('stringArray'),
      },
      ...noteFields(),
    }),
    agentDiffTrigger: objectSchema({
      required: ['mode'],
      properties: {
        mode: { enum: ADCG_TRIGGER_MODE_ENUM },
        minChangedFiles: ref('positiveInteger'),
        minChangedLoc: ref('positiveInteger'),
      },
      ...noteFields(),
    }),
    agentDiffRule: objectSchema({
      required: ['name', 'paths', 'trigger'],
      properties: {
        name: ref('nonEmptyString'),
        paths: arrayOf(ref('pathRule')),
        extensions: ref('stringArray'),
        trigger: ref('agentDiffTrigger'),
      },
      ...noteFields(),
    }),
    agentDiffVerification: objectSchema({
      required: ['command', 'timeoutMs', 'label', 'verificationDir'],
      properties: {
        command: ref('nonEmptyString'),
        timeoutMs: ref('positiveInteger'),
        label: ref('nonEmptyString'),
        verificationDir: ref('nonEmptyString'),
        requireLiveApi: { type: 'boolean' },
        requireFrontendLogin: { type: 'boolean' },
      },
      ...noteFields(),
    }),
    agentDiffRepo: objectSchema({
      required: ['name', 'root', 'enabled'],
      properties: {
        name: ref('nonEmptyString'),
        root: ref('nonEmptyString'),
        enabled: { type: 'boolean' },
        reason: { type: 'string' },
        extensions: ref('stringArray'),
        rules: arrayOf(ref('agentDiffRule')),
        trigger: ref('agentDiffTrigger'),
        tiers: objectSchema({
          properties: {
            largeLocMin: ref('positiveInteger'),
          },
          ...noteFields(),
        }),
        verification: ref('agentDiffVerification'),
      },
      ...noteFields(),
    }),
    agentDiffSettings: objectSchema({
      required: ['maxRepeatedBlocks', 'failureMode', 'maxRemediationLoops', 'stateDir', 'repos'],
      properties: {
        maxRepeatedBlocks: ref('positiveInteger'),
        failureMode: { enum: ['block', 'report-only'] },
        maxRemediationLoops: ref('positiveInteger'),
        locLargeMin: ref('positiveInteger'),
        stateDir: ref('nonEmptyString'),
        repos: arrayOf(ref('agentDiffRepo')),
      },
      ...noteFields(),
    }),
  };
}

export function generateConfigSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'file:///E:/hooks/config.schema.json',
    title: 'E:/hooks control-plane config',
    type: 'object',
    required: ['version', 'shared', 'hooks', 'scripts'],
    properties: {
      $schema: { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      shared: ref('shared'),
      hooks: arrayOf(ref('hook')),
      scripts: arrayOf(ref('script')),
    },
    ...noteFields(),
    additionalProperties: false,
    $defs: definitions(),
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function score100(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function unitWeight(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

function bool(value) {
  return typeof value === 'boolean';
}

function validTokenRegex(terms) {
  if (!terms || typeof terms.tokenCharClass !== 'string' || typeof terms.tokenRegexFlags !== 'string') return false;
  if (!TOKENIZER_CONFIG.allowedFlags.includes(terms.tokenRegexFlags)) return false;
  try {
    new RegExp(`[${terms.tokenCharClass}]{${terms.minLen},}`, terms.tokenRegexFlags);
    return true;
  } catch {
    return false;
  }
}

function pushIf(errors, condition, message) {
  if (!condition) errors.push(message);
}

function sumCloseToOne(values) {
  return Math.abs(values.reduce((total, value) => total + value, 0) - 1) < 0.000001;
}

function validateScoreScale(errors, scale, path) {
  pushIf(errors, isObject(scale), `${path}.scoreScale must be an object`);
  if (!isObject(scale)) return;
  pushIf(errors, scale.min === 0, `${path}.scoreScale.min must be 0`);
  pushIf(errors, scale.max === 100, `${path}.scoreScale.max must be 100`);
  pushIf(errors, scale.baseline === 0, `${path}.scoreScale.baseline must be 0`);
}

function validateScoringBase(errors, scoring, path) {
  pushIf(errors, isObject(scoring), `${path} must be an object`);
  if (!isObject(scoring)) return false;
  validateScoreScale(errors, scoring.scoreScale, path);
  pushIf(errors, scoring.missingSignalPolicy === 'drop-candidate', `${path}.missingSignalPolicy must be drop-candidate`);
  pushIf(errors, score100(scoring.minFinalScore), `${path}.minFinalScore must be 0..100`);
  pushIf(errors, score100(scoring.relativeFloor), `${path}.relativeFloor must be 0..100`);
  pushIf(errors, isObject(scoring.signals), `${path}.signals must be an object`);
  return isObject(scoring.signals);
}

function validateMemoryScoring(errors, scoring) {
  if (!validateScoringBase(errors, scoring, 'memory.scoring')) return;
  const { fts, recency, confidence } = scoring.signals;
  pushIf(errors, unitWeight(fts?.weight), 'memory.scoring.signals.fts.weight must be 0..1');
  pushIf(errors, fts?.transform === 'top-candidate-relative', 'memory.scoring.signals.fts.transform mismatch');
  pushIf(errors, unitWeight(recency?.weight), 'memory.scoring.signals.recency.weight must be 0..1');
  pushIf(errors, recency?.transform === 'half-life-decay', 'memory.scoring.signals.recency.transform mismatch');
  pushIf(errors, positiveNumber(recency?.halfLifeDays), 'memory.scoring.signals.recency.halfLifeDays invalid');
  pushIf(errors, unitWeight(confidence?.weight), 'memory.scoring.signals.confidence.weight must be 0..1');
  pushIf(errors, confidence?.transform === 'stored-confidence', 'memory.scoring.signals.confidence.transform mismatch');
  if ([fts?.weight, recency?.weight, confidence?.weight].every(unitWeight)) {
    pushIf(errors, sumCloseToOne([fts.weight, recency.weight, confidence.weight]), 'memory.scoring signal weights must sum to 1.0');
  }
}

function validateSkillsScoring(errors, scoring) {
  if (!validateScoringBase(errors, scoring, 'skills.scoring')) return;
  const { fts, overlap } = scoring.signals;
  pushIf(errors, unitWeight(fts?.weight), 'skills.scoring.signals.fts.weight must be 0..1');
  pushIf(errors, fts?.transform === 'top-candidate-relative', 'skills.scoring.signals.fts.transform mismatch');
  pushIf(errors, unitWeight(fts?.fieldBoosts?.name), 'skills.scoring.signals.fts.fieldBoosts.name must be 0..1');
  pushIf(errors, unitWeight(fts?.fieldBoosts?.description), 'skills.scoring.signals.fts.fieldBoosts.description must be 0..1');
  pushIf(errors, unitWeight(fts?.fieldBoosts?.content), 'skills.scoring.signals.fts.fieldBoosts.content must be 0..1');
  pushIf(errors, unitWeight(overlap?.weight), 'skills.scoring.signals.overlap.weight must be 0..1');
  pushIf(errors, overlap?.transform === 'matched-terms-ratio', 'skills.scoring.signals.overlap.transform mismatch');
  pushIf(errors, positiveInteger(overlap?.minTerms), 'skills.scoring.signals.overlap.minTerms invalid');
  if ([fts?.weight, overlap?.weight].every(unitWeight)) {
    pushIf(errors, sumCloseToOne([fts.weight, overlap.weight]), 'skills.scoring signal weights must sum to 1.0');
  }
  const boosts = fts?.fieldBoosts;
  if ([boosts?.name, boosts?.description, boosts?.content].every(unitWeight)) {
    pushIf(errors, sumCloseToOne([boosts.name, boosts.description, boosts.content]), 'skills.scoring.signals.fts.fieldBoosts must sum to 1.0');
  }
}

function validateOutputBudgets(errors, output, path) {
  const budgets = output?.budgets || {};
  const values = [
    budgets.protocolChars,
    budgets.diagnosticsChars,
    budgets.skillsChars,
    budgets.memoryChars
  ];
  if (positiveInteger(output?.capChars) && values.every(positiveInteger)) {
    pushIf(errors, values.reduce((total, value) => total + value, 0) <= output.capChars, `${path}.budgets total must be <= capChars`);
  }
}

function hookById(config, id) {
  return Array.isArray(config.hooks) ? config.hooks.find((hook) => hook && hook.id === id) : null;
}

function scriptById(config, id) {
  return Array.isArray(config.scripts) ? config.scripts.find((script) => script && script.id === id) : null;
}

function validateScriptRef(errors, refValue, path) {
  pushIf(errors, isObject(refValue), `${path} must be an object`);
  if (!isObject(refValue)) return;
  pushIf(errors, typeof refValue.path === 'string' && refValue.path.length > 0, `${path}.path must be non-empty`);
  pushIf(errors, RUNTIME_ENUM.includes(refValue.runtime), `${path}.runtime must be one of: ${RUNTIME_ENUM.join(', ')}`);
}

function validateHook(errors, hook, index) {
  const path = `hooks[${index}]`;
  pushIf(errors, typeof hook.id === 'string' && hook.id.length > 0, `${path}.id must be non-empty`);
  pushIf(errors, HOOK_CATEGORY_ENUM.includes(hook.category), `${path}.category must be one of: ${HOOK_CATEGORY_ENUM.join(', ')}`);
  const hookEvents = Array.isArray(hook.event) ? hook.event : [hook.event];
  pushIf(errors, hookEvents.length > 0 && hookEvents.every((e) => EVENT_ENUM.includes(e)), `${path}.event must be one or more of: ${EVENT_ENUM.join(', ')}`);
  pushIf(errors, typeof hook.enabled === 'boolean', `${path}.enabled must be boolean`);
  pushIf(errors, FAIL_POLICY_ENUM.includes(hook.failPolicy), `${path}.failPolicy must be one of: ${FAIL_POLICY_ENUM.join(', ')}`);
  validateScriptRef(errors, hook.script, `${path}.script`);
}

function validateBaseConfig(config, errors) {
  pushIf(errors, Number.isInteger(config.version) && config.version >= 1, 'version must be an integer >= 1');
  pushIf(errors, isObject(config.shared), 'shared must be an object');
  pushIf(errors, Array.isArray(config.hooks), 'hooks must be an array');
  pushIf(errors, Array.isArray(config.scripts), 'scripts must be an array');
  if (Array.isArray(config.hooks)) config.hooks.forEach((hook, index) => validateHook(errors, hook || {}, index));
  if (Array.isArray(config.scripts)) {
    config.scripts.forEach((script, index) => validateScriptRef(errors, script?.script, `scripts[${index}].script`));
  }
}

function validateInjectProtocol(config, errors) {
  const hook = hookById(config, 'inject-protocol');
  pushIf(errors, isObject(hook), 'missing hooks[id=inject-protocol]');
  if (!isObject(hook)) return;

  const settings = hook.settings || {};
  const sources = settings.sources || {};
  const memory = sources.memory || {};
  const skills = sources.skills || {};

  pushIf(errors, hook.event === 'UserPromptSubmit', 'inject-protocol.event must be UserPromptSubmit');
  pushIf(errors, hook.script?.path === 'inject-protocol/inject-protocol.mjs', 'inject-protocol.script.path mismatch');
  pushIf(errors, typeof sources.protocol?.file === 'string', 'inject-protocol sources.protocol.file missing');
  pushIf(errors, positiveInteger(settings.terms?.minLen), 'inject-protocol terms.minLen invalid');
  pushIf(errors, positiveInteger(settings.terms?.max), 'inject-protocol terms.max invalid');
  pushIf(errors, Number.isInteger(settings.terms?.contextPrompts) && settings.terms.contextPrompts >= 0, 'inject-protocol terms.contextPrompts invalid');
  pushIf(errors, typeof settings.terms?.tokenCharClass === 'string' && settings.terms.tokenCharClass.length > 0, 'inject-protocol terms.tokenCharClass invalid');
  pushIf(errors, TOKENIZER_CONFIG.allowedFlags.includes(settings.terms?.tokenRegexFlags), 'inject-protocol terms.tokenRegexFlags invalid');
  pushIf(errors, validTokenRegex(settings.terms), 'inject-protocol token regex invalid');
  pushIf(errors, positiveInteger(settings.output?.capChars), 'inject-protocol output.capChars invalid');
  pushIf(errors, positiveInteger(settings.output?.budgets?.protocolChars), 'inject-protocol output.budgets.protocolChars invalid');
  pushIf(errors, positiveInteger(settings.output?.budgets?.diagnosticsChars), 'inject-protocol output.budgets.diagnosticsChars invalid');
  pushIf(errors, positiveInteger(settings.output?.budgets?.skillsChars), 'inject-protocol output.budgets.skillsChars invalid');
  pushIf(errors, positiveInteger(settings.output?.budgets?.memoryChars), 'inject-protocol output.budgets.memoryChars invalid');
  validateOutputBudgets(errors, settings.output, 'inject-protocol output');
  pushIf(errors, typeof settings.output?.labels?.diagnostics === 'string', 'inject-protocol output.labels.diagnostics missing');
  pushIf(errors, typeof settings.output?.labels?.skills === 'string', 'inject-protocol output.labels.skills missing');
  pushIf(errors, typeof settings.output?.labels?.memory === 'string', 'inject-protocol output.labels.memory missing');

  pushIf(errors, MEMORY_PROVIDER_ENUM.includes(memory.provider), `memory.provider must be one of: ${MEMORY_PROVIDER_ENUM.join(', ')}`);
  pushIf(errors, memory.fallbackProvider === undefined || MEMORY_FALLBACK_PROVIDER_ENUM.includes(memory.fallbackProvider), `memory.fallbackProvider must be one of: ${MEMORY_FALLBACK_PROVIDER_ENUM.join(', ')}`);
  pushIf(errors, memory.fallbackOnEmpty === undefined || typeof memory.fallbackOnEmpty === 'boolean', 'memory.fallbackOnEmpty must be boolean when present');
  pushIf(errors, isObject(memory.hindsight), 'memory.hindsight must be an object');
  if (isObject(memory.hindsight)) {
    pushIf(errors, typeof memory.hindsight.endpoint === 'string' && /^https?:\/\//.test(memory.hindsight.endpoint), 'memory.hindsight.endpoint must be an http(s) URL');
    pushIf(errors, typeof memory.hindsight.bankId === 'string' && memory.hindsight.bankId.length > 0, 'memory.hindsight.bankId missing');
    pushIf(errors, memory.hindsight.tool === 'recall', 'memory.hindsight.tool must be recall');
    pushIf(errors, positiveInteger(memory.hindsight.timeoutMs), 'memory.hindsight.timeoutMs invalid');
    pushIf(errors, nonEmptyStringArray(memory.hindsight.requiredTools), 'memory.hindsight.requiredTools must be a non-empty string array');
    if (Array.isArray(memory.hindsight.requiredTools)) {
      for (const tool of HINDSIGHT_REQUIRED_TOOLS) {
        pushIf(errors, memory.hindsight.requiredTools.includes(tool), `memory.hindsight.requiredTools missing ${tool}`);
      }
    }
  }

  pushIf(errors, identifier(memory.ftsTable), 'memory.ftsTable must be a SQL identifier');
  pushIf(errors, identifier(memory.joinTable), 'memory.joinTable must be a SQL identifier');
  pushIf(errors, Array.isArray(memory.filters) && memory.filters.every((filter) => (
    isObject(filter) && MEMORY_FILTER_IDS.includes(filter.id)
  )), `memory.filters must use allowlisted ids: ${MEMORY_FILTER_IDS.join(', ')}`);
  pushIf(errors, positiveInteger(memory.max), 'memory.max invalid');
  pushIf(errors, positiveInteger(memory.snippetChars), 'memory.snippetChars invalid');
  pushIf(errors, positiveInteger(memory.minTerms), 'memory.minTerms invalid');
  pushIf(errors, positiveInteger(memory.candidatePool), 'memory.candidatePool invalid');
  validateMemoryScoring(errors, memory.scoring);
  pushIf(errors, isObject(memory.explain), 'memory.explain missing');

  pushIf(errors, identifier(skills.ftsTable), 'skills.ftsTable must be a SQL identifier');
  pushIf(errors, identifier(skills.joinTable), 'skills.joinTable must be a SQL identifier');
  pushIf(errors, positiveInteger(skills.max), 'skills.max invalid');
  pushIf(errors, positiveInteger(skills.candidatePool), 'skills.candidatePool invalid');
  validateSkillsScoring(errors, skills.scoring);
  pushIf(errors, Array.isArray(skills.noiseTerms), 'skills.noiseTerms must be an array');
  pushIf(errors, isObject(skills.explain), 'skills.explain missing');
}

function validateSkillIndexer(config, errors) {
  const script = scriptById(config, 'skill-indexer');
  pushIf(errors, isObject(script), 'missing scripts[id=skill-indexer]');
  if (!isObject(script)) return;
  const settings = script.settings || {};
  pushIf(errors, script.script?.path === 'inject-protocol/index-skills.py', 'skill-indexer.script.path mismatch');
  pushIf(errors, Array.isArray(settings.scanRoots) && settings.scanRoots.length > 0, 'skill-indexer scanRoots missing');
  pushIf(errors, Array.isArray(settings.skipPathContains), 'skill-indexer skipPathContains invalid');
  pushIf(errors, JSON.stringify(settings.fts?.columns) === JSON.stringify(['name', 'description', 'content']), 'skill-indexer fts.columns must be name/description/content');
  pushIf(errors, typeof settings.curatedRegex === 'string', 'skill-indexer curatedRegex invalid');
}

function validateTelemetry(config, errors) {
  const hook = hookById(config, 'hook-telemetry');
  pushIf(errors, isObject(hook), 'missing hooks[id=hook-telemetry]');
  if (!isObject(hook)) return;
  const evs = Array.isArray(hook.event) ? hook.event : [hook.event];
  pushIf(errors, evs.includes('PostToolUse'), 'hook-telemetry.event must include PostToolUse');
  pushIf(errors, hook.script?.path === 'hook-telemetry/log-event.py', 'hook-telemetry.script.path mismatch');
  const s = hook.settings || {};
  pushIf(errors, identifier(s.table), 'hook-telemetry settings.table must be a SQL identifier');
  pushIf(errors, Number.isInteger(s.retentionDays) && s.retentionDays >= 0, 'hook-telemetry settings.retentionDays must be an integer >= 0');
  pushIf(errors, positiveInteger(s.detailMaxChars), 'hook-telemetry settings.detailMaxChars invalid');
  pushIf(errors, positiveInteger(s.retentionPruneEvery), 'hook-telemetry settings.retentionPruneEvery invalid');
}

function validateMemoryNormalizer(config, errors) {
  const hook = hookById(config, 'memory-normalizer');
  pushIf(errors, isObject(hook), 'missing hooks[id=memory-normalizer]');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'PostToolUse', 'memory-normalizer.event must be PostToolUse');
  pushIf(errors, hook.script?.path === 'memory-normalizer/normalize-after-store.py', 'memory-normalizer.script.path mismatch');
  const s = hook.settings || {};
  pushIf(errors, identifier(s.table), 'memory-normalizer settings.table must be a SQL identifier');
  pushIf(errors, identifier(s.auditTable), 'memory-normalizer settings.auditTable must be a SQL identifier');
  pushIf(errors, positiveInteger(s.detailMaxChars), 'memory-normalizer settings.detailMaxChars invalid');
  const matchTools = hook.match?.tools;
  const matchToolsValid = nonEmptyStringArray(matchTools);
  const sourceToolsValid = nonEmptyStringArray(s.sourceTools);
  pushIf(errors, matchToolsValid, 'memory-normalizer match.tools must be a non-empty string array');
  pushIf(errors, sourceToolsValid, 'memory-normalizer settings.sourceTools must be a non-empty string array');
  if (matchToolsValid && sourceToolsValid) {
    const sortedUnique = (items) => [...new Set(items.map((item) => String(item)))].sort();
    const matchToolSet = sortedUnique(matchTools);
    const sourceToolSet = sortedUnique(s.sourceTools);
    pushIf(
      errors,
      matchToolSet.length === sourceToolSet.length && matchToolSet.every((tool, index) => tool === sourceToolSet[index]),
      'memory-normalizer match.tools must equal settings.sourceTools'
    );
  }
  const requiredMutationSuffixes = [
    'memory_store',
    'memory_update',
    'memory_store_session',
    'memory_observe',
    'memory_harvest',
    'memory_ingest',
    'memory_resolve',
    'memory_cleanup',
    'memory_delete',
    'mistake_note_add'
  ];
  if (Array.isArray(s.sourceTools)) {
    for (const suffix of requiredMutationSuffixes) {
      pushIf(
        errors,
        s.sourceTools.some((tool) => tool === suffix || String(tool).endsWith(`__${suffix}`)),
        `memory-normalizer sourceTools missing ${suffix}`
      );
    }
  }
  pushIf(errors, isObject(s.writes), 'memory-normalizer settings.writes must be an object');
  if (isObject(s.writes)) {
    pushIf(errors, identifier(s.writes.memoryTable), 'memory-normalizer settings.writes.memoryTable must be a SQL identifier');
    pushIf(errors, nonEmptyStringArray(s.writes.columns), 'memory-normalizer settings.writes.columns must be a non-empty string array');
    pushIf(errors, s.writes.contentMutation === false, 'memory-normalizer settings.writes.contentMutation must be false');
    pushIf(errors, s.writes.vectorMutation === false, 'memory-normalizer settings.writes.vectorMutation must be false');
    pushIf(errors, s.writes.ftsMutation === false, 'memory-normalizer settings.writes.ftsMutation must be false');
  }
}

function validateLoopSafety(config, errors) {
  const hook = hookById(config, 'loop-safety');
  pushIf(errors, isObject(hook), 'missing hooks[id=loop-safety]');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'PreToolUse', 'loop-safety.event must be PreToolUse');
  pushIf(errors, hook.script?.path === 'loop-safety/loop-guard.py', 'loop-safety.script.path mismatch');
  const s = hook.settings || {};
  pushIf(errors, identifier(s.table), 'loop-safety settings.table must be a SQL identifier');
  pushIf(errors, positiveInteger(s.softMax), 'loop-safety settings.softMax invalid');
  pushIf(errors, positiveInteger(s.hardMax), 'loop-safety settings.hardMax invalid');
  pushIf(errors, positiveInteger(s.lookback), 'loop-safety settings.lookback invalid');
  pushIf(errors, !(positiveInteger(s.softMax) && positiveInteger(s.hardMax)) || s.softMax <= s.hardMax, 'loop-safety settings.softMax must be <= hardMax');
  pushIf(errors, s.subcommandTools === undefined || (isObject(s.subcommandTools) && Object.values(s.subcommandTools).every((v) => positiveInteger(v))), 'loop-safety settings.subcommandTools must map names to positive integers');
  pushIf(errors, s.bashSkipTokens === undefined || (Array.isArray(s.bashSkipTokens) && s.bashSkipTokens.every((t) => typeof t === 'string')), 'loop-safety settings.bashSkipTokens must be a string array');
  pushIf(errors, s.editFamily === undefined || (Array.isArray(s.editFamily) && s.editFamily.every((t) => typeof t === 'string')), 'loop-safety settings.editFamily must be a string array');
  const tel = hookById(config, 'hook-telemetry');
  pushIf(errors, !(hook.enabled === true && isObject(tel) && tel.enabled === false), 'loop-safety.enabled requires hook-telemetry.enabled (it reads hook_events)');
}

function validateThinkingGate(config, errors) {
  const hook = hookById(config, 'thinking-gate');
  pushIf(errors, isObject(hook), 'missing hooks[id=thinking-gate]');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'PreToolUse', 'thinking-gate.event must be PreToolUse');
  pushIf(errors, hook.script?.path === 'thinking-gate/thinking-gate.py', 'thinking-gate.script.path mismatch');
  const s = hook.settings || {};
  pushIf(errors, identifier(s.table), 'thinking-gate settings.table must be a SQL identifier');
  pushIf(errors, identifier(s.consumptionTable), 'thinking-gate settings.consumptionTable must be a SQL identifier');
  pushIf(errors, positiveInteger(s.ttlSeconds), 'thinking-gate settings.ttlSeconds invalid');
  const policy = s.grantPolicy;
  pushIf(errors, isObject(policy), 'thinking-gate settings.grantPolicy must be an object');
  if (isObject(policy)) {
    pushIf(errors, policy.mode === 'bounded_tool_count', 'thinking-gate settings.grantPolicy.mode must be bounded_tool_count');
    pushIf(errors, positiveInteger(policy.maxToolUses), 'thinking-gate settings.grantPolicy.maxToolUses invalid');
    for (const key of ['maxGatedToolUses', 'consumeReadOnly', 'unknownToolPolicy', 'highRiskPolicy', 'shellCompoundPolicy']) {
      pushIf(errors, !(key in policy), `thinking-gate settings.grantPolicy.${key} is not supported`);
    }
  }
  for (const key of ['toolClasses', 'readOnlyShellPrefixes']) {
    pushIf(errors, !(key in s), `thinking-gate settings.${key} is not supported`);
  }
  pushIf(
    errors,
    Array.isArray(s.thinkingTools) && s.thinkingTools.length > 0 && s.thinkingTools.every((tool) => typeof tool === 'string' && tool.length > 0),
    'thinking-gate settings.thinkingTools must be a non-empty string array'
  );
  pushIf(
    errors,
    s.bootstrapTools === undefined || (isObject(s.bootstrapTools) && Object.values(s.bootstrapTools).every((terms) => (
      Array.isArray(terms) && terms.length > 0 && terms.every((term) => typeof term === 'string' && term.length > 0)
    ))),
    'thinking-gate settings.bootstrapTools must map tool names to non-empty string arrays'
  );
  pushIf(
    errors,
    s.readOnlyTools === undefined || (Array.isArray(s.readOnlyTools) && s.readOnlyTools.every((tool) => typeof tool === 'string' && tool.length > 0)),
    'thinking-gate settings.readOnlyTools must be a string array when present'
  );
  const tel = hookById(config, 'hook-telemetry');
  pushIf(errors, !(hook.enabled === true && isObject(tel) && tel.enabled === false), 'thinking-gate.enabled requires hook-telemetry.enabled (it reads hook_events)');
}

function validateTaskModeGate(config, errors) {
  const hook = hookById(config, 'task-mode-gate');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'UserPromptSubmit', 'task-mode-gate.event must be UserPromptSubmit');
  pushIf(errors, hook.script?.path === 'task-mode/task-mode-gate.mjs', 'task-mode-gate.script.path mismatch');
}

function validatePlanningStartGate(config, errors) {
  const hook = hookById(config, 'planning-start-gate');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'PreToolUse', 'planning-start-gate.event must be PreToolUse');
  pushIf(errors, hook.script?.path === 'task-mode/planning-start-gate.mjs', 'planning-start-gate.script.path mismatch');
  const taskMode = hookById(config, 'task-mode-gate');
  pushIf(errors, isObject(taskMode), 'planning-start-gate requires hooks[id=task-mode-gate]');
  const tel = hookById(config, 'hook-telemetry');
  pushIf(errors, !(hook.enabled === true && isObject(tel) && tel.enabled === false), 'planning-start-gate.enabled requires hook-telemetry.enabled');
}

function validateQualityCompletionGate(config, errors) {
  const hook = hookById(config, 'quality-completion-gate');
  pushIf(errors, isObject(hook), 'missing hooks[id=quality-completion-gate]');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'Stop', 'quality-completion-gate.event must be Stop');
  pushIf(errors, hook.script?.path === 'quality-completion-gate/quality-completion-gate.mjs', 'quality-completion-gate.script.path mismatch');
  const s = hook.settings || {};
  pushIf(errors, typeof s.verifyManifest === 'string' && s.verifyManifest.length > 0, 'quality-completion-gate settings.verifyManifest missing');
  pushIf(errors, s.authority === 'exit-codes-only', 'quality-completion-gate settings.authority must be exit-codes-only');
  pushIf(errors, positiveInteger(s.maxRepeatedFailureBlocks), 'quality-completion-gate settings.maxRepeatedFailureBlocks invalid');
  pushIf(errors, positiveInteger(s.totalBudgetMs), 'quality-completion-gate settings.totalBudgetMs invalid');
  pushIf(errors, nonEmptyStringArray(s.inputs), 'quality-completion-gate settings.inputs must be a non-empty string array');
  pushIf(errors, nonEmptyStringArray(s.nonAuthority), 'quality-completion-gate settings.nonAuthority must be a non-empty string array');
}

function hasPathMatcher(rule) {
  return ['prefixes', 'contains', 'extensions', 'fileNames', 'segments']
    .some((key) => Array.isArray(rule?.[key]) && rule[key].length > 0);
}

function validateAgentDiffPathRules(errors, paths, path) {
  pushIf(errors, Array.isArray(paths) && paths.length > 0, `${path}.paths must be a non-empty array`);
  if (!Array.isArray(paths)) return;
  for (const [index, rule] of paths.entries()) {
    const rulePath = `${path}.paths[${index}]`;
    pushIf(errors, isObject(rule), `${rulePath} must be an object`);
    if (!isObject(rule)) continue;
    pushIf(errors, hasPathMatcher(rule), `${rulePath} must define a matcher`);
    for (const key of ['prefixes', 'contains', 'extensions', 'fileNames', 'segments', 'excludePrefixes', 'excludeSegments', 'excludeContains']) {
      pushIf(errors, rule[key] === undefined || nonEmptyStringArray(rule[key]), `${rulePath}.${key} must be a non-empty string array when present`);
    }
  }
}

function validateAgentDiffTrigger(errors, trigger, path) {
  pushIf(errors, isObject(trigger), `${path}.trigger must be an object`);
  if (!isObject(trigger)) return;
  pushIf(errors, ADCG_TRIGGER_MODE_ENUM.includes(trigger.mode), `${path}.trigger.mode invalid`);
  pushIf(errors, trigger.minChangedFiles === undefined || positiveInteger(trigger.minChangedFiles), `${path}.trigger.minChangedFiles invalid`);
  pushIf(errors, trigger.minChangedLoc === undefined || positiveInteger(trigger.minChangedLoc), `${path}.trigger.minChangedLoc invalid`);

  if (trigger.mode === 'files') {
    pushIf(errors, positiveInteger(trigger.minChangedFiles), `${path}.trigger.minChangedFiles required for files mode`);
  } else if (trigger.mode === 'loc') {
    pushIf(errors, positiveInteger(trigger.minChangedLoc), `${path}.trigger.minChangedLoc required for loc mode`);
  } else {
    pushIf(
      errors,
      positiveInteger(trigger.minChangedFiles) || positiveInteger(trigger.minChangedLoc),
      `${path}.trigger requires minChangedFiles or minChangedLoc`
    );
  }
}

function validateAgentDiffRepos(errors, repos) {
  pushIf(errors, Array.isArray(repos), 'agent-diff-completion-gate settings.repos must be an array');
  if (!Array.isArray(repos)) return;
  for (const [repoIndex, repo] of repos.entries()) {
    const path = `agent-diff-completion-gate settings.repos[${repoIndex}]`;
    pushIf(errors, isObject(repo), `${path} must be an object`);
    if (!isObject(repo)) continue;
    pushIf(errors, typeof repo.name === 'string' && repo.name.length > 0, `${path}.name missing`);
    pushIf(errors, typeof repo.root === 'string' && repo.root.length > 0, `${path}.root missing`);
    pushIf(errors, typeof repo.enabled === 'boolean', `${path}.enabled must be boolean`);
    if (repo.enabled === false) continue;

    pushIf(errors, repo.extensions === undefined || nonEmptyStringArray(repo.extensions), `${path}.extensions must be a non-empty string array when present`);
    pushIf(errors, repo.tiers?.largeLocMin === undefined || positiveInteger(repo.tiers.largeLocMin), `${path}.tiers.largeLocMin invalid`);
    pushIf(errors, Array.isArray(repo.rules) && repo.rules.length > 0, `${path}.rules must be a non-empty array for enabled repos`);
    if (Array.isArray(repo.rules)) {
      for (const [ruleIndex, rule] of repo.rules.entries()) {
        const rulePath = `${path}.rules[${ruleIndex}]`;
        pushIf(errors, isObject(rule), `${rulePath} must be an object`);
        if (!isObject(rule)) continue;
        pushIf(errors, typeof rule.name === 'string' && rule.name.length > 0, `${rulePath}.name missing`);
        pushIf(errors, rule.extensions === undefined || nonEmptyStringArray(rule.extensions), `${rulePath}.extensions must be a non-empty string array when present`);
        validateAgentDiffPathRules(errors, rule.paths, rulePath);
        validateAgentDiffTrigger(errors, rule.trigger, rulePath);
      }
    }

    const verification = repo.verification;
    pushIf(errors, isObject(verification), `${path}.verification must be an object for enabled repos`);
    if (isObject(verification)) {
      pushIf(errors, typeof verification.command === 'string' && verification.command.length > 0, `${path}.verification.command missing`);
      pushIf(errors, positiveInteger(verification.timeoutMs), `${path}.verification.timeoutMs invalid`);
      pushIf(errors, typeof verification.label === 'string' && verification.label.length > 0, `${path}.verification.label missing`);
      pushIf(errors, typeof verification.verificationDir === 'string' && verification.verificationDir.length > 0, `${path}.verification.verificationDir missing`);
      pushIf(errors, verification.requireLiveApi === undefined || typeof verification.requireLiveApi === 'boolean', `${path}.verification.requireLiveApi must be boolean when present`);
      pushIf(errors, verification.requireFrontendLogin === undefined || typeof verification.requireFrontendLogin === 'boolean', `${path}.verification.requireFrontendLogin must be boolean when present`);
    }
  }
}

function validateAgentDiffCompletionGate(config, errors) {
  const hook = hookById(config, 'agent-diff-completion-gate');
  if (!isObject(hook)) return;
  pushIf(errors, hook.event === 'Stop', 'agent-diff-completion-gate.event must be Stop');
  pushIf(errors, hook.script?.path === 'agent-diff-completion-gate/agent-diff-completion-gate.mjs', 'agent-diff-completion-gate.script.path mismatch');
  const s = hook.settings || {};
  pushIf(errors, positiveInteger(s.maxRepeatedBlocks), 'agent-diff-completion-gate settings.maxRepeatedBlocks invalid');
  pushIf(errors, positiveInteger(s.maxRemediationLoops), 'agent-diff-completion-gate settings.maxRemediationLoops invalid');
  pushIf(errors, s.locLargeMin === undefined || positiveInteger(s.locLargeMin), 'agent-diff-completion-gate settings.locLargeMin invalid');
  pushIf(
    errors,
    s.stateDir === undefined || (typeof s.stateDir === 'string' && s.stateDir.length > 0),
    'agent-diff-completion-gate settings.stateDir must be a non-empty string when present'
  );
  validateAgentDiffRepos(errors, s.repos);
  const tel = hookById(config, 'hook-telemetry');
  pushIf(
    errors,
    !(hook.enabled === true && isObject(tel) && tel.enabled === false),
    'agent-diff-completion-gate.enabled requires hook-telemetry.enabled (it reads hook_events)'
  );
}

function validateStopCompletionChain(config, errors) {
  const script = (config.scripts || []).find((entry) => entry?.id === 'stop-completion-chain');
  pushIf(errors, isObject(script), 'missing scripts[id=stop-completion-chain]');
  if (!isObject(script)) return;
  pushIf(errors, script.script?.path === 'stop-completion-chain/stop-completion-chain.mjs', 'stop-completion-chain.script.path mismatch');
  const chain = script.settings?.chain;
  pushIf(
    errors,
    nonEmptyStringArray(chain) && chain.every((id) => isObject(hookById(config, id))),
    'stop-completion-chain settings.chain must list existing hook ids'
  );
  const s = script.settings || {};
  pushIf(errors, positiveInteger(s.stepTimeoutMs), 'stop-completion-chain settings.stepTimeoutMs invalid');
  const qualityGate = hookById(config, 'quality-completion-gate');
  const qualityBudgetMs = qualityGate?.settings?.totalBudgetMs;
  if (positiveInteger(s.stepTimeoutMs) && positiveInteger(qualityBudgetMs)) {
    pushIf(
      errors,
      s.stepTimeoutMs > qualityBudgetMs,
      'stop-completion-chain settings.stepTimeoutMs must exceed quality-completion-gate settings.totalBudgetMs'
    );
  }
}

function validateFrontendDesignGate(config, errors) {
  const hook = hookById(config, 'frontend-design-gate');
  if (!isObject(hook)) return; // optional hook — validate only when present
  pushIf(errors, hook.event === 'Stop', 'frontend-design-gate.event must be Stop');
  pushIf(errors, hook.script?.path === 'frontend-design-gate/frontend-design-gate.py', 'frontend-design-gate.script.path mismatch');
  const s = hook.settings || {};
  pushIf(
    errors,
    isObject(s.primitives) && Object.keys(s.primitives).length > 0 && Object.values(s.primitives).every((v) => typeof v === 'string' && v.length > 0),
    'frontend-design-gate settings.primitives must map element names to non-empty filenames'
  );
  pushIf(errors, positiveInteger(s.maxRepeatedBlocks), 'frontend-design-gate settings.maxRepeatedBlocks invalid');
  pushIf(errors, s.stateDir === undefined || (typeof s.stateDir === 'string' && s.stateDir.length > 0), 'frontend-design-gate settings.stateDir must be a non-empty string when present');
  // No telemetry coupling: this gate reads git (diff), not hook_events.
}

export function validateConfig(config) {
  const errors = [];
  validateBaseConfig(config, errors);
  validateInjectProtocol(config, errors);
  validateTelemetry(config, errors);
  validateMemoryNormalizer(config, errors);
  validateLoopSafety(config, errors);
  validateThinkingGate(config, errors);
  validateTaskModeGate(config, errors);
  validatePlanningStartGate(config, errors);
  validateQualityCompletionGate(config, errors);
  validateAgentDiffCompletionGate(config, errors);
  validateStopCompletionChain(config, errors);
  validateFrontendDesignGate(config, errors);
  validateSkillIndexer(config, errors);
  return { ok: errors.length === 0, errors };
}

export const configModel = {
  events: EVENT_ENUM,
  runtimes: RUNTIME_ENUM,
  hookCategories: HOOK_CATEGORY_ENUM,
  failPolicies: FAIL_POLICY_ENUM,
  projectKinds: PROJECT_KIND_ENUM,
  tokenizer: TOKENIZER_CONFIG,
};
