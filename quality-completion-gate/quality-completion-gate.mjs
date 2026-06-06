#!/usr/bin/env node
// Stop hook: compute changed domains from git, run manifest-declared verification commands, gate on exit codes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  changedFiles,
  commandsForDomains,
  gitRoot,
  hookRuntime,
  loadVerifyManifest,
  normalizeAbsolute,
  readJsonStdin,
  repoEntryForRoot,
  runVerifyCommand,
  touchedDomains,
  writeJson
} from './quality-gate-core.mjs';

const runtime = hookRuntime(import.meta.url);
const DEFAULT_MAX_REPEATED_FAILURE_BLOCKS = 3;
const DEFAULT_TOTAL_BUDGET_MS = 90000;

function formatFailure(result) {
  const output = result.output ? `\n${result.output}` : '';
  return `${result.label} failed (${result.ms}ms): ${result.command}${output}`;
}

function isStopContinuation(input) {
  return input.stop_hook_active === true || String(input.stop_hook_active || '').toLowerCase() === 'true';
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function qualityStateDir(activeRuntime) {
  return process.env.QUALITY_GATE_STATE_DIR ||
    activeRuntime.settings.stateDir ||
    join(activeRuntime.shared.paths.hooksDir || 'E:/hooks', '.state', 'quality-completion-gate');
}

function statePath(activeRuntime, input, repoRoot) {
  const sessionId = input.session_id || input.sessionId || '';
  const key = sessionId ? hash({ sessionId }) : hash({
    repoRoot: repoRoot || '',
    cwd: input.cwd || process.cwd()
  });
  return join(qualityStateDir(activeRuntime), `${key}.json`);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function clearState(activeRuntime, input, repoRoot) {
  const path = statePath(activeRuntime, input, repoRoot);
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // State cleanup must not make a passing Stop fail.
  }
}

function knownRepoForCwd(manifestData, cwd) {
  const repos = Array.isArray(manifestData?.repos) ? manifestData.repos : [];
  const normalizedCwd = normalizeAbsolute(cwd);
  return repos.find((repo) => {
    const root = normalizeAbsolute(repo.root);
    return root && (normalizedCwd === root || normalizedCwd.startsWith(`${root}/`));
  }) || null;
}

function failureSignature(repoRoot, domainNames, payload) {
  return hash({
    repoRoot,
    domains: [...(domainNames || [])].sort(),
    payload
  });
}

function publicDecision(decision) {
  const { signaturePayload, domainNames, ...rest } = decision;
  return rest;
}

function applyLoopState(activeRuntime, input, repoRoot, decision) {
  if (decision.decision !== 'block') return decision;

  const signature = failureSignature(repoRoot, decision.domainNames || [], decision.signaturePayload || decision.reason);
  const path = statePath(activeRuntime, input, repoRoot);
  const previous = readState(path);
  const count = previous && previous.signature === signature ? previous.count + 1 : 1;
  const maxRepeated = positiveInteger(activeRuntime.settings.maxRepeatedFailureBlocks, DEFAULT_MAX_REPEATED_FAILURE_BLOCKS);
  const stateSaved = writeState(path, {
    signature,
    count,
    repoRoot,
    domains: decision.domainNames || [],
    reason: decision.reason,
    updatedAt: new Date().toISOString()
  });

  if (stateSaved && isStopContinuation(input) && count >= maxRepeated) {
    return {
      continue: true,
      systemMessage:
        `Quality completion gate saw the same blocker repeated ${count} times for ${repoRoot}. ` +
        'Stop retrying this completion path and report the blocker to the user.\n\n' +
        decision.reason
    };
  }

  return publicDecision(decision);
}

function block(activeRuntime, input, repoRoot, reason, signaturePayload, domainNames = []) {
  return applyLoopState(activeRuntime, input, repoRoot, {
    decision: 'block',
    reason,
    signaturePayload,
    domainNames
  });
}

function remainingBudget(activeRuntime, startedAt) {
  const budgetMs = positiveInteger(activeRuntime.settings.totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS);
  return budgetMs - (Date.now() - startedAt);
}

function budgetFailure(command, domain, totalBudgetMs) {
  return {
    ok: false,
    label: command.label || command.command,
    domain,
    command: command.command,
    cwd: command.cwd || '',
    ms: 0,
    status: null,
    output: `Total Stop budget of ${totalBudgetMs}ms exhausted before this command could run.`
  };
}

function evaluate(input) {
  const startedAt = Date.now();
  if (!runtime.enabled) return { continue: true };

  const cwd = input.cwd || process.cwd();
  const manifest = loadVerifyManifest(runtime);
  const rootResult = gitRoot(cwd, runtime.shared.runtime.gitTimeoutMs);
  if (!rootResult.ok) {
    const managedRepo = manifest.data ? knownRepoForCwd(manifest.data, cwd) : null;
    if (!managedRepo) return { continue: true };
    const managedRoot = normalizeAbsolute(managedRepo.root);
    return block(
      runtime,
      input,
      managedRoot,
      `Quality completion gate could not inspect git root for managed repo ${managedRoot}: ${rootResult.error}`,
      { kind: 'git-root', error: rootResult.error },
      []
    );
  }
  const repoRoot = rootResult.value;

  const filesResult = changedFiles(repoRoot, runtime.shared.runtime.gitTimeoutMs);
  if (!filesResult.ok) {
    return block(
      runtime,
      input,
      repoRoot,
      `Quality completion gate could not inspect git status for ${repoRoot}: ${filesResult.error}`,
      { kind: 'git-status', error: filesResult.error },
      []
    );
  }
  const files = filesResult.value;
  if (!files.length) {
    clearState(runtime, input, repoRoot);
    return { continue: true };
  }

  if (!manifest.data) {
    return block(
      runtime,
      input,
      repoRoot,
      `Quality completion gate could not find a verify manifest. Expected ${manifest.path}.`,
      { kind: 'missing-manifest', path: manifest.path },
      []
    );
  }

  const repoEntry = repoEntryForRoot(manifest.data, repoRoot);
  if (!repoEntry) {
    return block(
      runtime,
      input,
      repoRoot,
      `Quality completion gate has no repo entry for ${repoRoot} in ${manifest.path}.`,
      { kind: 'missing-repo-entry', manifestPath: manifest.path },
      []
    );
  }

  const { touched, unmatched } = touchedDomains(repoEntry, files);
  if (unmatched.length && repoEntry.blockOnUnmatched !== false) {
    return block(
      runtime,
      input,
      repoRoot,
      `Quality completion gate found changed files with no declared verify domain in ${manifest.path}: ` +
        unmatched.slice(0, 12).join(', '),
      { kind: 'unmatched-files', unmatched: unmatched.slice(0, 50), manifestPath: manifest.path },
      []
    );
  }

  const domainNames = [...touched.keys()];
  if (!domainNames.length) {
    clearState(runtime, input, repoRoot);
    return { continue: true };
  }

  const commands = commandsForDomains(repoEntry, domainNames);
  if (!commands.length) {
    return block(
      runtime,
      input,
      repoRoot,
      `Quality completion gate found touched domains without commands: ${domainNames.join(', ')}.`,
      { kind: 'missing-domain-commands', domainNames },
      domainNames
    );
  }

  const totalBudgetMs = positiveInteger(runtime.settings.totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS);
  const results = [];
  for (const command of commands) {
    const remaining = remainingBudget(runtime, startedAt);
    if (remaining <= 0) {
      results.push(budgetFailure(command, command.domain, totalBudgetMs));
      break;
    }
    results.push(runVerifyCommand(repoRoot, command, runtime.shared.runtime.verifyCommandTimeoutMs, remaining));
  }
  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    return block(
      runtime,
      input,
      repoRoot,
      `Quality completion gate ran ${results.length} manifest command(s) for ${domainNames.join(', ')} and ${failures.length} failed.\n` +
        failures.map(formatFailure).join('\n\n'),
      {
        kind: 'command-failures',
        failures: failures.map((failure) => ({
          label: failure.label,
          command: failure.command,
          domain: failure.domain,
          status: failure.status,
          output: failure.output
        }))
      },
      domainNames
    );
  }

  clearState(runtime, input, repoRoot);
  return { continue: true };
}

function selfTest() {
  writeJson(evaluate({
    cwd: process.cwd(),
    hook_event_name: 'Stop'
  }));
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

try {
  writeJson(evaluate(readJsonStdin()));
} catch (error) {
  runtime.debug(`skipped: ${error.message}`);
  writeJson({ continue: true, systemMessage: `Quality completion gate skipped: ${error.message}` });
}
