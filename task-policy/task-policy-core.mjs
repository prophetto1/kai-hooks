/**
 * Active Task Policy core.
 *
 * Owns the Active Task Envelope lifecycle, explicit directive parsing and
 * precedence, task-relative Git change calculation, Stop gate selection and
 * disposition, unchanged-failure fingerprints, and bounded decision records.
 *
 * This module is pure/in-process. It performs no host I/O of its own beyond
 * local ignored `.state/` files and read-only Git inspection. It never persists
 * raw prompt text or raw command output. See
 * `_briefs/2026-06-21-stop-task-policy-control-plane-implementation-plan.md`.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const ENVELOPE_SCHEMA_VERSION = 1;
export const DECISION_SCHEMA_VERSION = 1;

export const DIRECTIVE_KINDS = [
  'read-only',
  'browser-verification',
  'full-suite',
  'scope-lock',
  'failure-scope',
];

export const COMMAND_CLASSES = [
  'quality',
  'browser',
  'full-suite',
  'config',
  'docs',
  'security',
  'targeted',
];

export const GATES = ['completion-quality-gate'];

export const DEFAULT_TASK_POLICY = {
  schemaVersion: ENVELOPE_SCHEMA_VERSION,
  stateDir: 'E:/hooks/.state/task-policy',
  maxObjectiveChars: 280,
  maxDecisionRecords: 200,
  decisionRetentionDays: 14,
  continuationPhrases: [
    'continue',
    'keep going',
    'carry on',
    'same task',
    'still on',
    'also',
    'and also',
    'in addition',
    'as well',
    'follow up',
    'follow-up',
    'next,',
    'now also',
    'one more',
  ],
  commandClassPatterns: {
    'full-suite': [
      'pytest tests/',
      'pytest tests ',
      'python -m pytest tests/',
      '-m pytest tests',
      'run test:all',
      'test:all',
      'ci:platform-api',
      'api-all-tests',
      'full suite',
      'full-suite',
    ],
    browser: [
      'playwright',
      'ui-snapshot',
      'ui snapshot',
      'visual-manifest',
      'verify-platform-visual',
      'puppeteer',
    ],
  },
  defaultDispositions: {
    'completion-quality-gate': 'block',
  },
  integrityPolicyId: 'verification-integrity',
};

/* ----------------------------------------------------------------------------
 * Small utilities
 * ------------------------------------------------------------------------- */

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/');
}

export function nowIso() {
  return new Date().toISOString();
}

export function taskPolicyConfig(shared = {}) {
  const provided = shared && typeof shared === 'object' ? shared.taskPolicy || {} : {};
  return {
    ...DEFAULT_TASK_POLICY,
    ...provided,
    commandClassPatterns: {
      ...DEFAULT_TASK_POLICY.commandClassPatterns,
      ...(provided.commandClassPatterns || {}),
    },
    defaultDispositions: {
      ...DEFAULT_TASK_POLICY.defaultDispositions,
      ...(provided.defaultDispositions || {}),
    },
  };
}

export function sessionRepoKey(sessionId, repoRoot) {
  return sha256({ sessionId: sessionId || '', repoRoot: normalizePath(repoRoot) });
}

/* ----------------------------------------------------------------------------
 * State paths and atomic persistence
 * ------------------------------------------------------------------------- */

export function policyStateDir(config) {
  return (config && config.stateDir) || DEFAULT_TASK_POLICY.stateDir;
}

export function envelopePath(config, sessionId, repoRoot) {
  return join(policyStateDir(config), 'envelopes', `${sessionRepoKey(sessionId, repoRoot)}.json`);
}

export function decisionsPath(config, sessionId, repoRoot) {
  return join(policyStateDir(config), 'decisions', `${sessionRepoKey(sessionId, repoRoot)}.jsonl`);
}

function writeFileAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${sha256(`${path}:${contents.length}:${contents.slice(0, 16)}`).slice(0, 8)}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

export function readEnvelope(config, sessionId, repoRoot) {
  try {
    const parsed = JSON.parse(readFileSync(envelopePath(config, sessionId, repoRoot), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed', envelope: null };
    if (parsed.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
      return { ok: false, reason: `unsupported-version:${parsed.schemaVersion}`, envelope: null };
    }
    return { ok: true, reason: '', envelope: parsed };
  } catch (error) {
    const missing = error && error.code === 'ENOENT';
    return { ok: false, reason: missing ? 'missing' : 'unreadable', envelope: null };
  }
}

export function writeEnvelope(config, sessionId, repoRoot, envelope) {
  writeFileAtomic(envelopePath(config, sessionId, repoRoot), `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

/* ----------------------------------------------------------------------------
 * Secret redaction + objective derivation
 * ------------------------------------------------------------------------- */

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{12,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9+/_-]{32,}\b/g,
];

export function redactSecrets(text) {
  let out = String(text || '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

const DIRECTIVE_STRIP_PATTERNS = [
  /\bread[- ]?only\b/gi,
  /\b(?:do not|don'?t)\s+(?:modify|edit|change|write|run|touch)[^.\n]*/gi,
  /\b(?:skip|bypass|no)\s+(?:playwright|browser|visual|ui ?snapshot|the full[^.\n]*)/gi,
  /\bscope:\s*\S+/gi,
  /\bforbid-scope:\s*\S+/gi,
  /\broutes?:\s*[^\n]+/gi,
];

export function deriveObjective(prompt, config = DEFAULT_TASK_POLICY) {
  let text = String(prompt || '');
  for (const pattern of DIRECTIVE_STRIP_PATTERNS) text = text.replace(pattern, ' ');
  text = redactSecrets(text).replace(/\s+/g, ' ').trim();
  const max = config.maxObjectiveChars || DEFAULT_TASK_POLICY.maxObjectiveChars;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/* ----------------------------------------------------------------------------
 * Directive parsing + precedence
 * ------------------------------------------------------------------------- */

function recordDirective(list, kind, value, prompt, observedAt) {
  list.push({ kind, value, sourceHash: sha256(`${kind}:${value}`), observedAt });
}

export function parseDirectives(prompt, observedAt = nowIso()) {
  const text = String(prompt || '');
  const directives = [];

  // Require directive intent, not a bare "read-only" mention. Descriptive prompts
  // that merely discuss the read-only feature must not lock the session.
  const readOnlyDirective =
    /^\s*read[- ]?only\b/i.test(text) ||
    /\bmode:\s*read[- ]?only\b/i.test(text) ||
    /\b(?:keep|make|set|treat|stay|leave|going)\b[^.\n]{0,40}\bread[- ]?only\b/i.test(text) ||
    /\bread[- ]?only\s+(?:mode|task|session|run|pass|please)\b/i.test(text) ||
    /\b(?:this|it|task)\s+(?:is|stays?|should be)\s+read[- ]?only\b/i.test(text) ||
    /\b(?:do not|don'?t)\s+(?:modify|edit|change|write)\b/i.test(text);
  if (readOnlyDirective) {
    recordDirective(directives, 'read-only', 'on', text, observedAt);
  }
  const browserSkip = /\b(?:skip|bypass|do not run|don'?t run|no)\s+(?:the\s+)?(?:playwright|browser|visual|ui ?snapshot)\b/i.test(text);
  if (browserSkip) {
    recordDirective(directives, 'browser-verification', 'skip', text, observedAt);
  }
  if (/\b(?:do not run|don'?t run|skip|no)\s+(?:the\s+)?(?:full|entire|whole)\s+(?:backend\s+)?(?:test\s+)?(?:suite|tests?|backend)\b/i.test(text)) {
    recordDirective(directives, 'full-suite', 'skip', text, observedAt);
  }
  if (/\b(?:do not change scope|don'?t change scope|stay in scope|scope[- ]?lock|report[- ]?only unrelated)\b/i.test(text)) {
    recordDirective(directives, 'scope-lock', 'on', text, observedAt);
  }

  // Explicit lift directives clear a prior matching restriction. Lift is only
  // considered when the same prompt did not also request a skip for that kind.
  const readOnlySet = directives.some((d) => d.kind === 'read-only');
  if (!browserSkip && (/\b(?:now\s+)?run\s+(?:playwright|the browser)\b/i.test(text) || /\blift\s+(?:the\s+)?browser\b/i.test(text))) {
    recordDirective(directives, 'browser-verification', 'lift', text, observedAt);
  }
  if (!readOnlySet && (/\b(?:you may|please)\s+(?:edit|modify|write)\b/i.test(text) || /\blift\s+read[- ]?only\b/i.test(text))) {
    recordDirective(directives, 'read-only', 'lift', text, observedAt);
  }

  return directives;
}

export function parseScopesAndRoutes(prompt) {
  const text = String(prompt || '');
  const allowedScopes = [];
  const forbiddenScopes = [];
  const selectedRoutes = [];

  for (const match of text.matchAll(/(?<![\w-])scope:\s*([^\s,]+)/gi)) allowedScopes.push(normalizePath(match[1]));
  for (const match of text.matchAll(/\bforbid-scope:\s*([^\s,]+)/gi)) forbiddenScopes.push(normalizePath(match[1]));
  const routesLine = text.match(/\broutes?:\s*([^\n]+)/i);
  if (routesLine) {
    for (const route of routesLine[1].split(',')) {
      const trimmed = route.trim().split(/\s/)[0];
      if (trimmed) selectedRoutes.push(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
    }
  }
  return {
    allowedScopes: [...new Set(allowedScopes)],
    forbiddenScopes: [...new Set(forbiddenScopes)],
    selectedRoutes: [...new Set(selectedRoutes)],
  };
}

/**
 * Latest explicit directive for the same kind supersedes the prior one.
 * A `lift` value clears the restriction for that kind (no active directive).
 */
export function mergeDirectives(prior = [], incoming = []) {
  const byKind = new Map();
  for (const directive of [...prior, ...incoming]) {
    if (!directive || !DIRECTIVE_KINDS.includes(directive.kind)) continue;
    byKind.set(directive.kind, directive); // later entries supersede earlier
  }
  const merged = [];
  for (const directive of byKind.values()) {
    if (directive.value === 'lift') continue;
    merged.push(directive);
  }
  return merged.sort((a, b) => a.kind.localeCompare(b.kind));
}

export function activeDirective(directives, kind) {
  return (directives || []).find((directive) => directive.kind === kind) || null;
}

/* ----------------------------------------------------------------------------
 * Continuation detection
 * ------------------------------------------------------------------------- */

export function isContinuationPrompt(prompt, config = DEFAULT_TASK_POLICY) {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  const phrases = config.continuationPhrases || DEFAULT_TASK_POLICY.continuationPhrases;
  return phrases.some((phrase) => {
    const needle = String(phrase).toLowerCase();
    return text === needle || text.startsWith(`${needle} `) || text.startsWith(`${needle},`);
  });
}

/* ----------------------------------------------------------------------------
 * Git baseline + task-relative change calculation
 * ------------------------------------------------------------------------- */

function git(repoRoot, args, timeoutMs) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function headCommit(repoRoot, timeoutMs) {
  try {
    return git(repoRoot, ['rev-parse', 'HEAD'], timeoutMs).trim();
  } catch {
    return '';
  }
}

function parseStatusZ(status) {
  const out = [];
  const records = String(status || '').split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (code.includes('R') || code.includes('C')) {
      index += 1; // rename/copy: next record is the source path
    }
    if (file) out.push({ code: code.trim() || code, file: normalizePath(file) });
  }
  return out;
}

// Files at or below this size are content-hashed (precise); larger files fall
// back to a cheap size+mtime fingerprint so a huge dirty file never forces a
// full-content read on every prompt and every Stop. Deletions hash as absent.
export const FINGERPRINT_CONTENT_CAP_BYTES = 512 * 1024;

function fileFingerprint(repoRoot, file, code) {
  const abs = join(repoRoot, file);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return sha256(`${code}\0absent`); // deleted/unreadable path
  }
  if (stat.isFile() && stat.size <= FINGERPRINT_CONTENT_CAP_BYTES) {
    try {
      return sha256(`${code}\0c\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    } catch {
      // fall through to stat-based fingerprint
    }
  }
  return sha256(`${code}\0s\0${stat.size}\0${Math.floor(stat.mtimeMs)}`);
}

export function captureBaseline(repoRoot, timeoutMs = 5000) {
  const commit = headCommit(repoRoot, timeoutMs);
  const dirtyFingerprints = {};
  try {
    const status = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs);
    for (const { code, file } of parseStatusZ(status)) {
      dirtyFingerprints[file] = fileFingerprint(repoRoot, file, code);
    }
  } catch {
    // leave dirtyFingerprints empty on failure; delta calc reports uncertainty
  }
  return { commit, dirtyFingerprints };
}

/**
 * Task-relative change set: files changed since the baseline, including files
 * committed during the task and excluding pre-existing dirt that is unchanged.
 */
export function taskRelativeChanges(repoRoot, baseline, timeoutMs = 5000) {
  if (!baseline || typeof baseline !== 'object') {
    return { ok: false, uncertain: true, reason: 'no-baseline', changedFiles: [], fingerprint: '' };
  }
  const baselineDirty = baseline.dirtyFingerprints || {};
  const changed = new Set();

  // 1) Current working-tree dirt vs baseline dirt.
  let currentStatus;
  try {
    currentStatus = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs);
  } catch (error) {
    return {
      ok: false,
      uncertain: true,
      reason: `status-failed:${error.message || error}`,
      changedFiles: [],
      fingerprint: '',
    };
  }
  const currentFingerprints = {};
  for (const { code, file } of parseStatusZ(currentStatus)) {
    currentFingerprints[file] = fileFingerprint(repoRoot, file, code);
  }
  for (const [file, fp] of Object.entries(currentFingerprints)) {
    if (baselineDirty[file] === fp) continue; // unchanged pre-existing dirt
    changed.add(file); // new dirt, or pre-existing dirt the task modified further
  }
  // Pre-existing dirt the task reverted to clean is a task change too.
  for (const file of Object.keys(baselineDirty)) {
    if (!(file in currentFingerprints)) changed.add(file);
  }

  // 2) Files committed during the task (baseline.commit..HEAD).
  let uncertain = false;
  let reason = '';
  const head = headCommit(repoRoot, timeoutMs);
  if (baseline.commit && head && baseline.commit !== head) {
    let related = false;
    try {
      git(repoRoot, ['merge-base', '--is-ancestor', baseline.commit, head], timeoutMs);
      related = true;
    } catch {
      related = false;
    }
    if (!related) {
      uncertain = true;
      reason = 'baseline-not-ancestor';
    } else {
      try {
        const diff = git(repoRoot, ['diff', '--name-only', '-z', `${baseline.commit}..${head}`], timeoutMs);
        for (const file of diff.split('\0')) {
          const norm = normalizePath(file);
          if (norm) changed.add(norm);
        }
      } catch (error) {
        uncertain = true;
        reason = `diff-failed:${error.message || error}`;
      }
    }
  } else if (baseline.commit && !head) {
    uncertain = true;
    reason = 'head-unresolved';
  }

  const changedFiles = [...changed].sort();
  const fingerprint = sha256(changedFiles.map((file) => `${file}:${currentFingerprints[file] || 'committed'}`).join('\n'));
  return { ok: !uncertain, uncertain, reason, changedFiles, fingerprint };
}

/* ----------------------------------------------------------------------------
 * Command classification + directive filtering
 * ------------------------------------------------------------------------- */

export function classifyCommand(command, config = DEFAULT_TASK_POLICY) {
  if (command && Array.isArray(command.classes) && command.classes.length) {
    return [...command.classes];
  }
  const text = String((command && command.command) || command || '').toLowerCase();
  const classes = new Set(['quality', 'targeted']);
  const patterns = config.commandClassPatterns || DEFAULT_TASK_POLICY.commandClassPatterns;
  for (const [klass, needles] of Object.entries(patterns)) {
    if (needles.some((needle) => text.includes(String(needle).toLowerCase()))) {
      classes.add(klass);
      if (klass === 'full-suite') classes.delete('targeted');
    }
  }
  return [...classes];
}

export function commandIsAllowed(classes, directives) {
  const set = new Set(classes || []);
  if (activeDirective(directives, 'read-only')) return false;
  if (activeDirective(directives, 'browser-verification') && set.has('browser')) return false;
  if (activeDirective(directives, 'full-suite') && set.has('full-suite')) return false;
  return true;
}

/* ----------------------------------------------------------------------------
 * Gate selection + disposition
 * ------------------------------------------------------------------------- */

function dispositionFor(gateId, config) {
  const configured = (config.defaultDispositions || {})[gateId];
  return configured === 'report-only' ? 'report-only' : 'block';
}

/**
 * Compute the Stop policy decision: per-gate selection (skip|run) and failure
 * disposition (none|report-only|block), plus the allowed command IDs.
 *
 * @param {object} params
 * @param {object} params.envelope        active envelope (directives/scopes/routes)
 * @param {object} params.delta           taskRelativeChanges() result
 * @param {Array}  params.qualityCommands manifest commands [{id, command, classes}]
 * @param {object} params.config          task-policy config
 * @param {function} [params.applicability] gateId -> boolean (agent-diff body, Task 3)
 */
export function selectGates({ envelope, delta, qualityCommands = [], config = DEFAULT_TASK_POLICY, applicability }) {
  const directives = (envelope && envelope.userDirectives) || [];
  const readOnly = Boolean(activeDirective(directives, 'read-only'));
  const scopeLocked = Boolean(activeDirective(directives, 'scope-lock'));
  const hasDelta = Boolean(delta && delta.changedFiles && delta.changedFiles.length);
  const uncertain = Boolean(delta && delta.uncertain);
  const applies = typeof applicability === 'function' ? applicability : () => hasDelta;

  const findingDisposition = (gateId) => (scopeLocked ? 'report-only' : dispositionFor(gateId, config));

  const gates = [];

  // Completion-quality executor: quality commands + risk/live-verification policy.
  {
    const reasonCodes = [];
    let selection = 'run';
    let failureDisposition = findingDisposition('completion-quality-gate');
    const allowed = (qualityCommands || []).filter((cmd) => commandIsAllowed(classifyCommand(cmd, config), directives));
    const browserSkipped = Boolean(activeDirective(directives, 'browser-verification'));
    const hasQualityWork = allowed.length > 0;
    const hasRiskWork = !browserSkipped;
    if (readOnly) {
      selection = 'skip';
      failureDisposition = 'none';
      reasonCodes.push('read-only');
    } else if (uncertain) {
      selection = 'skip';
      failureDisposition = 'none';
      reasonCodes.push('policy-uncertain');
    } else if (!hasDelta) {
      selection = 'skip';
      failureDisposition = 'none';
      reasonCodes.push('no-task-delta');
    } else if (!hasQualityWork && !hasRiskWork) {
      selection = 'skip';
      failureDisposition = 'none';
      reasonCodes.push((qualityCommands || []).length ? 'all-commands-filtered' : 'no-commands');
    } else if (!applies('completion-quality-gate')) {
      selection = 'skip';
      failureDisposition = 'none';
      reasonCodes.push('not-applicable');
    } else {
      reasonCodes.push('task-relevant');
      if (browserSkipped) reasonCodes.push('risk-phase-browser-skipped');
    }
    gates.push({
      gate: 'completion-quality-gate',
      selection,
      failureDisposition,
      reasonCodes,
      commandIds: allowed.map((cmd) => cmd.id).filter(Boolean),
      blocking: false,
      unrelatedFindings: [],
    });
  }

  return gates;
}

/* ----------------------------------------------------------------------------
 * Decision records (bounded, sanitized JSONL)
 * ------------------------------------------------------------------------- */

export function failureFingerprint(gate, commandIds, changeFingerprint) {
  return sha256({ gate, commandIds: [...(commandIds || [])].sort(), changeFingerprint: changeFingerprint || '' });
}

function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return { title: String(finding || '') };
  const out = {};
  if (finding.title) out.title = String(finding.title).slice(0, 200);
  if (finding.file) out.file = normalizePath(finding.file);
  if (finding.reasonCode) out.reasonCode = String(finding.reasonCode).slice(0, 64);
  if (finding.commandId) out.commandId = String(finding.commandId).slice(0, 128);
  return out;
}

export function buildDecision({ taskId, repoRoot, delta, gates, now = nowIso() }) {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    decisionId: sha256({ taskId, fp: (delta && delta.fingerprint) || '', now }),
    taskId: taskId || '',
    repoRoot: normalizePath(repoRoot),
    taskChangedFiles: (delta && delta.changedFiles) || [],
    taskChangeFingerprint: (delta && delta.fingerprint) || '',
    gates: (gates || []).map((gate) => ({
      gate: gate.gate,
      selection: gate.selection,
      failureDisposition: gate.failureDisposition,
      reasonCodes: gate.reasonCodes || [],
      commandIds: gate.commandIds || [],
      blocking: Boolean(gate.blocking),
      failureFingerprint: gate.failureFingerprint || '',
      unrelatedFindings: (gate.unrelatedFindings || []).map(sanitizeFinding),
    })),
    createdAt: now,
  };
}

export function readDecisions(config, sessionId, repoRoot) {
  try {
    const raw = readFileSync(decisionsPath(config, sessionId, repoRoot), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function withinRetention(record, config, now) {
  const days = config.decisionRetentionDays ?? DEFAULT_TASK_POLICY.decisionRetentionDays;
  if (!days) return true; // 0 (or falsy) disables age-based retention; bound by count only
  const created = Date.parse(record.createdAt || '');
  if (Number.isNaN(created)) return true;
  return now - created <= days * 24 * 60 * 60 * 1000;
}

export function appendDecision(config, sessionId, repoRoot, decision, nowMs = Date.now()) {
  const max = config.maxDecisionRecords || DEFAULT_TASK_POLICY.maxDecisionRecords;
  const path = decisionsPath(config, sessionId, repoRoot);
  // Append-only common path: each Stop appends exactly its own line, so concurrent
  // Stops cannot clobber each other's records (no read-modify-write race).
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(decision)}\n`, 'utf8');
  } catch {
    return decision; // best-effort logging; never block completion
  }
  // Amortized retention: only rewrite-trim once the file grows well past the cap,
  // so the read-rewrite cost is O(1/max) per append rather than per append.
  try {
    const records = readDecisions(config, sessionId, repoRoot);
    if (records.length >= max * 2) {
      const kept = records.filter((record) => withinRetention(record, config, nowMs)).slice(-max);
      writeFileAtomic(path, `${kept.map((record) => JSON.stringify(record)).join('\n')}\n`);
    }
  } catch {
    // trim is best-effort
  }
  return decision;
}

/**
 * Returns the last recorded blocking failure for a gate when its input
 * fingerprint is unchanged — used to suppress re-running an unchanged blocker.
 */
export function unchangedFailure(config, sessionId, repoRoot, gate, fingerprint) {
  const decisions = readDecisions(config, sessionId, repoRoot);
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const record = decisions[index];
    const gateRecord = (record.gates || []).find((entry) => entry.gate === gate && entry.blocking);
    if (gateRecord && gateRecord.failureFingerprint === fingerprint) {
      return { seen: true, record, gateRecord };
    }
  }
  return { seen: false };
}

/* ----------------------------------------------------------------------------
 * Envelope create / amend
 * ------------------------------------------------------------------------- */

/**
 * Create a new envelope (substantive prompt) or amend the active one
 * (continuation / directive-only prompt).
 */
export function createOrAmendEnvelope({
  existing,
  prompt,
  mode,
  sessionId,
  repoRoot,
  config = DEFAULT_TASK_POLICY,
  baseline,
  telemetryWatermark = 0,
  now = nowIso(),
}) {
  const promptHash = sha256(String(prompt || ''));
  const observedDirectives = parseDirectives(prompt, now);
  const scopes = parseScopesAndRoutes(prompt);
  const continuation = isContinuationPrompt(prompt, config);
  const amend = Boolean(existing && existing.schemaVersion === ENVELOPE_SCHEMA_VERSION && (continuation || observedDirectives.length > 0) && !hasSubstantiveObjective(prompt, continuation));

  if (amend) {
    return {
      ...existing,
      mode: mode || existing.mode,
      userDirectives: mergeDirectives(existing.userDirectives, observedDirectives),
      allowedScopes: [...new Set([...(existing.allowedScopes || []), ...scopes.allowedScopes])],
      forbiddenScopes: [...new Set([...(existing.forbiddenScopes || []), ...scopes.forbiddenScopes])],
      selectedRoutes: [...new Set([...(existing.selectedRoutes || []), ...scopes.selectedRoutes])],
      telemetryWatermark: telemetryWatermark || existing.telemetryWatermark || 0,
      updatedAt: now,
      lastUserMessageHash: promptHash,
    };
  }

  const taskId = sha256({ sessionId, repoRoot: normalizePath(repoRoot), promptHash, startedAt: now });
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    taskId,
    turnId: sha256({ taskId, promptHash, now }),
    sessionId: sessionId || '',
    repoRoot: normalizePath(repoRoot),
    mode: mode || 'explore',
    objective: deriveObjective(prompt, config),
    allowedScopes: scopes.allowedScopes,
    forbiddenScopes: scopes.forbiddenScopes,
    selectedRoutes: scopes.selectedRoutes,
    userDirectives: mergeDirectives([], observedDirectives),
    baseline: baseline || { commit: '', dirtyFingerprints: {} },
    telemetryWatermark: telemetryWatermark || 0,
    checkpointDone: false,
    startedAt: now,
    updatedAt: now,
    lastUserMessageHash: promptHash,
  };
}

/**
 * A prompt is "substantive" (starts a new task baseline) when it is not a
 * recognized continuation and is not purely a directive. Directive-only prompts
 * (e.g. "do not run Playwright") amend the active task.
 */
function hasSubstantiveObjective(prompt, continuation) {
  if (continuation) return false;
  const objective = deriveObjective(prompt, DEFAULT_TASK_POLICY);
  return objective.replace(/[^a-z0-9]/gi, '').length >= 8;
}

export { hasSubstantiveObjective };
