#!/usr/bin/env node
/**
 * Single Stop executor for completion quality.
 *
 * This replaces the old Stop-chain pairing of:
 * - quality-completion-gate
 * - agent-diff-completion-gate
 *
 * The old executors remain as phase implementations, but the Stop chain now has
 * one quality/risk decision point. The shared task-policy changed-file list is
 * passed to both phases, so command selection and risk/live-verification policy
 * are evaluated against the same task-relative diff model.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  completionQualitySettings,
  evaluateCompletionQuality,
  loadConfig,
} from './completion-quality-core.mjs';

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

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

export function evaluate(input) {
  const config = loadConfig();
  return evaluateCompletionQuality(input, completionQualitySettings(config));
}

if (isMain() && process.argv.includes('--self-test')) {
  writeJson({
    continue: true,
    systemMessage: 'completion-quality-gate self-test: phase wrapper loaded',
  });
  process.exit(0);
}

if (isMain()) {
  try {
    writeJson(evaluate(readStdin()));
  } catch (error) {
    writeJson({
      decision: 'block',
      reason: `completion-quality-gate failed closed: ${error.message || error}`,
    });
  }
}
