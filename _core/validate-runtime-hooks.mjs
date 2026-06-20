#!/usr/bin/env node
// Validates the E:/hooks runtime control-plane files without external packages.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generateConfigSchema, validateConfig } from './config-model.mjs';

const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || 'E:/hooks/config.json';
const SCHEMA_PATH = 'E:/hooks/config.schema.json';
const DIRECT_CURSOR_STOP_GATE_RE =
  /run-hook\.mjs\s+stop\s+E:\/hooks\/(?:quality-completion-gate\/quality-completion-gate\.mjs|agent-diff-completion-gate\/agent-diff-completion-gate\.mjs)/i;
const CURSOR_STOP_CHAIN_RE =
  /run-hook\.mjs\s+stop\s+E:\/hooks\/stop-completion-chain\/stop-completion-chain\.mjs/i;
const MANAGED_HOOKS_STOP_RE = /E:\/hooks\//i;
const DIRECT_CODEX_STOP_GATE_RE =
  /(?:^|\s)E:\/hooks\/(?:quality-completion-gate\/quality-completion-gate\.mjs|agent-diff-completion-gate\/agent-diff-completion-gate\.mjs)/i;
const CODEX_STOP_CHAIN_RE =
  /(?:^|\s)E:\/hooks\/stop-completion-chain\/stop-completion-chain\.mjs/i;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function warningsForPaths(config) {
  const warnings = [];
  const hooksDir = config.shared?.paths?.hooksDir;
  if (typeof hooksDir !== 'string' || !existsSync(hooksDir)) {
    return { warnings, errors: ['shared.paths.hooksDir missing on disk'] };
  }

  const errors = [];
  for (const hook of config.hooks || []) {
    if (!hook.script?.path) continue;
    const path = join(hooksDir, hook.script.path);
    if (existsSync(path)) continue;
    const message = `hook script missing: ${path}`;
    if (hook.enabled === false) warnings.push(`${message} (disabled hook)`);
    else errors.push(message);
  }

  for (const script of config.scripts || []) {
    if (!script.script?.path) continue;
    const path = join(hooksDir, script.script.path);
    if (existsSync(path)) continue;
    const message = `script missing: ${path}`;
    if (script.enabled === false) warnings.push(`${message} (disabled script)`);
    else errors.push(message);
  }

  const protocolFile = (config.hooks || [])
    .find((hook) => hook?.id === 'inject-protocol')
    ?.settings?.sources?.protocol?.file;
  if (protocolFile) {
    const injectDir = dirname(join(hooksDir, 'inject-protocol/inject-protocol.mjs'));
    add(errors, existsSync(join(injectDir, protocolFile)), `protocol file missing: ${join(injectDir, protocolFile)}`);
  }

  return { warnings, errors };
}

function validateSkillIndexerRoots(config) {
  const errors = [];
  const warnings = [];
  const warehouse = config.shared?.paths?.skillsWarehouse;
  if (typeof warehouse === 'string' && warehouse.length > 0 && !existsSync(warehouse)) {
    errors.push(`shared.paths.skillsWarehouse missing on disk: ${warehouse}`);
  }

  const script = (config.scripts || []).find((entry) => entry?.id === 'skill-indexer');
  const roots = script?.settings?.scanRoots;
  if (!Array.isArray(roots) || !roots.length) {
    return { warnings, errors };
  }

  let existingCount = 0;
  for (const root of roots) {
    const path = root?.path;
    if (typeof path !== 'string' || !path.length) continue;
    if (existsSync(path)) {
      existingCount += 1;
    } else {
      warnings.push(`skill-indexer scanRoot missing on disk: ${path}`);
    }
  }
  if (script?.enabled !== false && existingCount === 0) {
    errors.push('skill-indexer has no existing scanRoots on disk');
  }
  return { warnings, errors };
}

function cursorHookPaths(config) {
  const hooksDir = config.shared?.paths?.hooksDir || 'E:/hooks';
  const paths = [
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cursor/hooks.json') : null,
    join(hooksDir, 'examples/cursor/hooks.fragment.json'),
    join(hooksDir, 'examples/cursor/hooks.full-stack.fragment.json'),
    join(hooksDir, 'examples/cursor/hooks.per-gate.fragment.json'),
  ].filter(Boolean);

  for (const project of config.shared?.projects || []) {
    if (typeof project?.repoPath !== 'string') continue;
    paths.push(join(project.repoPath, '.cursor/hooks.json'));
  }

  return [...new Set(paths)];
}

function cursorStopCommands(cursorHooks) {
  const stopHooks = cursorHooks?.hooks?.stop;
  if (!Array.isArray(stopHooks)) return [];
  return stopHooks
    .map((entry) => entry?.command)
    .filter((command) => typeof command === 'string' && command.length > 0);
}

function validateCursorStopWiring(config) {
  const errors = [];
  const managedByPath = new Map();

  for (const path of cursorHookPaths(config)) {
    if (!existsSync(path)) continue;
    let cursorHooks;
    try {
      cursorHooks = readJson(path);
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
      continue;
    }

    const stopCommands = cursorStopCommands(cursorHooks);
    const managedStopCommands = stopCommands.filter((command) => MANAGED_HOOKS_STOP_RE.test(command));
    managedByPath.set(path, managedStopCommands);
    if (!managedStopCommands.length) continue;

    for (const command of managedStopCommands) {
      add(
        errors,
        !DIRECT_CURSOR_STOP_GATE_RE.test(command),
        `${path}: Cursor Stop must use stop-completion-chain, not direct per-gate command: ${command}`,
      );
    }

    add(
      errors,
      managedStopCommands.length === 1 && CURSOR_STOP_CHAIN_RE.test(managedStopCommands[0]),
      `${path}: E:/hooks-managed Cursor Stop must contain exactly one stop-completion-chain command`,
    );
  }

  const userPath = process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cursor/hooks.json') : null;
  const userManagedStops = userPath ? managedByPath.get(userPath) || [] : [];
  if (userManagedStops.length) {
    for (const project of config.shared?.projects || []) {
      if (typeof project?.repoPath !== 'string') continue;
      const projectPath = join(project.repoPath, '.cursor/hooks.json');
      const projectManagedStops = managedByPath.get(projectPath) || [];
      add(
        errors,
        projectManagedStops.length === 0,
        `${projectPath}: Cursor combines user and project hooks; remove project Stop when user Stop is wired`,
      );
    }
  }

  return errors;
}

function codexHookPaths(config) {
  const hooksDir = config.shared?.paths?.hooksDir || 'E:/hooks';
  return [
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex/config.toml') : null,
    join(hooksDir, 'examples/codex/stop-hooks.fragment.toml'),
  ].filter(Boolean);
}

function parseCodexStopHookEntries(source) {
  const entries = [];
  let inStop = false;
  let current = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[\[hooks\.Stop\]\]$/.test(line)) {
      inStop = true;
      current = null;
      continue;
    }
    if (/^\[\[hooks\.[^\]]+\]\]$/.test(line) && !/^\[\[hooks\.Stop\]\]$/.test(line)) {
      inStop = false;
      current = null;
      continue;
    }
    if (!inStop) continue;
    if (/^\[\[hooks\.Stop\.hooks\]\]$/.test(line)) {
      current = {};
      entries.push(current);
      continue;
    }
    if (!current) continue;

    const commandMatch = line.match(/^command\s*=\s*"([^"]+)"/);
    if (commandMatch) {
      current.command = commandMatch[1];
      continue;
    }
    const timeoutMatch = line.match(/^timeout\s*=\s*(\d+)/);
    if (timeoutMatch) {
      current.timeout = Number(timeoutMatch[1]);
    }
  }

  return entries;
}

function validateCodexStopWiring(config) {
  const errors = [];
  const stepTimeoutMs = (config.scripts || [])
    .find((script) => script?.id === 'stop-completion-chain')
    ?.settings?.stepTimeoutMs;
  const minimumTimeoutSeconds =
    typeof stepTimeoutMs === 'number' && Number.isFinite(stepTimeoutMs)
      ? Math.ceil(stepTimeoutMs / 1000) + 60
      : 360;

  for (const path of codexHookPaths(config)) {
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    const entries = parseCodexStopHookEntries(source);
    const managedEntries = entries.filter((entry) => MANAGED_HOOKS_STOP_RE.test(entry.command || ''));
    if (!managedEntries.length) continue;

    for (const entry of managedEntries) {
      add(
        errors,
        !DIRECT_CODEX_STOP_GATE_RE.test(entry.command || ''),
        `${path}: Codex Stop must use stop-completion-chain, not direct per-gate command: ${entry.command}`,
      );
    }

    add(
      errors,
      managedEntries.length === 1 && CODEX_STOP_CHAIN_RE.test(managedEntries[0].command || ''),
      `${path}: E:/hooks-managed Codex Stop must contain exactly one stop-completion-chain command`,
    );
    add(
      errors,
      Number(managedEntries[0]?.timeout) >= minimumTimeoutSeconds,
      `${path}: Codex stop-completion-chain timeout must be at least ${minimumTimeoutSeconds}s`,
    );
  }

  return errors;
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

function main() {
  const errors = [];
  const warnings = [];
  const config = readJson(CONFIG_PATH);
  const schema = readJson(SCHEMA_PATH);
  const expectedSchema = generateConfigSchema();

  add(errors, stableStringify(schema) === stableStringify(expectedSchema), 'config.schema.json is not generated from _core/config-model.mjs');
  add(errors, config.$schema === './config.schema.json', 'config.$schema must point to ./config.schema.json');

  const modelResult = validateConfig(config);
  errors.push(...modelResult.errors);

  const pathResult = warningsForPaths(config);
  warnings.push(...pathResult.warnings);
  errors.push(...pathResult.errors);
  const skillRootResult = validateSkillIndexerRoots(config);
  warnings.push(...skillRootResult.warnings);
  errors.push(...skillRootResult.errors);
  errors.push(...validateCursorStopWiring(config));
  errors.push(...validateCodexStopWiring(config));

  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  if (errors.length) {
    console.error(`Runtime hook validation failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }
  console.log('Runtime hook validation passed');
  return 0;
}

process.exitCode = main();
