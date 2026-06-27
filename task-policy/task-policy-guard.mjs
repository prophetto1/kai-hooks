#!/usr/bin/env node
/**
 * PreToolUse: enforce the Active Task Envelope's explicit restrictions.
 *
 * The guard denies ONLY what the active task explicitly forbids:
 *   - file-mutating tools under a `read-only` directive;
 *   - file mutations outside allowed scopes / inside forbidden scopes;
 *   - heavy shell commands (browser / full-suite) forbidden by a directive;
 *   - heavy shell commands when policy state is unavailable (conservative default).
 *
 * It never denies ordinary read-only discovery tools, and it cannot be disabled
 * by prompt text. Command strings are read from `tool_input.command`, reusing
 * the `loop-safety/loop-guard.py` extraction precedent.
 */
import { basename } from 'node:path';
import { hookRuntime, readJsonStdin, writeJson } from '../quality-completion-gate/quality-gate-core.mjs';
import { isMutatingTool, repoRootForCwd } from '../task-mode/task-mode-core.mjs';
import {
  activeDirective,
  classifyCommand,
  commandIsAllowed,
  normalizePath,
  readEnvelope,
  taskPolicyConfig,
} from './task-policy-core.mjs';

const FILE_MUTATING_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Delete',
  'apply_patch',
  'StrReplace',
]);

const SHELL_TOOLS = new Set(['Bash', 'Shell']);

// Conservative read-only shell policy: a small allowlist of read-only discovery
// binaries. Anything else (including ambiguous runners like node/python/npm that
// can build, install, or execute arbitrary code) is denied while read-only is
// active. Deny-unknown is the safe default.
const READ_ONLY_SHELL_BINARIES = new Set([
  'ls', 'dir', 'pwd', 'echo', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'findstr',
  'wc', 'which', 'where', 'stat', 'tree', 'sort', 'uniq', 'cut', 'basename', 'dirname',
  'realpath', 'whoami', 'hostname', 'date', 'env', 'printenv', 'diff', 'less', 'more',
  'file', 'column', 'nl', 'find', 'true', 'test',
]);
// Only git subcommands that are read-only in every form. Subcommands with common
// mutating forms (branch/tag/remote/config/stash/checkout/...) are intentionally
// excluded so a read-only task cannot create branches/tags/remotes or write config.
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame',
  'describe', 'cat-file', 'shortlog', 'for-each-ref', 'rev-list', 'name-rev',
  'whatchanged', 'grep', 'count-objects', 'help',
]);

function shellSegments(command) {
  return String(command || '').split(/(?:&&|\|\||;|\||&|\n)/);
}

function segmentHead(segment) {
  const stripped = segment.trim().replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  const match = stripped.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const raw = match ? match[1] || match[2] || match[3] : '';
  return raw.replaceAll('\\', '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function hasWriteRedirect(segment) {
  const cleaned = segment.replace(/\d*>>?\s*(?:\/dev\/null|nul|&\s*\d)/gi, '');
  return /(^|\s)\d*>>?/.test(cleaned);
}

/** True only when every segment of a shell command is a safe read-only operation. */
export function shellIsReadOnlySafe(command) {
  const segments = shellSegments(command).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return true;
  for (const segment of segments) {
    if (hasWriteRedirect(segment)) return false;
    const head = segmentHead(segment);
    if (head === 'git') {
      const sub = segment.match(/\bgit\b(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?(?:\s+-[^\s]+)*\s+([a-z][a-z-]*)/i);
      if (!sub || !GIT_READ_SUBCOMMANDS.has(sub[1].toLowerCase())) return false;
      if (/--output\b/i.test(segment)) return false; // e.g. `git diff --output file` writes a file
      continue;
    }
    if (head === 'find' && /(?:^|\s)-(?:delete|exec|execdir|fprint|fls|ok)\b/.test(segment)) return false;
    if (!READ_ONLY_SHELL_BINARIES.has(head)) return false;
  }
  return true;
}

function allow() {
  return { continue: true };
}

function deny(toolName, reasonCode, message) {
  const reason = `task-policy-guard: '${toolName}' blocked — ${message} (reason: ${reasonCode}). This restriction comes from the active task envelope and cannot be lifted by prompt text; issue a new explicit user directive to change it.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  };
}

function relativeTo(repoRoot, filePath) {
  const root = normalizePath(repoRoot);
  const file = normalizePath(filePath);
  if (root && file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1);
  }
  return file;
}

function underAny(rel, prefixes) {
  return (prefixes || []).some((prefix) => {
    const p = normalizePath(prefix);
    return p && rel.toLowerCase().startsWith(p.toLowerCase());
  });
}

/**
 * Pure decision function for the guard. Returns one of:
 *   { action: 'allow' }
 *   { action: 'deny', reasonCode, message }
 */
export function decideGuard({ toolName, toolInput = {}, envelope, envelopeOk, config }) {
  const directives = (envelope && envelope.userDirectives) || [];
  const isShell = SHELL_TOOLS.has(toolName);
  const command = isShell ? String(toolInput.command || '') : '';
  const classes = command ? classifyCommand({ command }, config) : [];
  const heavy = classes.includes('browser') || classes.includes('full-suite');

  // Heavy shell commands: governed even when policy is unavailable.
  if (heavy) {
    if (!envelopeOk) {
      return { action: 'deny', reasonCode: 'policy-unavailable', message: 'heavy verification command blocked because task policy state is unavailable' };
    }
    if (!commandIsAllowed(classes, directives)) {
      const kind = classes.includes('browser') ? 'browser' : 'full-suite';
      return { action: 'deny', reasonCode: `directive-forbids-${kind}`, message: `the active task forbids ${kind} verification commands` };
    }
  }

  // Without an active envelope, nothing else is "explicitly forbidden".
  if (!envelopeOk) return { action: 'allow' };

  // read-only directive denies file-mutating tools and any non-discovery shell
  // command (not just heavy verification commands).
  if (activeDirective(directives, 'read-only')) {
    if (FILE_MUTATING_TOOLS.has(toolName)) {
      return { action: 'deny', reasonCode: 'read-only', message: 'the active task is read-only' };
    }
    if (isShell && command && !shellIsReadOnlySafe(command)) {
      return { action: 'deny', reasonCode: 'read-only-shell', message: 'the active task is read-only; only safe read-only discovery shell commands are allowed' };
    }
  }

  // Scope enforcement for file mutations.
  if (FILE_MUTATING_TOOLS.has(toolName)) {
    const filePath = toolInput.file_path || toolInput.path || toolInput.notebook_path;
    if (filePath) {
      const rel = relativeTo(envelope.repoRoot, filePath);
      const forbidden = envelope.forbiddenScopes || [];
      const allowed = envelope.allowedScopes || [];
      if (forbidden.length && underAny(rel, forbidden)) {
        return { action: 'deny', reasonCode: 'forbidden-scope', message: `path '${rel}' is inside a forbidden scope` };
      }
      if (allowed.length && !underAny(rel, allowed)) {
        return { action: 'deny', reasonCode: 'outside-allowed-scope', message: `path '${rel}' is outside the task's allowed scopes` };
      }
    }
  }

  return { action: 'allow' };
}

export function evaluate(input, runtime) {
  if (!runtime.enabled) return allow();
  const toolName = input.tool_name || '';
  if (!toolName) return allow();
  // Fast path: tools that can never be forbidden by this guard.
  const isShell = SHELL_TOOLS.has(toolName);
  if (!isShell && !FILE_MUTATING_TOOLS.has(toolName) && !isMutatingTool(toolName)) {
    return allow();
  }

  const sessionId = input.session_id || input.sessionId || '';
  const cwd = input.cwd || process.cwd();
  const repoRoot = repoRootForCwd(cwd, runtime.shared?.runtime?.gitTimeoutMs);
  const config = taskPolicyConfig(runtime.shared);
  const env = readEnvelope(config, sessionId, repoRoot);

  const decision = decideGuard({
    toolName,
    toolInput: input.tool_input || {},
    envelope: env.envelope,
    envelopeOk: env.ok,
    config,
  });
  if (decision.action === 'deny') return deny(toolName, decision.reasonCode, decision.message);
  return allow();
}

if (process.argv.includes('--self-test')) {
  writeJson(evaluate({ session_id: 'self-test', tool_name: 'Read', cwd: process.cwd() }, hookRuntime(import.meta.url)));
  process.exit(0);
}

if (process.argv[1] && basename(process.argv[1]) === 'task-policy-guard.mjs') {
  try {
    writeJson(evaluate(readJsonStdin(), hookRuntime(import.meta.url)));
  } catch (error) {
    // Fail open for ordinary tools; never block read/discovery on guard error.
    writeJson({ continue: true, systemMessage: `task-policy-guard skipped: ${error.message}` });
  }
}
