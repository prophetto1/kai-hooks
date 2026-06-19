#!/usr/bin/env node
// UserPromptSubmit hook: injects the configured protocol, memory recall, and skill suggestions.
// Config authority: E:/hooks/config.json. If the config is missing or invalid, this hook exits
// cleanly without injecting hidden-default content. Tune behavior in config.json, not in this file.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateConfig as validateRuntimeConfig } from '../_core/config-model.mjs';
import { composeOutput, projectFromCwd } from './inject-core.mjs';

const modulePath = fileURLToPath(import.meta.url);
const here = dirname(modulePath);
const ID = basename(modulePath, extname(modulePath));
const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || 'E:/hooks/config.json';
const DEBUG = process.env.HOOK_DEBUG === '1' || process.argv.includes('--debug');
const STARTED_AT = Date.now();
const STATE_DIR = join(dirname(here), '.state');
const EVENT_LOG = join(STATE_DIR, `${ID}-events.jsonl`);
const MEMORY_FILTER_SQL = Object.freeze({
  'not-deleted': 'm.deleted_at IS NULL',
  'not-superseded': "(m.superseded_by IS NULL OR m.superseded_by='')"
});

const safeEvent = (event, data = {}) => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(EVENT_LOG, `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      elapsedMs: Date.now() - STARTED_AT,
      ...data
    })}\n`, 'utf8');
  } catch {
    // Diagnostics must never affect hook delivery.
  }
};
const debug = (msg) => { if (DEBUG) console.error(`[${ID}] ${msg}`); };
const failOpen = (label, err) => {
  safeEvent('fail-open', { label, error: err && (err.stack || err.message) || String(err) });
  debug(`${label}: ${err && (err.stack || err.message) || err}`);
  process.exit(0);
};
const configError = (errors) => {
  const list = Array.isArray(errors) ? errors : [String(errors)];
  safeEvent('config-error', { errors: list });
  console.error(`[${ID}] config invalid; no hidden-default injection used:\n- ${list.join('\n- ')}`);
  // UserPromptSubmit is fail-open; _core/validate-runtime-hooks.mjs is the hard-fail validator.
  process.exit(0);
};

safeEvent('start', {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  node: process.version,
  configPath: CONFIG_PATH
});
process.on('exit', (code) => safeEvent('exit', { code }));
process.on('uncaughtException', (err) => failOpen('uncaught exception', err));
process.on('unhandledRejection', (err) => failOpen('unhandled rejection', err));
process.stdout.on('error', (err) => failOpen('stdout write failed', err));

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    configError(`cannot read ${CONFIG_PATH}: ${err.message}`);
  }
}

function hookEntry(config) {
  if (Array.isArray(config.hooks)) return config.hooks.find(h => h && h.id === ID);
  if (isObject(config.hooks)) return config.hooks[ID];
  return null;
}

function normalizeProjects(projects) {
  const entries = projects
    .filter(p => p && p.slug)
    .map(p => ({
      slug: p.slug,
      kind: p.kind || '',
      repoPath: (p.repoPath || '').toString().replace(/\\/g, '/').toLowerCase(),
      detection: [p.slug, ...(Array.isArray(p.aliases) ? p.aliases : [])]
        .map(x => x.toString().toLowerCase())
    }));
  const aliases = {};
  for (const p of entries) for (const a of p.detection) aliases[a] = p.slug;
  return {
    entries,
    aliases,
    activeSlugs: entries.filter(p => p.kind === 'rebuild').map(p => p.slug),
    allSlugs: entries.map(p => p.slug)
  };
}

function buildSettings(selfSettings) {
  return {
    protocolFile: selfSettings.sources.protocol.file,
    terms: selfSettings.terms,
    runtime: selfSettings.runtime,
    memory: selfSettings.sources.memory,
    skills: selfSettings.sources.skills,
    output: selfSettings.output
  };
}

const CFG = loadConfig();
const SELF = hookEntry(CFG);
const validationResult = validateRuntimeConfig(CFG);
if (!validationResult.ok) configError(validationResult.errors);

const ENABLED = SELF.enabled !== false;
const SHARED = CFG.shared;
SHARED.projects = normalizeProjects(SHARED.projects);
const S = buildSettings(SELF.settings);

const DB = SHARED.paths.memoryDb;
const STOP = new Set(SHARED.stopwords.split(/\s+/).filter(Boolean));
const PYENV = { ...process.env, ...(SHARED.runtime.pythonEnv || {}) };
const clip = (text, max) => {
  const value = (text || '').toString().trim();
  return value.length > max ? `${value.slice(0, max)} ...` : value;
};

const py = (label, scriptPath, args) => {
  const start = Date.now();
  try {
    const lines = execFileSync(SHARED.paths.python, [scriptPath, ...args.map((arg) => String(arg))], {
      encoding: 'utf8',
      timeout: SHARED.runtime.pythonTimeoutMs,
      env: PYENV,
      maxBuffer: S.runtime.pythonMaxBufferBytes,
      stdio: ['ignore', 'pipe', 'pipe']
    }).split('\n').filter(Boolean);
    const elapsedMs = Date.now() - start;
    debug(`${label}: ${lines.length} row(s) in ${elapsedMs}ms`);
    return { ok: true, label, lines, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const stderr = clip(err.stderr, S.runtime.diagnosticClipChars);
    const stdout = clip(err.stdout, S.runtime.diagnosticClipChars);
    const details = stderr || stdout;
    const error = `${err.message}${details ? `\n${details}` : ''}`;
    safeEvent('source-error', { label, elapsedMs, error });
    console.error(`[${ID}] ${label} failed after ${elapsedMs}ms: ${error}`);
    return { ok: false, label, lines: [], elapsedMs, error };
  }
};

function readAll() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function parse(raw) {
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return { raw }; }
}

function textFromContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (isObject(item)) return textFromContent(item.text ?? item.value ?? item.content);
      return '';
    }).filter(Boolean).join(' ');
  }
  if (isObject(value)) return textFromContent(value.content ?? value.text ?? value.value ?? value.message);
  return value == null ? '' : String(value);
}

function getPrompt(o) {
  return textFromContent(o.prompt ?? o.user_prompt ?? o.message ?? o.input ?? o.raw);
}

function getCwd(o) {
  return (o.cwd || process.env.PWD || process.cwd() || '').toString().replace(/\\/g, '/').toLowerCase();
}

function project(cwd) {
  return projectFromCwd(cwd, SHARED.projects.entries);
}

const TERM_RE = new RegExp(`[${S.terms.tokenCharClass}]{${S.terms.minLen},}`, S.terms.tokenRegexFlags);
function extract(text) {
  return (text.toLowerCase().match(TERM_RE) || []).filter(w => !STOP.has(w));
}

function readTextTail(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function recentUserText(o, cur, n) {
  if (n <= 0) return [];
  const transcriptPath = o.transcript_path || o.transcriptPath;
  if (!transcriptPath) return [];
  try {
    const lines = readTextTail(transcriptPath, S.runtime.transcriptTailBytes).split('\n').filter(Boolean);
    const users = [];
    for (let i = lines.length - 1; i >= 0 && users.length < n; i--) {
      let m;
      try { m = JSON.parse(lines[i]); } catch { continue; }
      const role = m.type || m.role || (m.message && m.message.role);
      if (role !== 'user') continue;
      const text = textFromContent((m.message && m.message.content) ?? m.content);
      const trimmed = text.trim();
      if (trimmed && trimmed !== cur.trim()) users.push(trimmed);
    }
    return users;
  } catch {
    return [];
  }
}

function terms(prompt, context) {
  const cur = [...new Set(extract(prompt))];
  const extra = [...new Set((context || []).flatMap(extract))].filter(w => !cur.includes(w));
  return [...cur, ...extra].slice(0, S.terms.max);
}

function parseObjects(lines) {
  const out = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') out.push(value);
    } catch {
      if (line.trim()) out.push({ text: line.trim() });
    }
  }
  return out;
}

function skippedSource(source, reason, data = {}) {
  return { source, ok: true, skipped: true, reason, rows: [], ...data };
}

function sourceResult(source, result) {
  return {
    source,
    ok: result.ok,
    skipped: false,
    rows: result.ok ? parseObjects(result.lines) : [],
    elapsedMs: result.elapsedMs,
    error: result.error || null,
    diagnostics: result.diagnostics || [],
  };
}

function sourceDiagnostics(results) {
  return results
    .filter(Boolean)
    .flatMap((result) => [
      ...(Array.isArray(result.diagnostics) ? result.diagnostics : []),
      ...(!result.ok ? [`${result.source}: ${clip(result.error, S.runtime.sourceDiagnosticClipChars)}`] : []),
    ]);
}

function memoryFilterSql(filters) {
  return (filters || []).map((filter) => {
    const id = filter && filter.id;
    if (!MEMORY_FILTER_SQL[id]) throw new Error(`unknown memory filter id: ${id}`);
    return MEMORY_FILTER_SQL[id];
  });
}

function sqliteRecall(t, proj) {
  const M = S.memory;
  if (t.length < M.minTerms) {
    return skippedSource('memory', 'insufficient_terms', {
      provider: 'sqlite',
      termCount: t.length,
      minTerms: M.minTerms
    });
  }
  const q = t.map(w => `"${w}"`).join(' OR ');
  const config = {
    ftsTable: M.ftsTable,
    joinTable: M.joinTable,
    filtersSql: memoryFilterSql(M.filters),
    max: M.max,
    snippetChars: M.snippetChars,
    candidatePool: M.candidatePool,
    scoring: M.scoring,
    crossProjectTag: SHARED.memoryTags.crossProjectTag
  };
  return {
    ...sourceResult('memory', py('memory recall', join(here, 'recall.py'), [DB, q, proj || '', JSON.stringify(config)])),
    provider: 'sqlite',
  };
}

function parseMcpPayload(text) {
  let content = String(text || '').trim();
  if (!content) return {};
  if (content.startsWith('event:')) {
    const dataLine = content.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!dataLine) throw new Error('MCP response used SSE without a data line');
    content = dataLine.slice(6).trim();
  }
  return JSON.parse(content);
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function mcpPost(endpoint, body, headers, timeoutMs) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${clip(text, S.runtime.mcpErrorClipChars)}`);
    return { response, payload: parseMcpPayload(text) };
  } finally {
    timeout.clear();
  }
}

async function callHindsightTool(memorySettings, toolName, args) {
  const H = memorySettings.hindsight;
  const timeoutMs = H.timeoutMs;
  const init = await mcpPost(H.endpoint, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hooks-inject-protocol', version: '1.0.0' },
    },
  }, {}, timeoutMs);
  const sessionId = init.response.headers.get('mcp-session-id') || init.response.headers.get('Mcp-Session-Id');
  if (!sessionId) throw new Error('Hindsight initialize returned no MCP session id');

  const sessionHeaders = { 'mcp-session-id': sessionId };
  await mcpPost(H.endpoint, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }, sessionHeaders, timeoutMs);

  const call = await mcpPost(H.endpoint, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, sessionHeaders, timeoutMs);
  return call.payload;
}

function resultTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => textFromContent(item?.text ?? item?.content ?? item)).filter(Boolean).join('\n');
}

function hindsightStructuredContent(payload) {
  const result = payload?.result || {};
  if (result.structuredContent) return result.structuredContent;
  const text = resultTextFromContent(result.content);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { results: [{ text }] };
  }
}

function hindsightRowText(row) {
  return textFromContent(row?.text ?? row?.content ?? row?.memory ?? row?.fact ?? row?.summary ?? row);
}

function normalizeHindsightRows(payload) {
  const structured = hindsightStructuredContent(payload);
  const rows = structured.results || structured.memories || structured.items || structured.chunks || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    text: hindsightRowText(row),
    score: Number(row?.score ?? row?.relevance ?? row?.similarity ?? 0),
    signals: {
      provider: 'hindsight',
      ...(isObject(row?.signals) ? row.signals : {}),
    },
  })).filter((row) => row.text);
}

async function hindsightRecall(t, proj) {
  const M = S.memory;
  if (t.length < M.minTerms) {
    return skippedSource('memory', 'insufficient_terms', {
      provider: 'hindsight',
      termCount: t.length,
      minTerms: M.minTerms,
    });
  }

  const startedAt = Date.now();
  try {
    const query = [proj, ...t].filter(Boolean).join(' ');
    const payload = await callHindsightTool(M, M.hindsight.tool, {
      query,
      limit: M.max,
    });
    return {
      source: 'memory',
      ok: true,
      skipped: false,
      provider: 'hindsight',
      rows: normalizeHindsightRows(payload),
      elapsedMs: Date.now() - startedAt,
      error: null,
      diagnostics: [],
    };
  } catch (err) {
    const error = err && (err.stack || err.message) || String(err);
    safeEvent('source-error', { label: 'hindsight recall', elapsedMs: Date.now() - startedAt, error });
    console.error(`[${ID}] hindsight recall failed after ${Date.now() - startedAt}ms: ${error}`);
    return {
      source: 'memory',
      ok: false,
      skipped: false,
      provider: 'hindsight',
      rows: [],
      elapsedMs: Date.now() - startedAt,
      error,
      diagnostics: [],
    };
  }
}

async function recall(t, proj) {
  const provider = S.memory.provider || 'sqlite';
  if (provider !== 'hindsight') return sqliteRecall(t, proj);

  const primary = await hindsightRecall(t, proj);
  const fallbackProvider = S.memory.fallbackProvider || 'none';
  const shouldFallback =
    fallbackProvider === 'sqlite' &&
    !primary.skipped &&
    (!primary.ok || (S.memory.fallbackOnEmpty === true && primary.rows.length === 0));

  if (!shouldFallback) return primary;

  const fallback = sqliteRecall(t, proj);
  return {
    ...fallback,
    provider: 'hindsight',
    fallbackProvider: 'sqlite',
    primary,
    diagnostics: [
      primary.ok
        ? 'Hindsight recall returned no rows; SQLite compatibility fallback was used.'
        : `Hindsight recall failed; SQLite compatibility fallback was used: ${clip(primary.error, S.runtime.fallbackDiagnosticClipChars)}`,
      ...(fallback.diagnostics || []),
    ],
  };
}

function skillNoise() {
  return new Set(S.skills.noiseTerms.map(x => x.toString()));
}

function skillTerms(t) {
  const noise = skillNoise();
  return t.filter(w => !noise.has(w));
}

function suggest(t, proj) {
  const K = S.skills;
  const st = skillTerms(t);
  if (!st.length) return skippedSource('skills', 'no_skill_terms');
  const q = st.map(w => `"${w}"`).join(' OR ');
  const config = {
    ftsTable: K.ftsTable,
    joinTable: K.joinTable,
    max: K.max,
    candidatePool: K.candidatePool,
    scoring: K.scoring
  };
  const result = sourceResult('skills', py('skill suggest', join(here, 'suggest.py'), [DB, q, proj || '', st.join(' '), JSON.stringify(config)]));
  const seen = new Set();
  const out = [];
  for (const row of result.rows) {
    if (!row.name || seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return { ...result, rows: out.slice(0, K.max), skillTerms: st };
}

function outputLabels(proj) {
  const crossTag = SHARED.memoryTags.crossProjectTag;
  const scope = proj ? `, scope: ${proj}+${crossTag}` : '';
  return {
    diagnostics: S.output.labels.diagnostics,
    skills: S.output.labels.skills,
    memory: S.output.labels.memory.replace('{scope}', scope)
  };
}

async function selfTest() {
  const sample = process.argv.filter(x => !x.startsWith('--')).slice(2).join(' ') || 'optimize this hook system';
  const proj = project('E:/hooks'.replace(/\\/g, '/').toLowerCase());
  const extracted = terms(sample, []);
  const skillResult = suggest(extracted, proj);
  const memoryResult = await recall(extracted, proj);
  console.log(JSON.stringify({
    id: ID,
    enabled: ENABLED,
    configPath: CONFIG_PATH,
    configLoaded: true,
    configControlsRuntime: true,
    protocolPath: join(here, S.protocolFile),
    protocolExists: existsSync(join(here, S.protocolFile)),
    memoryDb: DB,
    memoryDbExists: existsSync(DB),
    memoryProvider: S.memory.provider || 'sqlite',
    memoryFallbackProvider: S.memory.fallbackProvider || 'none',
    hindsightEndpoint: S.memory.hindsight?.endpoint || '',
    projectCount: SHARED.projects.entries.length,
    injectRuntime: S.runtime,
    memoryRecall: {
      max: S.memory.max,
      snippetChars: S.memory.snippetChars,
      minTerms: S.memory.minTerms,
      candidatePool: S.memory.candidatePool,
    },
    memoryScoring: S.memory.scoring,
    skillScoring: S.skills.scoring,
    outputBudgets: S.output.budgets,
    samplePrompt: sample,
    extractedTerms: extracted,
    skillTerms: skillTerms(extracted),
    sourceResults: {
      skills: {
        ok: skillResult.ok,
        skipped: skillResult.skipped || false,
        reason: skillResult.reason || null,
        rowCount: skillResult.rows.length,
        error: skillResult.error || null
      },
      memory: {
        ok: memoryResult.ok,
        skipped: memoryResult.skipped || false,
        provider: memoryResult.provider || null,
        fallbackProvider: memoryResult.fallbackProvider || null,
        primaryOk: memoryResult.primary ? memoryResult.primary.ok : memoryResult.ok,
        primaryRowCount: memoryResult.primary ? memoryResult.primary.rows.length : memoryResult.rows.length,
        reason: memoryResult.reason || null,
        rowCount: memoryResult.rows.length,
        error: memoryResult.error || null
      }
    },
    sourceDiagnostics: sourceDiagnostics([skillResult, memoryResult]),
    suggestedSkills: skillResult.rows,
    recalledMemories: memoryResult.rows.map(m => ({ score: m.score, signals: m.signals, text: m.text })),
    capChars: S.output.capChars
  }, null, 2));
}

async function run() {
  if (process.argv.includes('--self-test')) {
    await selfTest();
    return;
  }
  if (!ENABLED) {
    safeEvent('disabled-skip', { configPath: CONFIG_PATH });
    return;
  }

  const rules = (() => {
    try { return readFileSync(join(here, S.protocolFile), 'utf8').trim(); }
    catch (err) { debug(`protocol load failed: ${err.message}`); return ''; }
  })();
  const payload = parse(readAll());
  const prompt = getPrompt(payload);
  let out = rules;
  if (prompt) {
    const proj = project(getCwd(payload));
    const extracted = terms(prompt, recentUserText(payload, prompt, S.terms.contextPrompts));
    const skillResult = suggest(extracted, proj);
    const memoryResult = await recall(extracted, proj);
    const labels = outputLabels(proj);
    const diagnostics = sourceDiagnostics([skillResult, memoryResult]);
    safeEvent('source-summary', {
      project: proj || null,
      termCount: extracted.length,
      skillTerms: skillResult.skillTerms || [],
      skillOk: skillResult.ok,
      skillSkipped: skillResult.skipped || false,
      skillRows: skillResult.rows.length,
      memoryOk: memoryResult.ok,
      memorySkipped: memoryResult.skipped || false,
      memoryProvider: memoryResult.provider || null,
      memoryFallbackProvider: memoryResult.fallbackProvider || null,
      memoryRows: memoryResult.rows.length,
      diagnosticsCount: diagnostics.length
    });
    out = composeOutput(
      rules,
      skillResult.rows,
      memoryResult.rows,
      labels,
      S.output.capChars,
      S.output.budgets,
      diagnostics
    );
  }
  if (!out) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: out
    }
  }));
}

try {
  await run();
} catch (err) {
  failOpen('unhandled hook failure', err);
}
