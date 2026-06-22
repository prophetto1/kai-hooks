#!/usr/bin/env node
/**
 * Canonical Stop chain for Codex + Claude Code.
 * Runs enabled completion gates in order and blocks on the first failure.
 */
import { execFileSync } from 'node:child_process';
import {
  STOP_REPORT_ONLY_PREFIX,
  gitRoot,
  loadVerifyManifest,
  repoEntryForRoot,
  stopFailureResponse,
} from '../quality-completion-gate/quality-gate-core.mjs';
import { detectFraudulentVerificationInTelemetry } from '../quality-completion-gate/verification-integrity.mjs';
import {
  appendDecision,
  buildDecision,
  classifyCommand,
  failureFingerprint,
  readEnvelope,
  redactSecrets,
  selectGates,
  taskPolicyConfig,
  taskRelativeChanges,
  unchangedFailure,
} from '../task-policy/task-policy-core.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HARD_NON_REDIRECT =
  'Stop diagnostics do not authorize new work. Unrelated findings are report-only and must not be edited, rerun, or remediated without a new user directive.';

const HOOKS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || join(HOOKS_ROOT, 'config.json');
const DEFAULT_STEP_TIMEOUT_MS = 180000;

const DEFAULT_CHAIN = [
  { id: 'memory-harvester', script: 'memory-harvester/harvest-stop.py', runtime: 'python' },
  { id: 'quality-completion-gate', script: 'quality-completion-gate/quality-completion-gate.mjs', runtime: 'node' },
  { id: 'agent-diff-completion-gate', script: 'agent-diff-completion-gate/agent-diff-completion-gate.mjs', runtime: 'node' },
];

export function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { hooks: [] };
  }
}

export function configuredChain(config) {
  const byId = new Map((config.hooks || []).filter((hook) => hook && hook.id).map((hook) => [hook.id, hook]));
  const configuredIds = stopChainSettings(config).chain;
  const baseSteps = Array.isArray(configuredIds) && configuredIds.length
    ? configuredIds.map((id) => ({ id }))
    : DEFAULT_CHAIN;

  return baseSteps
    .map((step) => {
      const hook = byId.get(step.id);
      if (!hook || hook.enabled === false) return null;
      const fallback = DEFAULT_CHAIN.find((item) => item.id === step.id) || {};
      return {
        ...fallback,
        ...step,
        script: hook.script?.path || step.script || fallback.script,
        runtime: hook.script?.runtime || step.runtime || fallback.runtime,
        failOpenPreStep: step.id === 'memory-harvester',
      };
    })
    .filter(Boolean);
}

export function stopChainSettings(config) {
  const script = (config.scripts || []).find((entry) => entry?.id === 'stop-completion-chain');
  return script?.settings && typeof script.settings === 'object' ? script.settings : {};
}

export function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning
    }
  }
  return null;
}

export function blockReason(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.decision === 'block') return parsed.reason || parsed.systemMessage || 'Stop gate blocked completion.';
  if (parsed.continue === false) return parsed.reason || parsed.systemMessage || 'Stop gate blocked completion.';
  return null;
}

export function runStep(step, input, timeoutMs) {
  const scriptPath = join(HOOKS_ROOT, step.script);
  if (!existsSync(scriptPath)) {
    return { ok: false, reason: `stop-completion-chain: missing script for ${step.id}: ${scriptPath}` };
  }

  const command = step.runtime === 'python' ? process.env.HOOKS_PYTHON || 'python' : process.env.HOOKS_NODE || 'node';
  const args = step.runtime === 'python' ? [scriptPath] : [scriptPath];

  try {
    const stdout = execFileSync(command, args, {
      cwd: input.cwd || process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify(input),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        HOOKS_CONFIG_PATH: CONFIG_PATH,
      },
    });
    const parsed = lastJsonLine(stdout);
    const reason = blockReason(parsed);
    if (reason) return { ok: false, reason, step: step.id, parsed };
    return { ok: true, step: step.id, parsed };
  } catch (error) {
    const stdout = error.stdout?.toString?.() || '';
    const stderr = error.stderr?.toString?.() || '';
    const parsed = lastJsonLine(stdout);
    const reason = blockReason(parsed);
    if (reason) return { ok: false, reason, step: step.id, parsed };
    return {
      ok: false,
      reason:
        `stop-completion-chain: ${step.id} failed (${error.status ?? 'error'}): ` +
        [stderr, stdout, error.message].filter(Boolean).join('\n').trim(),
      step: step.id,
    };
  }
}

const COMPLETION_GATES = new Set(['quality-completion-gate', 'agent-diff-completion-gate']);

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Flatten a manifest repo entry into [{id, command, classes}] for selectGates. */
export function buildQualityCommands(repoEntry) {
  if (!repoEntry || typeof repoEntry !== 'object') return [];
  const repoName = repoEntry.name || 'repo';
  const domains = repoEntry.domains && typeof repoEntry.domains === 'object' ? repoEntry.domains : {};
  const out = [];
  for (const domain of Object.values(domains)) {
    for (const command of (domain && Array.isArray(domain.commands) ? domain.commands : [])) {
      const id = command.id || `${repoName}.${slug(command.label || command.command)}`;
      const classes = Array.isArray(command.classes) && command.classes.length
        ? command.classes
        : classifyCommand(command);
      out.push({ id, command: command.command, classes });
    }
  }
  return out;
}

export function forbiddenClassesFromDirectives(directives) {
  const set = new Set();
  for (const directive of directives || []) {
    if (directive.kind === 'browser-verification') set.add('browser');
    if (directive.kind === 'full-suite') set.add('full-suite');
  }
  return [...set];
}

function policyStatusLine(decisionGates, extra) {
  const parts = decisionGates.map((gate) => {
    const short = gate.gate === 'quality-completion-gate' ? 'quality' : 'browser';
    return `${short}=${gate.selection}`;
  });
  if (extra) parts.push(extra);
  return `Stop policy: ${parts.join(', ') || 'no gates'}`;
}

/** Non-overridable integrity audit. Returns a block reason string, or null. */
function runIntegrityAudit(shared, sessionId) {
  try {
    const hooksDb = shared.paths?.hooksDb || 'E:/hooks/_db/hooks.db';
    const fraud = detectFraudulentVerificationInTelemetry(hooksDb, sessionId, 0);
    if (fraud && fraud.fraudulent) {
      const detail = (fraud.matches || []).map((m) => `- ${m.detail || m.target || m.tool_name}`).join('\n');
      return `Stop policy: verification-integrity fraud detected (non-overridable):\n${detail}`;
    }
  } catch {
    // integrity audit must never crash the chain; absence of telemetry is not fraud
  }
  return null;
}

/** Sanitized, bounded, non-imperative excerpt of an executor failure reason. */
export function sanitizeFailureDetail(reason, maxChars = 800) {
  let text = redactSecrets(String(reason || '')).trim();
  // Drop imperative remediation lines so the chain stays report-only in tone.
  text = text
    .split(/\r?\n/)
    .filter((line) => !/\b(?:re-?run|fix|remediate|load (?:the )?skill|use waza|you should|please run)\b/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}…`;
  return text;
}

/** Neutral, factual failure summary: gate + command ids + sanitized detail. */
export function failureSummary(gate, reason) {
  const ids = gate.commandIds && gate.commandIds.length ? ` (commands: ${gate.commandIds.join(', ')})` : '';
  const detail = sanitizeFailureDetail(reason);
  return `${gate.gate} failed for task-relevant changes${ids}.${detail ? `\n${detail}` : ''}`;
}

/**
 * Policy-driven Stop authority: load the Active Task Envelope, run the
 * non-overridable integrity audit, compute task-relative changes, select gates,
 * run only selected executors with policy context, own block/report-only
 * disposition, suppress unchanged blockers, and record a bounded decision.
 */
export function evaluate(input) {
  const config = loadConfig();
  const chain = configuredChain(config);
  if (!chain.length) return { continue: true };

  const settings = stopChainSettings(config);
  const stepTimeoutMs = positiveInteger(settings.stepTimeoutMs) ? settings.stepTimeoutMs : DEFAULT_STEP_TIMEOUT_MS;
  const shared = config.shared && typeof config.shared === 'object' ? config.shared : {};
  const gitTimeout = shared.runtime?.gitTimeoutMs || 5000;
  const tpConfig = taskPolicyConfig(shared);
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || input.sessionId || '';
  const messages = [];

  // 1. Memory harvester — always-eligible fail-open pre-step.
  const memoryStep = chain.find((step) => step.id === 'memory-harvester');
  if (memoryStep) {
    const result = runStep(memoryStep, input, stepTimeoutMs);
    if (!result.ok) messages.push(`memory-harvester pre-step failed open: ${result.reason}`);
  }

  const rootResult = gitRoot(cwd, gitTimeout);
  const repoRoot = rootResult.ok ? rootResult.value : String(cwd).replaceAll('\\', '/');

  // 2. Non-overridable verification-integrity audit (telemetry). Fraud blocks
  //    even when a verifier is skipped; user directives cannot suppress it.
  const integrityBlock = runIntegrityAudit(shared, sessionId);
  if (integrityBlock) return { decision: 'block', reason: integrityBlock };

  // 3. Load the Active Task Envelope. Missing/stale → conservative no-heavy-gate.
  const env = readEnvelope(tpConfig, sessionId, repoRoot);
  if (!env.ok) {
    const status = `Stop policy: no heavy verification performed (task policy state ${env.reason}); verification was NOT run.`;
    return { continue: true, systemMessage: [status, ...messages].filter(Boolean).join('\n\n') };
  }
  const envelope = env.envelope;

  // 4. Task-relative change set.
  const delta = taskRelativeChanges(repoRoot, envelope.baseline, gitTimeout);

  // 5. Candidate quality commands from the manifest (ids/classes inferred when absent).
  let qualityCommands = [];
  try {
    const manifest = loadVerifyManifest({ settings: {}, shared });
    const repoEntry = manifest.data ? repoEntryForRoot(manifest.data, repoRoot) : null;
    qualityCommands = buildQualityCommands(repoEntry);
  } catch {
    qualityCommands = [];
  }

  // 6. Select gates and dispositions.
  const gates = selectGates({ envelope, delta, qualityCommands, config: tpConfig });
  const forbiddenClasses = forbiddenClassesFromDirectives(envelope.userDirectives);

  // 7. Run selected executors; the chain owns disposition.
  const decisionGates = [];
  let blockMessage = null;
  for (const gate of gates) {
    if (!COMPLETION_GATES.has(gate.gate)) continue;
    const step = chain.find((s) => s.id === gate.gate);
    if (!step) {
      decisionGates.push({ ...gate, reasonCodes: [...gate.reasonCodes, 'not-wired'], selection: 'skip' });
      continue;
    }
    if (gate.selection === 'skip') {
      decisionGates.push({ ...gate });
      continue;
    }

    const fp = failureFingerprint(gate.gate, gate.commandIds, delta.fingerprint);

    // Unchanged-blocker suppression: do not re-run a known blocker on continuation.
    const prior = unchangedFailure(tpConfig, sessionId, repoRoot, gate.gate, fp);
    if (prior.seen) {
      messages.push(`Stop policy: ${gate.gate} unchanged blocker reported without rerun.`);
      const blocking = gate.failureDisposition === 'block';
      decisionGates.push({ ...gate, blocking, failureFingerprint: fp, reasonCodes: [...gate.reasonCodes, 'unchanged-suppressed'] });
      if (blocking && !blockMessage) {
        blockMessage = `${HARD_NON_REDIRECT}\n${gate.gate} previously failed on unchanged input and was not rerun. Resolve it or change the task.`;
      }
      continue;
    }

    const policyInput = {
      ...input,
      taskPolicy: {
        decisionId: envelope.taskId,
        gate: gate.gate,
        taskChangedFiles: delta.changedFiles,
        forbiddenClasses,
        commandIds: gate.commandIds,
        selectedRoutes: envelope.selectedRoutes || [],
        failureDisposition: gate.failureDisposition,
      },
    };
    const result = runStep(step, policyInput, stepTimeoutMs);
    const failed = !result.ok;
    const record = { ...gate, blocking: false, failureFingerprint: failed ? fp : '' };
    if (failed) {
      if (gate.failureDisposition === 'block') {
        record.blocking = true;
        if (!blockMessage) blockMessage = `${HARD_NON_REDIRECT}\n${failureSummary(gate, result.reason)}`;
      } else {
        messages.push(`${STOP_REPORT_ONLY_PREFIX}\n${HARD_NON_REDIRECT}\n${failureSummary(gate, result.reason)}`);
      }
    }
    decisionGates.push(record);
  }

  // 8. Record the bounded decision.
  try {
    appendDecision(tpConfig, sessionId, repoRoot, buildDecision({ taskId: envelope.taskId, repoRoot, delta, gates: decisionGates }));
  } catch {
    // decision logging is best-effort; never block completion on a log write
  }

  // 9. Status + disposition.
  const status = policyStatusLine(decisionGates, delta.uncertain ? 'policy-uncertain' : '');
  if (blockMessage) {
    return { decision: 'block', reason: [status, blockMessage].filter(Boolean).join('\n\n') };
  }
  return { continue: true, systemMessage: [status, ...messages].filter(Boolean).join('\n\n') };
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain() && process.argv.includes('--self-test')) {
  const chain = configuredChain(loadConfig());
  writeJson({
    continue: true,
    systemMessage: `stop-completion-chain self-test: ${chain.length} enabled gate(s) — ${chain.map((step) => step.id).join(' → ') || 'none'}`,
  });
  process.exit(0);
}

if (isMain()) {
  try {
    writeJson(evaluate(readStdin()));
  } catch (error) {
    writeJson({ continue: true, systemMessage: `stop-completion-chain skipped: ${error.message}` });
  }
}
