import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

export function shouldRunRiskPhase(input) {
  const forbidden = input?.taskPolicy?.forbiddenClasses;
  return !(Array.isArray(forbidden) && forbidden.includes('browser'));
}

export function shouldRunQualityPhase(input) {
  if (!input?.taskPolicy || !Array.isArray(input.taskPolicy.commandIds)) return true;
  return input.taskPolicy.commandIds.length > 0;
}

export function phaseInput(input, gateId) {
  return {
    ...input,
    taskPolicy: {
      ...(input?.taskPolicy || {}),
      gate: gateId,
    },
  };
}

export function loadConfig(configPath = process.env.HOOKS_CONFIG_PATH || join(HOOKS_ROOT, 'config.json')) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { hooks: [] };
  }
}

export function completionQualitySettings(config) {
  const hook = (config.hooks || []).find((entry) => entry?.id === 'completion-quality-gate');
  return hook?.settings && typeof hook.settings === 'object' ? hook.settings : {};
}

export function runNodePhase(script, input, timeoutMs) {
  const scriptPath = join(HOOKS_ROOT, script);
  if (!existsSync(scriptPath)) {
    return { ok: false, reason: `completion-quality-gate missing phase script: ${scriptPath}` };
  }
  try {
    const stdout = execFileSync(process.env.HOOKS_NODE || 'node', [scriptPath], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = lastJsonLine(stdout);
    const reason = blockReason(parsed);
    if (reason) return { ok: false, reason, parsed, stdout };
    return { ok: true, parsed, stdout };
  } catch (error) {
    const stdout = error.stdout?.toString?.() || '';
    const stderr = error.stderr?.toString?.() || '';
    const parsed = lastJsonLine(stdout);
    const reason = blockReason(parsed);
    if (reason) return { ok: false, reason, parsed, stdout, stderr };
    return {
      ok: false,
      reason: [stderr, stdout, error.message].filter(Boolean).join('\n').trim() || String(error),
      stdout,
      stderr,
    };
  }
}

export function evaluateCompletionQuality(input, settings = {}) {
  const timeoutMs = Number.isInteger(settings.phaseTimeoutMs) && settings.phaseTimeoutMs > 0
    ? settings.phaseTimeoutMs
    : 300000;
  const qualityScript = settings.qualityScript || 'quality-completion-gate/quality-completion-gate.mjs';
  const riskScript = settings.riskScript || 'agent-diff-completion-gate/agent-diff-completion-gate.mjs';
  const messages = [];

  if (shouldRunQualityPhase(input)) {
    const quality = runNodePhase(qualityScript, phaseInput(input, 'quality-completion-gate'), timeoutMs);
    if (!quality.ok) {
      return {
        decision: 'block',
        reason: `completion-quality-gate quality phase failed.\n${quality.reason}`,
      };
    }
    if (quality.parsed?.systemMessage) {
      messages.push(`quality phase: ${quality.parsed.systemMessage}`);
    }
  } else {
    messages.push('quality phase skipped because task policy selected no quality commands');
  }

  if (!shouldRunRiskPhase(input)) {
    messages.push('risk phase skipped by active browser-verification directive');
    return { continue: true, systemMessage: messages.join('\n') };
  }

  const risk = runNodePhase(riskScript, phaseInput(input, 'agent-diff-completion-gate'), timeoutMs);
  if (!risk.ok) {
    return {
      decision: 'block',
      reason: `completion-quality-gate risk/live-verification phase failed.\n${risk.reason}`,
    };
  }
  if (risk.parsed?.systemMessage) {
    messages.push(`risk phase: ${risk.parsed.systemMessage}`);
  }

  return messages.length ? { continue: true, systemMessage: messages.join('\n') } : { continue: true };
}
