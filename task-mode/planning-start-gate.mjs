#!/usr/bin/env node
/**
 * PreToolUse: require mode-appropriate planning checkpoint before mutating tools.
 */
import { hookRuntime, readJsonStdin, writeJson } from '../quality-completion-gate/quality-gate-core.mjs';
import {
  MODE_REQUIRED_SKILLS,
  isMutatingTool,
  readState,
  skillCheckpoint,
  writeState,
} from './task-mode-core.mjs';

function deny(toolName, mode, required) {
  const reason =
    `planning-start-gate: '${toolName}' blocked — task mode '${mode}' requires a planning checkpoint before mutating code.\n\n` +
    `Load and follow ONE of: ${required.map((s) => `\`${s}\``).join(', ')}\n` +
    'Or call sequential-thinking MCP once.\n\n' +
    'Set mode explicitly: `mode: implement` | `fix` | `refactor` | `review` | `explore` | `docs`\n' +
    'Map: E:/hooks/_docs/task-mode-and-skills.md';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  };
}

function evaluate(input, runtime) {
  if (!runtime.enabled) return { continue: true };

  const sessionId = input.session_id || input.sessionId || '';
  const toolName = input.tool_name || '';
  const cwd = input.cwd || process.cwd();

  if (!sessionId || !toolName || !isMutatingTool(toolName)) {
    return { continue: true };
  }

  const settings = runtime.settings || {};
  const state = readState(settings, sessionId, cwd);
  const mode = state.mode || 'explore';
  const required = MODE_REQUIRED_SKILLS[mode] || [];

  if (!required.length) {
    return { continue: true };
  }

  const sinceId = Number(state.telemetryWatermark || 0);
  if (skillCheckpoint(sessionId, sinceId, runtime, mode)) {
    writeState(settings, sessionId, cwd, { ...state, checkpointDone: true });
    return { continue: true };
  }

  return deny(toolName, mode, required);
}

if (process.argv.includes('--self-test')) {
  writeJson(
    evaluate(
      { session_id: 'self-test', tool_name: 'Write', cwd: 'E:/kai-chattr' },
      hookRuntime(import.meta.url, { stateDir: 'E:/hooks/.state/task-mode' }),
    ),
  );
  process.exit(0);
}

try {
  writeJson(evaluate(readJsonStdin(), hookRuntime(import.meta.url, { stateDir: 'E:/hooks/.state/task-mode' })));
} catch (error) {
  writeJson({ continue: true, systemMessage: `planning-start-gate skipped: ${error.message}` });
}
