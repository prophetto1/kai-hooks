#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || join(HOOKS_ROOT, 'config.json');
const VALID_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'PreCompact',
  'PostCompact',
]);

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function hookEvents(entry) {
  const event = entry?.event;
  return Array.isArray(event) ? event : [event].filter(Boolean);
}

export function samplePayload(event, overrides = {}) {
  const common = {
    session_id: 'hook-dev-test-session',
    transcript_path: join(HOOKS_ROOT, '.state', 'hook-dev-test-transcript.jsonl').replaceAll('\\', '/'),
    cwd: HOOKS_ROOT.replaceAll('\\', '/'),
    permission_mode: 'ask',
    hook_event_name: event,
  };

  const byEvent = {
    SessionStart: {},
    UserPromptSubmit: {
      user_prompt: 'mode: explore\nExplain the hook system.',
    },
    PreToolUse: {
      tool_name: 'Write',
      tool_input: {
        file_path: join(HOOKS_ROOT, 'tmp-hook-test.txt').replaceAll('\\', '/'),
        content: 'sample content',
      },
    },
    PermissionRequest: {
      tool_name: 'Write',
      tool_input: {
        file_path: join(HOOKS_ROOT, 'tmp-hook-test.txt').replaceAll('\\', '/'),
      },
    },
    PostToolUse: {
      tool_name: 'Read',
      tool_input: { file_path: join(HOOKS_ROOT, 'README.md').replaceAll('\\', '/') },
      tool_result: { content: 'sample result' },
    },
    PostToolUseFailure: {
      tool_name: 'Read',
      tool_input: { file_path: join(HOOKS_ROOT, 'missing.txt').replaceAll('\\', '/') },
      tool_result: { error: 'sample failure' },
    },
    Stop: {
      reason: 'sample stop check',
    },
    PreCompact: {
      reason: 'sample compact check',
    },
    PostCompact: {
      reason: 'sample compact complete',
    },
  };

  if (!VALID_EVENTS.has(event)) {
    throw new Error(`Unknown hook event: ${event}`);
  }
  return { ...common, ...(byEvent[event] || {}), ...overrides };
}

export function scriptAbsolutePath(config, entry) {
  const hooksDir = config.shared?.paths?.hooksDir || HOOKS_ROOT;
  return resolve(hooksDir, entry.script.path);
}

export function commandForEntry(config, entry) {
  const scriptPath = scriptAbsolutePath(config, entry);
  const runtime = entry.script?.runtime;
  if (runtime === 'python') {
    return { command: config.shared?.paths?.python || process.env.HOOKS_PYTHON || 'python', args: [scriptPath] };
  }
  if (runtime === 'node') {
    return { command: process.env.HOOKS_NODE || process.execPath, args: [scriptPath] };
  }
  throw new Error(`${entry.id}: unsupported runtime ${runtime}`);
}

export function validateHookOutput(event, raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch (error) {
    return { ok: false, reason: `output is not JSON: ${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'output JSON must be an object' };
  }

  if (event === 'PreToolUse' || event === 'PermissionRequest') {
    const decision = parsed.hookSpecificOutput?.permissionDecision;
    if (decision !== undefined && !['allow', 'deny', 'ask'].includes(decision)) {
      return { ok: false, reason: `invalid permissionDecision: ${decision}` };
    }
  }
  if (event === 'Stop' || event === 'SubagentStop') {
    const decision = parsed.decision;
    if (decision !== undefined && !['approve', 'block'].includes(decision)) {
      return { ok: false, reason: `invalid stop decision: ${decision}` };
    }
  }
  if (parsed.continue !== undefined && typeof parsed.continue !== 'boolean') {
    return { ok: false, reason: 'continue must be boolean when present' };
  }
  return { ok: true, parsed };
}

export function lintConfig(config) {
  const errors = [];
  const warnings = [];
  const hooksDir = config.shared?.paths?.hooksDir || HOOKS_ROOT;
  const warehouse = config.shared?.paths?.skillsWarehouse;

  if (typeof warehouse === 'string' && warehouse.includes('__skills')) {
    errors.push('shared.paths.skillsWarehouse points at stale __skills path');
  }
  if (typeof warehouse === 'string' && !existsSync(warehouse)) {
    errors.push(`shared.paths.skillsWarehouse missing on disk: ${warehouse}`);
  }

  const skillIndexer = (config.scripts || []).find((entry) => entry?.id === 'skill-indexer');
  const scanRoots = skillIndexer?.settings?.scanRoots || [];
  if (skillIndexer?.enabled !== false && Array.isArray(scanRoots)) {
    const existingRoots = scanRoots.filter((root) => root?.path && existsSync(root.path));
    if (!existingRoots.length) errors.push('skill-indexer has no existing scanRoots');
    for (const root of scanRoots) {
      if (typeof root?.path === 'string' && root.path.includes('__skills')) {
        errors.push(`skill-indexer scanRoot uses stale __skills path: ${root.path}`);
      }
    }
  }

  for (const collectionName of ['hooks', 'scripts']) {
    for (const entry of config[collectionName] || []) {
      if (!entry?.script?.path) continue;
      const path = resolve(hooksDir, entry.script.path);
      if (!existsSync(path)) {
        errors.push(`${collectionName}[id=${entry.id}].script missing on disk: ${path}`);
        continue;
      }
      if (!['node', 'python'].includes(entry.script.runtime)) {
        errors.push(`${collectionName}[id=${entry.id}].script.runtime invalid: ${entry.script.runtime}`);
      }
      if (entry.settings?.stateDir) {
        const source = readFileSync(path, 'utf8');
        if (/const\s+DEFAULT_STATE_DIR\s*=/.test(source) && !source.includes('settings.stateDir')) {
          warnings.push(`${entry.id} declares settings.stateDir but script may not read it`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function runHook(config, hookId, payload, { timeoutMs = 30000 } = {}) {
  const hook = (config.hooks || []).find((entry) => entry?.id === hookId);
  if (!hook) throw new Error(`Hook not found: ${hookId}`);
  const events = hookEvents(hook);
  const event = payload.hook_event_name || events[0];
  const command = commandForEntry(config, hook);
  const result = spawnSync(command.command, command.args, {
    cwd: payload.cwd || config.shared?.paths?.hooksDir || HOOKS_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, HOOKS_CONFIG_PATH: CONFIG_PATH },
    windowsHide: true,
  });
  const contract = validateHookOutput(event, result.stdout.trim() || '{}');
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    contract,
  };
}

function usage() {
  return [
    'Usage:',
    '  node hook-dev-tools/test-hook.mjs --self-test',
    '  node hook-dev-tools/test-hook.mjs --lint',
    '  node hook-dev-tools/test-hook.mjs --create-sample <event>',
    '  node hook-dev-tools/test-hook.mjs --hook <id> [--event <event>] [--dry-run]',
  ].join('\n');
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function main(args) {
  const config = loadConfig();

  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return 0;
  }

  const sampleEvent = argValue(args, '--create-sample');
  if (sampleEvent) {
    console.log(JSON.stringify(samplePayload(sampleEvent), null, 2));
    return 0;
  }

  if (args.includes('--lint') || args.includes('--self-test')) {
    const result = lintConfig(config);
    if (args.includes('--self-test')) {
      for (const event of VALID_EVENTS) {
        const sample = samplePayload(event);
        if (sample.hook_event_name !== event) result.errors.push(`sample mismatch for ${event}`);
      }
      const output = validateHookOutput('PreToolUse', {
        continue: true,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      });
      if (!output.ok) result.errors.push(output.reason);
    }
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length ? 1 : 0;
  }

  const hookId = argValue(args, '--hook');
  if (!hookId) {
    console.log(usage());
    return 0;
  }
  const hook = (config.hooks || []).find((entry) => entry?.id === hookId);
  if (!hook) throw new Error(`Hook not found: ${hookId}`);
  const event = argValue(args, '--event') || hookEvents(hook)[0];
  const payload = samplePayload(event);
  const command = commandForEntry(config, hook);
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ command, payload }, null, 2));
    return 0;
  }
  const result = runHook(config, hookId, payload, {
    timeoutMs: Number(argValue(args, '--timeout-ms') || 30000),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.contract.ok && [0, 2].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
