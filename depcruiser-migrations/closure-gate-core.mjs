import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors quality-gate-core.mjs primitives (self-contained per hook dir; pre _core/hook-runtime.mjs extraction).
const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || 'E:/hooks/config.json';

const SHARED_DEFAULTS = {
  paths: { hooksDir: 'E:/hooks' },
  runtime: {}
};

export function merge(defaultValue, overrideValue) {
  if (Array.isArray(defaultValue) || typeof defaultValue !== 'object' || defaultValue === null) {
    return overrideValue === undefined ? defaultValue : overrideValue;
  }
  const out = { ...defaultValue };
  for (const key of Object.keys(defaultValue)) {
    if (overrideValue && key in overrideValue) out[key] = merge(defaultValue[key], overrideValue[key]);
  }
  if (overrideValue) for (const key of Object.keys(overrideValue)) if (!(key in out)) out[key] = overrideValue[key];
  return out;
}

export function hookRuntime(metaUrl, selfDefaults = {}) {
  const here = dirname(fileURLToPath(metaUrl));
  const id = basename(fileURLToPath(metaUrl)).replace('.mjs', '');
  const debugEnabled = process.env.HOOK_DEBUG === '1' || process.argv.includes('--debug');
  const debug = (m) => { if (debugEnabled) console.error(`[${id}] ${m}`); };
  const cfg = (() => {
    try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { debug(`config load failed: ${e.message}`); return {}; }
  })();
  const self = (Array.isArray(cfg.hooks) ? cfg.hooks.find((h) => h && h.id === id) : cfg.hooks && cfg.hooks[id]) || {};
  return {
    here, id, cfg, self,
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
  } catch { return {}; }
}

export function writeJson(value) { process.stdout.write(JSON.stringify(value)); }
export function normalizePath(value) { return String(value || '').trim().replaceAll('\\', '/'); }
export function loadJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export { existsSync };

// ---- closure-specific helpers ----
export function manifestPathFor(runtime, name) {
  const dir = runtime.settings.manifestsDir || join(runtime.here, 'manifests');
  return join(dir, name, `${name}.source-manifest.json`);
}

export function pendingVerdicts(manifest) {
  const mods = Array.isArray(manifest.modules) ? manifest.modules : [];
  return mods.filter((m) => !['port', 'adapter', 'cut'].includes(m.verdict)).map((m) => m.source);
}
