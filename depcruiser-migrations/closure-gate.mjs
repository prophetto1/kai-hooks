#!/usr/bin/env node
// PreToolUse gate: block edits to the active migration's target page until its closure
// manifest exists and every node has a verdict (port/adapter/cut).
// Completion-side checks (depcruise summary.error, tsc --noEmit, reconcile) are NOT here —
// they are delegated to quality-completion-gate via verify-manifest domain entries.
// Output contract matches the framework: JSON decision on stdout, always exit 0.
import {
  hookRuntime, readJsonStdin, writeJson, normalizePath,
  manifestPathFor, pendingVerdicts, loadJson, existsSync
} from './closure-gate-core.mjs';

const DEFAULTS = {
  editTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'],
  active: { name: null, targetGlob: null }
};

const runtime = hookRuntime(import.meta.url, DEFAULTS);

const allow = () => ({ continue: true });
const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  systemMessage: reason
});

function evaluate(input) {
  if (!runtime.enabled) return allow();
  const active = runtime.settings.active || {};
  if (!active.name) return allow();                                   // no migration armed -> fail open
  if (!runtime.settings.editTools.includes(input.tool_name || '')) return allow();

  const file = normalizePath(input.tool_input?.file_path || '');
  if (active.targetGlob && file && !file.includes(normalizePath(active.targetGlob))) return allow();

  const mp = manifestPathFor(runtime, active.name);
  if (!existsSync(mp)) {
    return deny(`[closure-gate] no closure manifest for "${active.name}" at ${mp}. Trace the donor and generate the manifest before editing the target.`);
  }
  let manifest;
  try { manifest = loadJson(mp); } catch { return allow(); }          // unreadable -> fail open
  const pending = pendingVerdicts(manifest);
  if (pending.length) {
    return deny(`[closure-gate] ${pending.length} closure node(s) still need a verdict (port/adapter/cut) before editing:\n  ${pending.slice(0, 15).join('\n  ')}`);
  }
  return allow();
}

if (process.argv.includes('--self-test')) {
  writeJson(evaluate({ tool_name: 'Edit', tool_input: { file_path: 'x' } }));
  process.exit(0);
}

try {
  writeJson(evaluate(readJsonStdin()));
} catch (error) {
  runtime.debug(`skipped: ${error.message}`);
  writeJson({ continue: true });                                      // failPolicy: open
}
