#!/usr/bin/env node
// Stop hook: compute changed domains from git, run manifest-declared verification commands, gate on exit codes.
import {
  changedFiles,
  commandsForDomains,
  gitRoot,
  hookRuntime,
  loadVerifyManifest,
  readJsonStdin,
  repoEntryForRoot,
  runVerifyCommand,
  touchedDomains,
  writeJson
} from './quality-gate-core.mjs';

const runtime = hookRuntime(import.meta.url);

function formatFailure(result) {
  const output = result.output ? `\n${result.output}` : '';
  return `${result.label} failed (${result.ms}ms): ${result.command}${output}`;
}

function isStopContinuation(input) {
  return input.stop_hook_active === true || String(input.stop_hook_active || '').toLowerCase() === 'true';
}

function evaluate(input) {
  if (!runtime.enabled) return { continue: true };
  if (isStopContinuation(input)) {
    return {
      continue: true,
      systemMessage:
        'Quality completion gate already blocked this Stop continuation; not re-blocking to avoid a Stop-hook loop.'
    };
  }

  const repoRoot = gitRoot(input.cwd || process.cwd(), runtime.shared.runtime.gitTimeoutMs);
  if (!repoRoot) return { continue: true };

  const files = changedFiles(repoRoot, runtime.shared.runtime.gitTimeoutMs);
  if (!files.length) return { continue: true };

  const manifest = loadVerifyManifest(runtime);
  if (!manifest.data) {
    return {
      decision: 'block',
      reason: `Quality completion gate could not find a verify manifest. Expected ${manifest.path}.`
    };
  }

  const repoEntry = repoEntryForRoot(manifest.data, repoRoot);
  if (!repoEntry) {
    return {
      decision: 'block',
      reason: `Quality completion gate has no repo entry for ${repoRoot} in ${manifest.path}.`
    };
  }

  const { touched, unmatched } = touchedDomains(repoEntry, files);
  if (unmatched.length && repoEntry.blockOnUnmatched !== false) {
    return {
      decision: 'block',
      reason:
        `Quality completion gate found changed files with no declared verify domain in ${manifest.path}: ` +
        unmatched.slice(0, 12).join(', ')
    };
  }

  const domainNames = [...touched.keys()];
  if (!domainNames.length) return { continue: true };

  const commands = commandsForDomains(repoEntry, domainNames);
  if (!commands.length) {
    return {
      decision: 'block',
      reason: `Quality completion gate found touched domains without commands: ${domainNames.join(', ')}.`
    };
  }

  const results = commands.map((command) =>
    runVerifyCommand(repoRoot, command, runtime.shared.runtime.verifyCommandTimeoutMs)
  );
  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    return {
      decision: 'block',
      reason:
        `Quality completion gate ran ${results.length} manifest command(s) for ${domainNames.join(', ')} and ${failures.length} failed.\n` +
        failures.map(formatFailure).join('\n\n')
    };
  }

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
