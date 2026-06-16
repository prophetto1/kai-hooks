#!/usr/bin/env node
/**
 * UserPromptSubmit: classify task mode and inject required skills for this session.
 */
import { readFileSync } from 'node:fs';
import {
  classifyMode,
  modeInjectionBlock,
  parseExplicitMode,
  writeState,
} from './task-mode-core.mjs';
import { hookRuntime, readJsonStdin, writeJson } from '../quality-completion-gate/quality-gate-core.mjs';

function promptText(input) {
  return (
    input.user_prompt ||
    input.prompt ||
    input.message ||
    input.text ||
    ''
  );
}

function evaluate(input, runtime) {
  if (!runtime.enabled) return { continue: true };

  const sessionId = input.session_id || input.sessionId || input.conversation_id || '';
  const cwd = input.cwd || process.cwd();
  const prompt = promptText(input);
  const mode = classifyMode(prompt);
  const explicit = Boolean(parseExplicitMode(prompt));

  writeState(runtime.settings || {}, sessionId, cwd, {
    mode,
    explicit,
    promptSnippet: String(prompt).slice(0, 240),
    classifiedAt: new Date().toISOString(),
    telemetryWatermark: 0,
    checkpointDone: false,
  });

  const additionalContext = modeInjectionBlock(mode);

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
    systemMessage: additionalContext,
  };
}

if (process.argv.includes('--self-test')) {
  writeJson(
    evaluate(
      { user_prompt: 'mode: implement\nAdd appearance editor', session_id: 'self-test', cwd: process.cwd() },
      hookRuntime(import.meta.url, { stateDir: 'E:/hooks/.state/task-mode' }),
    ),
  );
  process.exit(0);
}

try {
  writeJson(evaluate(readJsonStdin(), hookRuntime(import.meta.url, { stateDir: 'E:/hooks/.state/task-mode' })));
} catch (error) {
  writeJson({ continue: true, systemMessage: `task-mode-gate skipped: ${error.message}` });
}
