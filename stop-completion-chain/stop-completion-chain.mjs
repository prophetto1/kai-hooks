#!/usr/bin/env node
/**
 * Canonical Stop chain for Codex + Claude Code.
 * Runs enabled completion gates in order and blocks on the first failure.
 */
import { execFileSync } from 'node:child_process';
import { STOP_REPORT_ONLY_PREFIX, stopFailureResponse } from '../quality-completion-gate/quality-gate-core.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function evaluate(input) {
  const config = loadConfig();
  const chain = configuredChain(config);
  if (!chain.length) {
    return { continue: true };
  }
  const settings = stopChainSettings(config);
  const stepTimeoutMs = positiveInteger(settings.stepTimeoutMs)
    ? settings.stepTimeoutMs
    : DEFAULT_STEP_TIMEOUT_MS;

  const messages = [];
  for (const step of chain) {
    const result = runStep(step, input, stepTimeoutMs);
    if (result.parsed?.haltChain === true && result.parsed?.continue === true) {
      return {
        continue: true,
        systemMessage: result.parsed.systemMessage || STOP_REPORT_ONLY_PREFIX,
      };
    }
    if (!result.ok) {
      if (step.failOpenPreStep) {
        messages.push(`memory-harvester pre-step failed open: ${result.reason}`);
        continue;
      }
      return stopFailureResponse(settings, result.reason);
    }
    if (result.parsed?.systemMessage) messages.push(result.parsed.systemMessage);
  }

  if (messages.length) {
    return { continue: true, systemMessage: messages.filter(Boolean).join('\n\n') };
  }
  return { continue: true };
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
