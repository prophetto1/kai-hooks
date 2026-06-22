#!/usr/bin/env node
/**
 * PreToolUse: require mode-appropriate planning checkpoint before mutating tools.
 */
import { hookRuntime, readJsonStdin, writeJson } from '../quality-completion-gate/quality-gate-core.mjs';
import {
  MODE_REQUIRED_SKILLS,
  isMutatingTool,
  readState,
  repoRootForCwd,
  skillCheckpoint,
  writeState,
} from './task-mode-core.mjs';
import { readEnvelope, taskPolicyConfig, writeEnvelope } from '../task-policy/task-policy-core.mjs';

/** Mirror the planning checkpoint onto the Active Task Envelope. Fail-open. */
function markEnvelopeCheckpoint(runtime, sessionId, repoRoot) {
  try {
    const config = taskPolicyConfig(runtime.shared);
    const { ok, envelope } = readEnvelope(config, sessionId, repoRoot);
    if (ok && envelope && envelope.checkpointDone !== true) {
      writeEnvelope(config, sessionId, repoRoot, { ...envelope, checkpointDone: true });
    }
  } catch {
    // fail open — legacy task-mode checkpoint state remains authoritative
  }
}

function deny(toolName, mode, required) {
  const reason =
    `planning-start-gate: '${toolName}' blocked — task mode '${mode}' requires a planning checkpoint before mutating code.\n\n` +
    `Load and follow ONE of: ${required.map((s) => `\`${s}\``).join(', ')}\n` +
    'Or call sequential-thinking MCP once.\n\n' +
    'Set mode explicitly: `mode: implement` | `fix` | `refactor` | `review` | `explore` | `docs`\n' +
    'Skill catalog: E:/hooks/skills-catalog.md';
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
  const repoRoot = repoRootForCwd(cwd, runtime.shared?.runtime?.gitTimeoutMs);

  if (!sessionId || !toolName || !isMutatingTool(toolName)) {
    return { continue: true };
  }

  const settings = runtime.settings || {};
  const state = readState(settings, sessionId, repoRoot);
  const mode = state.mode || 'explore';
  const required = MODE_REQUIRED_SKILLS[mode] || [];

  if (!required.length) {
    return { continue: true };
  }

  const sinceId = Number(state.telemetryWatermark || 0);
  if (skillCheckpoint(sessionId, sinceId, runtime, mode)) {
    writeState(settings, sessionId, repoRoot, { ...state, checkpointDone: true });
    markEnvelopeCheckpoint(runtime, sessionId, repoRoot);
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
