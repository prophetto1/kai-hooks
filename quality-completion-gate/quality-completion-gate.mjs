#!/usr/bin/env node
// Stop hook: compute changed domains from git, run manifest-declared verification commands, gate on exit codes.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  stopFailureResponse,
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

function lockToken() {
  return hash({ pid: process.pid, at: Date.now(), nonce: Math.random() });
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
  const blocked = applyLoopState(activeRuntime, input, repoRoot, {
    decision: 'block',
    reason,
    signaturePayload,
    domainNames
  });
  if (blocked.decision === 'block') {
    return stopFailureResponse(activeRuntime.settings, blocked.reason);
  }
  return blocked;
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

function singleFlightStaleMs(activeRuntime, totalBudgetMs) {
  const configured = activeRuntime.settings.singleFlightStaleMs;
  return positiveInteger(configured, totalBudgetMs + 60000);
}

function lockPath(activeRuntime, repoRoot) {
  return join(qualityStateDir(activeRuntime), 'locks', `${hash({ repoRoot })}.lock`);
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function removeStaleLock(path, staleMs) {
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (ageMs < staleMs) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function processIsRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeDeadOwnerLock(path, existing) {
  if (!existing?.pid || processIsRunning(existing.pid)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function tryCreateLock(path, owner) {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function acquireSingleFlight(activeRuntime, input, repoRoot, domainNames, totalBudgetMs) {
  const path = lockPath(activeRuntime, repoRoot);
  const owner = {
    token: lockToken(),
    pid: process.pid,
    repoRoot,
    domains: [...domainNames].sort(),
    cwd: input.cwd || process.cwd(),
    sessionId: input.session_id || input.sessionId || '',
    startedAt: new Date().toISOString()
  };
  const staleMs = singleFlightStaleMs(activeRuntime, totalBudgetMs);

  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      tryCreateLock(path, owner);
      return { ok: true, path, owner };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return {
          ok: false,
          reason: `Quality completion gate could not acquire the single-flight lock for ${repoRoot}: ${error.message || error}`
        };
      }
      const existing = readLock(path);
      if (attempt === 0 && removeDeadOwnerLock(path, existing)) continue;
      if (attempt === 0 && removeStaleLock(path, staleMs)) continue;

      const detail = existing?.startedAt
        ? ` Existing runner pid ${existing.pid || 'unknown'} started at ${existing.startedAt}.`
        : '';
      return {
        ok: false,
        reason:
          `Quality completion gate is already running for ${repoRoot}. ` +
          `Do not start another gate, wait, poll, or debug.${detail}`
      };
    }
  }

  return {
    ok: false,
    reason: `Quality completion gate could not acquire the single-flight lock for ${repoRoot}.`
  };
}

function releaseSingleFlight(lock) {
  if (!lock?.ok || !lock.path) return;
  const existing = readLock(lock.path);
  if (existing?.token && existing.token !== lock.owner?.token) return;
  try {
    rmSync(lock.path, { force: true });
  } catch {
    // Lock cleanup must not mask the actual gate result.
  }
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
  const lock = acquireSingleFlight(runtime, input, repoRoot, domainNames, totalBudgetMs);
  if (!lock.ok) {
    return stopFailureResponse(runtime.settings, lock.reason);
  }

  try {
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
  } finally {
    releaseSingleFlight(lock);
  }
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
