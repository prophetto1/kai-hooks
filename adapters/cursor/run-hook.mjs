#!/usr/bin/env node
/**
 * Cursor Composer adapter for E:/hooks scripts (Claude Code / Codex JSON contract).
 *
 * Usage:
 *   node run-hook.mjs <cursorEvent> <scriptPath> [scriptArgs...]
 *
 * cursorEvent: beforeSubmitPrompt | preToolUse | postToolUse | postToolUseFailure | stop
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_ROOT = resolve(HERE, '..', '..');
const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || 'E:/hooks/config.json';

const EVENT_TO_CLAUDE = {
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  stop: 'Stop',
};

const TOOL_ALIASES = {
  'MCP:sequentialthinking': 'mcp__mcp-router__sequentialthinking',
  Shell: 'Bash',
};

const CANONICAL_SEQUENTIAL_THINKING_TOOL = 'mcp__mcp-router__sequentialthinking';

function looksLikeSequentialThinking(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes('sequentialthinking');
}

function cursorMcpToolName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return toolInput.toolName || toolInput.tool || toolInput.name || '';
}

function normalizeToolName(toolName, toolInput) {
  if (!toolName) return toolName;
  if (toolName === 'CallMcpTool' && looksLikeSequentialThinking(cursorMcpToolName(toolInput))) {
    return CANONICAL_SEQUENTIAL_THINKING_TOOL;
  }
  return TOOL_ALIASES[toolName] || toolName;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(raw) {
  const trimmed = (raw || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

function normalizeInput(input, cursorEvent) {
  const out = { ...input };
  out.hook_event_name = out.hook_event_name || EVENT_TO_CLAUDE[cursorEvent] || cursorEvent;
  out.session_id = out.session_id || out.conversation_id || process.env.CURSOR_SESSION_ID || '';
  out.cwd = out.cwd || process.env.CURSOR_PROJECT_DIR || process.cwd();
  out.transcript_path = out.transcript_path || out.transcriptPath || process.env.CURSOR_TRANSCRIPT_PATH || '';

  out.tool_name = normalizeToolName(out.tool_name, out.tool_input);

  if (cursorEvent === 'postToolUse' || cursorEvent === 'postToolUseFailure') {
    if (out.tool_output != null && out.tool_response == null) {
      out.tool_response = out.tool_output;
    }
    if (cursorEvent === 'postToolUseFailure' && out.error_message && !out.tool_response) {
      out.tool_response = out.error_message;
    }
  }

  if (cursorEvent === 'beforeSubmitPrompt' && out.prompt && !out.user_prompt) {
    out.user_prompt = out.prompt;
  }

  if (cursorEvent === 'stop') {
    out.stop_hook_active = out.stop_hook_active ?? out.loop_count > 0;
  }

  return out;
}

function translatePreToolUseOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const hso = parsed.hookSpecificOutput;
  if (!hso || hso.hookEventName !== 'PreToolUse') return parsed;

  if (hso.permissionDecision === 'deny') {
    const reason = hso.permissionDecisionReason || parsed.systemMessage || 'Denied by hook';
    return {
      permission: 'deny',
      user_message: reason,
      agent_message: reason,
    };
  }

  if (hso.additionalContext) {
    return {
      permission: 'allow',
      agent_message: hso.additionalContext,
    };
  }

  return parsed;
}

function translateBeforeSubmitPromptOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const hso = parsed.hookSpecificOutput;
  const context = hso?.additionalContext;
  if (context) {
    return {
      continue: true,
      additional_context: context,
      hookSpecificOutput: hso,
    };
  }
  if (parsed.continue === false) {
    return {
      continue: false,
      user_message: parsed.user_message || 'Prompt blocked by hook',
    };
  }
  return parsed.continue == null ? { continue: true, ...parsed } : parsed;
}

function translateStopOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.decision === 'block') {
    const message = parsed.reason || parsed.systemMessage || 'Stop hook requested follow-up work.';
    return { followup_message: message };
  }
  if (parsed.followup_message) return parsed;
  if (parsed.continue === false && (parsed.reason || parsed.systemMessage)) {
    return { followup_message: parsed.reason || parsed.systemMessage };
  }
  return {};
}

function translateOutput(cursorEvent, stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return '';

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  switch (cursorEvent) {
    case 'preToolUse':
      return JSON.stringify(translatePreToolUseOutput(parsed));
    case 'beforeSubmitPrompt':
      return JSON.stringify(translateBeforeSubmitPromptOutput(parsed));
    case 'stop':
      return JSON.stringify(translateStopOutput(parsed));
    default:
      return trimmed;
  }
}

function runtimeForScript(scriptPath) {
  const ext = extname(scriptPath).toLowerCase();
  if (ext === '.py') {
    return { cmd: process.env.HOOKS_PYTHON || 'python', prefixArgs: [] };
  }
  if (ext === '.mjs' || ext === '.js') {
    return { cmd: process.env.HOOKS_NODE || 'node', prefixArgs: [] };
  }
  return { cmd: scriptPath, prefixArgs: [], direct: true };
}

function main() {
  const [, , cursorEvent, scriptArg, ...scriptArgs] = process.argv;
  if (!cursorEvent || !scriptArg) {
    console.error('usage: node run-hook.mjs <cursorEvent> <scriptPath> [args...]');
    process.exit(0);
  }

  const scriptPath = resolve(
    scriptArg.includes(':') || scriptArg.startsWith('/')
      ? scriptArg
      : resolve(HOOKS_ROOT, scriptArg),
  );

  if (!existsSync(scriptPath)) {
    console.error(`[cursor-adapter] missing script: ${scriptPath}`);
    process.exit(0);
  }

  const payload = normalizeInput(parseJson(readStdin()), cursorEvent);
  const runtime = runtimeForScript(scriptPath);
  const command = runtime.direct ? scriptPath : runtime.cmd;
  const args = runtime.direct
    ? scriptArgs
    : [...runtime.prefixArgs, scriptPath, ...scriptArgs];

  const result = spawnSync(command, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOOKS_CONFIG_PATH: CONFIG_PATH,
      CURSOR_HOOK_EVENT: cursorEvent,
    },
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[cursor-adapter] spawn failed: ${result.error.message}`);
    process.exit(0);
  }

  const stdout = (result.stdout || '').trim();
  if (stdout) {
    process.stdout.write(`${translateOutput(cursorEvent, stdout)}\n`);
  }

  if (cursorEvent === 'preToolUse' && result.status === 2) {
    process.stdout.write(JSON.stringify({
      permission: 'deny',
      user_message: (result.stderr || '').trim() || 'Hook exited with deny code',
      agent_message: (result.stderr || '').trim() || 'Hook exited with deny code',
    }));
  }

  process.exit(0);
}

main();
