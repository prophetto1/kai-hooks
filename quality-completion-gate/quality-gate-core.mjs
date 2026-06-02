import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || 'E:/hooks/config.json';

const SHARED_DEFAULTS = {
  paths: {
    hooksDir: 'E:/hooks',
    qualityVerifyManifest: 'E:/hooks/quality-completion-gate/quality-verify-manifest.json'
  },
  runtime: {
    gitTimeoutMs: 5000,
    verifyCommandTimeoutMs: 120000
  }
};

export function merge(defaultValue, overrideValue) {
  if (Array.isArray(defaultValue) || typeof defaultValue !== 'object' || defaultValue === null) {
    return overrideValue === undefined ? defaultValue : overrideValue;
  }
  const out = { ...defaultValue };
  for (const key of Object.keys(defaultValue)) {
    if (overrideValue && key in overrideValue) out[key] = merge(defaultValue[key], overrideValue[key]);
  }
  if (overrideValue) {
    for (const key of Object.keys(overrideValue)) {
      if (!(key in out)) out[key] = overrideValue[key];
    }
  }
  return out;
}

export function hookRuntime(metaUrl, selfDefaults = {}) {
  const here = dirname(fileURLToPath(metaUrl));
  const id = basename(fileURLToPath(metaUrl)).replace('.mjs', '');
  const debugEnabled = process.env.HOOK_DEBUG === '1' || process.argv.includes('--debug');
  const debug = (message) => {
    if (debugEnabled) console.error(`[${id}] ${message}`);
  };
  const cfg = (() => {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
      debug(`config load failed: ${error.message}`);
      return {};
    }
  })();
  const self = (Array.isArray(cfg.hooks) ? cfg.hooks.find((hook) => hook && hook.id === id) : cfg.hooks && cfg.hooks[id]) || {};
  return {
    here,
    id,
    cfg,
    self,
    shared: merge(SHARED_DEFAULTS, cfg.shared),
    settings: merge(selfDefaults, self.settings),
    enabled: self.enabled !== false,
    debug
  };
}

export function readJsonStdin() {
  try {
    const raw = readFileSync(0, 'utf8').replace(String.fromCharCode(65279), '');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

export function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/');
}

function normalizeAbsolute(value) {
  return normalizePath(resolve(String(value || '')));
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadVerifyManifest(runtime) {
  const candidates = [
    runtime.settings.verifyManifest,
    runtime.shared.paths.qualityVerifyManifest,
    join(runtime.shared.paths.hooksDir, 'quality-completion-gate', 'quality-verify-manifest.json')
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return { path, data: loadJson(path) };
  }
  return { path: candidates[0] || '', data: null };
}

export function gitRoot(cwd, timeoutMs) {
  try {
    return normalizeAbsolute(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim());
  } catch {
    return '';
  }
}

function parseStatusFiles(status) {
  const files = [];
  for (const line of status.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const file = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
    if (file) files.push(normalizePath(file));
  }
  return files;
}

export function changedFiles(repoRoot, timeoutMs) {
  try {
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain=v1'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return [...new Set(parseStatusFiles(status))].sort();
  } catch {
    return [];
  }
}

export function repoEntryForRoot(manifest, repoRoot) {
  const repos = Array.isArray(manifest?.repos) ? manifest.repos : [];
  const normalizedRoot = normalizeAbsolute(repoRoot);
  return repos.find((repo) => normalizeAbsolute(repo.root) === normalizedRoot) || null;
}

function pathParts(file) {
  const path = normalizePath(file);
  return {
    path,
    lower: path.toLowerCase(),
    base: basename(path).toLowerCase(),
    ext: extname(path).toLowerCase(),
    segments: path.toLowerCase().split('/').filter(Boolean)
  };
}

function listIncludes(list, value) {
  return Array.isArray(list) && list.map((item) => String(item).toLowerCase()).includes(String(value).toLowerCase());
}

function startsWithAny(value, prefixes) {
  return Array.isArray(prefixes) && prefixes.some((prefix) => value.startsWith(String(prefix).toLowerCase()));
}

function includesAny(value, needles) {
  return Array.isArray(needles) && needles.some((needle) => value.includes(String(needle).toLowerCase()));
}

function overlaps(values, expected) {
  if (!Array.isArray(expected)) return false;
  const set = new Set(expected.map((item) => String(item).toLowerCase()));
  return values.some((value) => set.has(String(value).toLowerCase()));
}

function ruleMatches(file, rule) {
  const parts = pathParts(file);
  if (rule.excludePrefixes && startsWithAny(parts.lower, rule.excludePrefixes)) return false;
  if (rule.excludeSegments && overlaps(parts.segments, rule.excludeSegments)) return false;
  if (rule.excludeContains && includesAny(parts.lower, rule.excludeContains)) return false;

  let checks = 0;
  let passed = true;
  const check = (condition) => {
    checks += 1;
    if (!condition) passed = false;
  };

  if (rule.prefixes) check(startsWithAny(parts.lower, rule.prefixes));
  if (rule.contains) check(includesAny(parts.lower, rule.contains));
  if (rule.extensions) check(listIncludes(rule.extensions, parts.ext));
  if (rule.fileNames) check(listIncludes(rule.fileNames, parts.base));
  if (rule.segments) check(overlaps(parts.segments, rule.segments));

  return checks > 0 && passed;
}

export function touchedDomains(repoEntry, files) {
  const domains = repoEntry?.domains || {};
  const touched = new Map();
  const unmatched = [];

  for (const file of files) {
    const matchedDomains = [];
    for (const [domainName, domain] of Object.entries(domains)) {
      const rules = Array.isArray(domain.paths) ? domain.paths : [];
      if (rules.some((rule) => ruleMatches(file, rule))) matchedDomains.push(domainName);
    }
    if (!matchedDomains.length) {
      unmatched.push(file);
      continue;
    }
    for (const domainName of matchedDomains) {
      if (!touched.has(domainName)) touched.set(domainName, []);
      touched.get(domainName).push(file);
    }
  }

  return { touched, unmatched };
}

export function commandsForDomains(repoEntry, domainNames) {
  const commands = [];
  const seen = new Set();
  for (const domainName of domainNames) {
    const domain = repoEntry.domains?.[domainName];
    for (const command of Array.isArray(domain?.commands) ? domain.commands : []) {
      const key = `${command.cwd || ''}\0${command.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push({ ...command, domain: domainName });
    }
  }
  return commands;
}

export function runVerifyCommand(repoRoot, command, defaultTimeoutMs) {
  const cwd = command.cwd ? join(repoRoot, command.cwd) : repoRoot;
  const startedAt = Date.now();
  try {
    const output = execSync(command.command, {
      cwd,
      encoding: 'utf8',
      timeout: command.timeoutMs || defaultTimeoutMs,
      maxBuffer: command.maxBuffer || 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      ok: true,
      label: command.label || command.command,
      domain: command.domain,
      command: command.command,
      cwd,
      ms: Date.now() - startedAt,
      output: String(output || '').slice(-4000)
    };
  } catch (error) {
    return {
      ok: false,
      label: command.label || command.command,
      domain: command.domain,
      command: command.command,
      cwd,
      ms: Date.now() - startedAt,
      status: error.status ?? null,
      output: `${error.stdout || ''}${error.stderr || ''}`.slice(-4000) || error.message
    };
  }
}
