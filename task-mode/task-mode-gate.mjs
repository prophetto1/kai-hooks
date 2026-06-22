#!/usr/bin/env node
/**
 * UserPromptSubmit: classify task mode and inject required skills for this session.
 */
import { readFileSync } from 'node:fs';
import {
  classifyMode,
  modeInjectionBlock,
  parseExplicitMode,
  repoRootForCwd,
  telemetryHighWatermark,
  writeState,
} from './task-mode-core.mjs';
import { hookRuntime, readJsonStdin, writeJson } from '../quality-completion-gate/quality-gate-core.mjs';
import {
  captureBaseline,
  createOrAmendEnvelope,
  readEnvelope,
  taskPolicyConfig,
  writeEnvelope,
} from '../task-policy/task-policy-core.mjs';

/**
 * Create or amend the Active Task Envelope for this prompt. Fail-open: any
 * error degrades to legacy task-mode behavior and never blocks the prompt.
 */
function updateEnvelope(input, runtime, { sessionId, repoRoot, prompt, mode, telemetryWatermark }) {
  try {
    const config = taskPolicyConfig(runtime.shared);
    const existing = readEnvelope(config, sessionId, repoRoot).envelope;
    const baseline = captureBaseline(repoRoot, runtime.shared?.runtime?.gitTimeoutMs);
    const envelope = createOrAmendEnvelope({
      existing,
      prompt,
      mode,
      sessionId,
      repoRoot,
      config,
      baseline,
      telemetryWatermark,
    });
    writeEnvelope(config, sessionId, repoRoot, envelope);
  } catch {
    // fail open — legacy task-mode state remains the fallback authority
  }
}

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
  const repoRoot = repoRootForCwd(cwd, runtime.shared?.runtime?.gitTimeoutMs);
  const prompt = promptText(input);
  const mode = classifyMode(prompt);
  const explicit = Boolean(parseExplicitMode(prompt));

  const telemetryWatermark = telemetryHighWatermark(sessionId, runtime);
  writeState(runtime.settings || {}, sessionId, repoRoot, {
    mode,
    explicit,
    promptSnippet: String(prompt).slice(0, 240),
    classifiedAt: new Date().toISOString(),
    telemetryWatermark,
    checkpointDone: false,
  });

  updateEnvelope(input, runtime, { sessionId, repoRoot, prompt, mode, telemetryWatermark });

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
