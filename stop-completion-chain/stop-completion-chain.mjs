#!/usr/bin/env node
/**
 * Canonical Stop chain for Codex + Claude Code.
 * Runs enabled completion gates in order and blocks on the first failure.
 */
import { execFileSync } from 'node:child_process';
import { STOP_REPORT_ONLY_PREFIX, stopFailureResponse } from '../quality-completion-gate/quality-gate-core.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || join(HOOKS_ROOT, 'config.json');
const DEFAULT_STEP_TIMEOUT_MS = 180000;

const DEFAULT_CHAIN = [
  { id: 'quality-completion-gate', script: 'quality-completion-gate/quality-completion-gate.mjs', runtime: 'node' },
  { id: 'agent-diff-completion-gate', script: 'agent-diff-completion-gate/agent-diff-completion-gate.mjs', runtime: 'node' },
];

const PRE_CHAIN = [
  { id: 'memory-harvester', script: 'memory-harvester/harvest-stop.py', runtime: 'python' },
];

function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { hooks: [] };
  }
}

function enabledPreChain(config) {
  const byId = new Map((config.hooks || []).filter((hook) => hook && hook.id).map((hook) => [hook.id, hook]));
  return PRE_CHAIN.filter((step) => {
    const hook = byId.get(step.id);
    return hook ? hook.enabled !== false : false;
  }).map((step) => {
    const hook = byId.get(step.id);
    return hook?.script?.path ? { ...step, script: hook.script.path } : step;
  });
}

function enabledChain(config) {
  const byId = new Map((config.hooks || []).filter((hook) => hook && hook.id).map((hook) => [hook.id, hook]));
  return DEFAULT_CHAIN.filter((step) => {
    const hook = byId.get(step.id);
    return hook ? hook.enabled !== false : false;
  });
}

function stopChainSettings(config) {
  const script = (config.scripts || []).find((entry) => entry?.id === 'stop-completion-chain');
  return script?.settings && typeof script.settings === 'object' ? script.settings : {};
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function lastJsonLine(stdout) {
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

function blockReason(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.decision === 'block') return parsed.reason || parsed.systemMessage || 'Stop gate blocked completion.';
  if (parsed.continue === false) return parsed.reason || parsed.systemMessage || 'Stop gate blocked completion.';
  return null;
}

function runStep(step, input, timeoutMs) {
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

function runPreChain(input, config, timeoutMs) {
  const preChain = enabledPreChain(config);
  const messages = [];
  for (const step of preChain) {
    const result = runStep(step, input, timeoutMs);
    if (result.parsed?.systemMessage) messages.push(result.parsed.systemMessage);
    if (!result.ok) {
      messages.push(`memory-harvester pre-step failed open: ${result.reason}`);
    }
  }
  return messages;
}

function evaluate(input) {
  const config = loadConfig();
  const preMessages = runPreChain(input, config, positiveInteger(stopChainSettings(config).stepTimeoutMs)
    ? stopChainSettings(config).stepTimeoutMs
    : DEFAULT_STEP_TIMEOUT_MS);
  const chain = enabledChain(config);
  if (!chain.length) {
    if (preMessages.length) return { continue: true, systemMessage: preMessages.join('\n\n') };
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
      return stopFailureResponse(settings, result.reason);
    }
    if (result.parsed?.systemMessage) messages.push(result.parsed.systemMessage);
  }

  if (messages.length) {
    return { continue: true, systemMessage: [...preMessages, ...messages].filter(Boolean).join('\n\n') };
  }
  if (preMessages.length) {
    return { continue: true, systemMessage: preMessages.join('\n\n') };
  }
  return { continue: true };
}

if (process.argv.includes('--self-test')) {
  const chain = enabledChain(loadConfig());
  writeJson({
    continue: true,
    systemMessage: `stop-completion-chain self-test: ${chain.length} enabled gate(s) — ${chain.map((step) => step.id).join(' → ') || 'none'}`,
  });
  process.exit(0);
}

try {
  writeJson(evaluate(readStdin()));
} catch (error) {
  writeJson({ continue: true, systemMessage: `stop-completion-chain skipped: ${error.message}` });
}
