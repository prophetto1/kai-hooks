#!/usr/bin/env node
/**
 * Stop gate for operational diffs (apps/, services/, scripts/).
 *
 * LOC tiers (in-scope insertions + deletions):
 *   1–500   → Playwright → verification-before-completion
 *   501+    → Playwright → verification-before-completion → waza-hunt
 *             If hunt finds issues: fix → Playwright → verification (max 3 loops)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

import {
  changedFiles,
  gitRoot,
  hookRuntime,
  normalizeAbsolute,
  normalizePath,
  readJsonStdin,
  stopFailureResponse,
  writeJson,
} from '../quality-completion-gate/quality-gate-core.mjs';
import {
  detectFraudulentVerificationInTelemetry,
  isFraudulentVerificationCommand,
  nextFraudStrike,
  verificationFraudBlock,
} from '../quality-completion-gate/verification-integrity.mjs';

const DEFAULT_STATE_DIR = 'E:/hooks/.state/agent-diff-completion-gate';
const LOC_SMALL_MAX = 500;
const LOC_LARGE_MIN = 501;
const DEFAULT_MAX_REMEDIATION_LOOPS = 3;

const SKILL_VERIFICATION =
  process.env.SKILL_VERIFICATION_BEFORE_COMPLETION ||
  'C:/Users/jwchu/.agents/skills/verification-before-completion/SKILL.md';
const SKILL_WAZA_HUNT =
  process.env.SKILL_WAZA_HUNT ||
  'C:/Users/jwchu/.agents/skills/waza-hunt/SKILL.md';

const REPO_RULES = {
  'E:/kai-chattr': {
    enforcePrefixes: ['apps/', 'services/', 'scripts/'],
    codeExtensions: ['.py', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.json', '.ps1', '.toml'],
    visualCommand: 'sops exec-env secrets/dev/auth.yaml node scripts/dev/ui-snapshot-live.mjs',
    visualTimeoutMs: 120000,
    playwrightLabel: 'kai-chattr Playwright UI snapshot',
    verificationDir: 'docs/verification',
  },
};

const VERIFICATION_PATTERNS = [
  'verification-before-completion',
  'verification before completion',
  'verification_before_completion',
];

const WAZA_HUNT_PATTERNS = ['waza-hunt', 'waza hunt', 'waza_hunt', 'hunt: diagnose'];

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function statePath(sessionId, repoRoot) {
  const key = hash({ sessionId: sessionId || '', repoRoot: repoRoot || '' });
  return join(DEFAULT_STATE_DIR, `${key}.json`);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // fail open on state write errors
  }
}

function repoRule(repoRoot) {
  return REPO_RULES[normalizeAbsolute(repoRoot)] || null;
}

function fileExtension(file) {
  const base = file.split('/').pop() || '';
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index).toLowerCase() : '';
}

function fileInScope(file, rule) {
  const normalized = normalizePath(file);
  if (!rule.enforcePrefixes.some((prefix) => normalized.startsWith(prefix))) return false;
  const extensions = rule.codeExtensions;
  if (!extensions?.length) return true;
  const ext = fileExtension(normalized);
  return ext ? extensions.includes(ext) : true;
}

function touchesEnforcedScope(files, rule) {
  return files.some((file) => fileInScope(file, rule));
}

function scopedFiles(files, rule) {
  return files.filter((file) => fileInScope(file, rule));
}

function countLinesInFile(absPath) {
  try {
    return readFileSync(absPath, 'utf8').split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function scopeLocTotal(repoRoot, scoped, timeoutMs) {
  if (!scoped.length) return { ok: true, total: 0, insertions: 0, deletions: 0, files: [] };

  let insertions = 0;
  let deletions = 0;
  const perFile = [];

  try {
    const numstat = execFileSync('git', ['-C', repoRoot, 'diff', 'HEAD', '--numstat', '--', ...scoped], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tracked = new Set();
    for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match) continue;
      const add = match[1] === '-' ? 0 : Number(match[1]);
      const del = match[2] === '-' ? 0 : Number(match[2]);
      const file = normalizePath(match[3]);
      tracked.add(file);
      insertions += add;
      deletions += del;
      perFile.push({ file, insertions: add, deletions: del, untracked: false });
    }

    const status = execFileSync(
      'git',
      ['-C', repoRoot, 'status', '--porcelain', '-u', '--', ...scoped],
      { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    for (const line of status.split(/\r?\n/).filter(Boolean)) {
      const code = line.slice(0, 2);
      const file = normalizePath(line.slice(3).trim());
      if (!code.includes('?') || tracked.has(file)) continue;
      const lines = countLinesInFile(join(repoRoot, file));
      insertions += lines;
      perFile.push({ file, insertions: lines, deletions: 0, untracked: true });
    }

    return {
      ok: true,
      total: insertions + deletions,
      insertions,
      deletions,
      files: perFile,
    };
  } catch (error) {
    return {
      ok: false,
      total: 0,
      insertions: 0,
      deletions: 0,
      files: [],
      error: error.message || String(error),
    };
  }
}

function locTier(total, settings) {
  const smallMax = Number(settings.locSmallMax ?? LOC_SMALL_MAX);
  const largeMin = Number(settings.locLargeMin ?? LOC_LARGE_MIN);
  if (total >= largeMin) return 'large';
  if (total >= 1) return 'small';
  return 'none';
}

function parseVerificationSummary(output) {
  const marker = 'VERIFICATION_RUN_SUMMARY:';
  for (const line of String(output || '').split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    try {
      return JSON.parse(line.slice(index + marker.length));
    } catch {
      return null;
    }
  }
  return null;
}

function verifyRunArtifacts(repoRoot, summary, rule) {
  if (!summary?.runDir) {
    return { ok: false, reason: 'Playwright run did not emit VERIFICATION_RUN_SUMMARY.' };
  }

  const runDirAbs = join(repoRoot, summary.runDir);
  const runMetaPath = join(runDirAbs, 'run.json');
  if (!existsSync(runMetaPath)) {
    return { ok: false, reason: `Missing run.json in ${summary.runDir}` };
  }
  let runMeta;
  try {
    runMeta = JSON.parse(readFileSync(runMetaPath, 'utf8'));
  } catch {
    return { ok: false, reason: `Unreadable run.json in ${summary.runDir}` };
  }
  if (runMeta.liveApi !== true) {
    return {
      ok: false,
      fraud: true,
      reason: verificationFraudBlock(
        `Verification run in ${summary.runDir} is not live (run.json liveApi !== true). ` +
          'Mocked Playwright intercepts and synthetic API responses are rejected.',
      ),
    };
  }
  if (runMeta.frontendLogin !== true) {
    return {
      ok: false,
      fraud: true,
      reason: verificationFraudBlock(
        `Verification run in ${summary.runDir} did not sign in through /login (run.json frontendLogin !== true). ` +
          'Token injection and local-session shortcuts are rejected.',
      ),
    };
  }

  const reportPath = join(runDirAbs, 'report.json');
  if (!existsSync(reportPath)) {
    return { ok: false, reason: `Missing report.json in ${summary.runDir}` };
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return { ok: false, reason: `Unreadable report.json in ${summary.runDir}` };
  }

  const failed = report.filter((entry) => entry.status !== 'ok');
  if (failed.length) {
    return { ok: false, reason: `${failed.length} route(s) failed in ${summary.runDir}`, failed };
  }

  const missing = report.filter((entry) => !entry.screenshot || !existsSync(join(repoRoot, entry.screenshot)));
  if (missing.length) {
    return { ok: false, reason: `${missing.length} screenshot(s) missing under ${summary.runDir}`, missing };
  }

  const expectedPrefix = normalizePath(rule?.verificationDir || 'docs/verification');
  if (!normalizePath(summary.runDir).startsWith(`${expectedPrefix}/`)) {
    return { ok: false, reason: `Run folder must be under ${expectedPrefix}/ (got ${summary.runDir})` };
  }

  return {
    ok: true,
    runDir: summary.runDir,
    timestamp: summary.timestamp,
    screenshots: report.map((entry) => entry.screenshot).filter(Boolean),
  };
}

function runVisualCheck(repoRoot, rule) {
  const started = Date.now();
  try {
    const output = execSync(rule.visualCommand, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: rule.visualTimeoutMs || 120000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VERIFICATION_OUT_DIR: rule.verificationDir || 'docs/verification' },
    });
    const trimmed = output.trim();
    const summary = parseVerificationSummary(trimmed);
    const artifacts = verifyRunArtifacts(repoRoot, summary, rule);
    return {
      ok: summary?.ok === true && artifacts.ok,
      label: rule.playwrightLabel,
      command: rule.visualCommand,
      ms: Date.now() - started,
      output: trimmed,
      summary,
      artifacts,
    };
  } catch (error) {
    const stdout = error.stdout?.toString?.() || '';
    const stderr = error.stderr?.toString?.() || '';
    const combined = [stdout, stderr, error.message].filter(Boolean).join('\n').trim();
    const summary = parseVerificationSummary(combined);
    const artifacts = summary
      ? verifyRunArtifacts(repoRoot, summary, rule)
      : { ok: false, reason: 'Playwright exited with error' };
    return {
      ok: false,
      label: rule.playwrightLabel,
      command: rule.visualCommand,
      ms: Date.now() - started,
      output: combined,
      summary,
      artifacts,
    };
  }
}

function hooksDbPath(runtime) {
  return runtime.shared?.paths?.hooksDb || 'E:/hooks/_db/hooks.db';
}

function auditVerificationFraud(sessionId, rule, state, runtime) {
  const strikes = Number(state.fraudStrikes || 0);
  if (strikes >= 3) {
    return {
      blocked: true,
      strikes,
      message: verificationFraudBlock(
        'Session verification integrity limit reached due to prior fraudulent verification attempts.',
        strikes,
      ),
    };
  }

  const telemetry = detectFraudulentVerificationInTelemetry(hooksDbPath(runtime), sessionId, 0);
  if (telemetry.fraudulent) {
    const nextStrike = nextFraudStrike(strikes);
    const detail = telemetry.matches
      .map((match) => `- ${match.detail || match.target || match.tool_name}`)
      .join('\n');
    return {
      blocked: true,
      strikes: nextStrike,
      message: verificationFraudBlock(
        `Telemetry recorded mocked verification command(s) this session:\n${detail}`,
        nextStrike,
      ),
    };
  }

  if (isFraudulentVerificationCommand(rule.visualCommand)) {
    const nextStrike = nextFraudStrike(strikes);
    return {
      blocked: true,
      strikes: nextStrike,
      message: verificationFraudBlock(`Configured visual command is fraudulent: ${rule.visualCommand}`, nextStrike),
    };
  }

  return { blocked: false, strikes };
}

function telemetryMatches(sessionId, sinceId, runtime, patterns) {
  const dbPath = hooksDbPath(runtime);
  if (!existsSync(dbPath) || !sessionId) return false;

  try {
    const raw = execFileSync(
      process.env.HOOKS_PYTHON || 'python',
      [
        '-c',
        `
import json, sqlite3, sys
db, session_id, since_id = sys.argv[1], sys.argv[2], int(sys.argv[3])
patterns = [p.lower() for p in json.loads(sys.argv[4])]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute(
  "SELECT tool_name, target, detail FROM hook_events WHERE session_id=? AND id>? AND hook_id='hook-telemetry' ORDER BY id DESC LIMIT 200",
  (session_id, since_id),
).fetchall()
con.close()
blob = "\\n".join(" ".join(str(cell or "") for cell in row) for row in rows).lower()
print("1" if any(p in blob for p in patterns) else "0")
`,
        dbPath,
        sessionId,
        String(sinceId || 0),
        JSON.stringify(patterns),
      ],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    return raw === '1';
  } catch {
    return false;
  }
}

function verificationSkillDetected(sessionId, sinceId, runtime) {
  return telemetryMatches(sessionId, sinceId, runtime, [
    ...VERIFICATION_PATTERNS,
    'verification-before-completion/skill.md',
    'verification_before_completion',
  ]);
}

function wazaHuntDetected(sessionId, sinceId, runtime) {
  return telemetryMatches(sessionId, sinceId, runtime, [...WAZA_HUNT_PATTERNS, 'waza-hunt/skill.md']);
}

function block(runtime, reason) {
  return stopFailureResponse(runtime.settings, reason);
}

function buildPlaywrightSection(visualResult, rule) {
  const lines = [
    '## Step 1 — Playwright LIVE (runs first; gate executed this on Stop)',
    `Screenshots must be under ${rule.verificationDir}/<timestamp>/ with run.json liveApi:true and all routes "ok" in report.json.`,
  ];
  if (visualResult?.artifacts?.ok) {
    lines.push(
      `PASS (${visualResult.ms}ms): ${visualResult.artifacts.runDir}`,
      `Files: ${visualResult.artifacts.screenshots.join(', ')}`,
    );
  } else {
    lines.push(
      'FAIL — fix rendering/routes, then try Stop again.',
      visualResult?.artifacts?.reason || visualResult?.output || '',
    );
  }
  return lines;
}

function buildVerificationSection() {
  return [
    '## Step 2 — verification-before-completion (run AFTER Playwright passes)',
    `Read and follow: ${SKILL_VERIFICATION}`,
    'Run the verification commands fresh in this turn. Cite full command output before any "done/passing/fixed" claim.',
    'Do not skip to waza-hunt or completion until this step is done.',
  ];
}

function buildWazaSection(remediationCycle, maxLoops) {
  return [
    `## Step 3 — waza-hunt (required: ${LOC_LARGE_MIN}+ LOC in this diff)`,
    `Read and follow: ${SKILL_WAZA_HUNT}`,
    'Diagnose before you fix. State root cause with file:line evidence.',
    '',
    'If hunt finds issues you MUST:',
    '  1. Report the issue explicitly',
    '  2. State corrective action / root cause',
    '  3. Execute the fix',
    '  4. Try Stop again → Playwright re-runs → verification-before-completion re-runs',
    `Remediation loop ${remediationCycle}/${maxLoops}. After ${maxLoops} failed loops, report that the implementation has gone wrong — do not claim done.`,
  ];
}

function buildChecklist(ctx) {
  const {
    repoRoot,
    rule,
    changedInScope,
    loc,
    tier,
    visualResult,
    phase,
    remediationCycle,
    maxLoops,
  } = ctx;

  const lines = [
    'agent-diff-completion-gate: operational diff — completion blocked.',
    '',
    `Repo: ${repoRoot}`,
    `LOC changed (in-scope): ${loc.total} (+${loc.insertions}/-${loc.deletions}) → tier: ${tier}`,
    `Changed: ${changedInScope.join(', ')}`,
    `Phase: ${phase}`,
    '',
    ...buildPlaywrightSection(visualResult, rule),
    '',
    ...buildVerificationSection(),
  ];

  if (tier === 'large') {
    lines.push('', ...buildWazaSection(remediationCycle, maxLoops));
  }

  lines.push(
    '',
    'Completion message must cite docs/verification/<timestamp>/ PNG paths proving the app works.',
  );

  if (tier === 'large' && remediationCycle >= maxLoops) {
    lines.push(
      '',
      `⚠ Remediation limit reached (${maxLoops} loops). Report that the implementation has gone wrong.`,
      'State what failed, what was tried, and what remains broken. Do NOT claim success.',
    );
  }

  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

function evaluate(input, runtime) {
  if (!runtime.enabled) return { continue: true };

  const settings = runtime.settings || {};
  const maxRemediationLoops = Number(settings.maxRemediationLoops ?? DEFAULT_MAX_REMEDIATION_LOOPS);
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || input.sessionId || '';
  const gitTimeout = runtime.shared.runtime.gitTimeoutMs;

  const rootResult = gitRoot(cwd, gitTimeout);
  if (!rootResult.ok) return { continue: true };

  const repoRoot = rootResult.value;
  const rule = repoRule(repoRoot);
  const filesResult = changedFiles(repoRoot, gitTimeout);
  if (!filesResult.ok || !filesResult.value.length) {
    writeState(statePath(sessionId, repoRoot), {});
    return { continue: true };
  }

  const files = filesResult.value;
  if (!rule || !touchesEnforcedScope(files, rule)) {
    return { continue: true };
  }

  const changedInScope = scopedFiles(files, rule);
  const loc = scopeLocTotal(repoRoot, changedInScope, gitTimeout);
  const tier = locTier(loc.total, settings);
  if (tier === 'none') return { continue: true };

  const diffSignature = hash({ files: files.slice().sort(), loc: loc.total });
  const stateFile = statePath(sessionId, repoRoot);
  const state = readState(stateFile);
  const sameDiff = state.diffSignature === diffSignature;

  let remediationCycle = sameDiff ? Number(state.remediationCycle || 0) : 0;
  let sinceId = sameDiff ? Number(state.telemetryWatermark || 0) : 0;

  if (!sameDiff) {
    sinceId = 0;
    if (!state.wazaHuntDone) {
      remediationCycle = 0;
    }
  }

  const runtimeForTelemetry = runtime;

  const fraudAudit = auditVerificationFraud(sessionId, rule, state, runtimeForTelemetry);
  if (fraudAudit.blocked) {
    writeState(stateFile, {
      ...state,
      diffSignature,
      locTotal: loc.total,
      tier,
      fraudStrikes: fraudAudit.strikes,
    });
    return block(runtime, fraudAudit.message);
  }

  // Step 1: Playwright LIVE (always on Stop while diff exists)
  const visualResult = runVisualCheck(repoRoot, rule);
  const playwrightPass = visualResult.ok;

  if (!playwrightPass) {
    const fraudStrikes = visualResult.artifacts?.fraud
      ? nextFraudStrike(state.fraudStrikes)
      : Number(state.fraudStrikes || 0);
    if (state.wazaHuntDone && tier === 'large') {
      remediationCycle += 1;
    }
    writeState(stateFile, {
      diffSignature,
      locTotal: loc.total,
      tier,
      remediationCycle,
      telemetryWatermark: sinceId,
      playwrightPass: false,
      verificationDone: false,
      wazaHuntDone: state.wazaHuntDone && sameDiff ? state.wazaHuntDone : false,
      changedInScope,
      verificationRunDir: visualResult.artifacts?.runDir ?? null,
      fraudStrikes,
    });

    const blockReason = visualResult.artifacts?.fraud
      ? visualResult.artifacts.reason
      : buildChecklist({
          repoRoot,
          rule,
          changedInScope,
          loc,
          tier,
          visualResult,
          phase: 'playwright',
          remediationCycle,
          maxLoops: maxRemediationLoops,
        });

    if (remediationCycle > maxRemediationLoops) {
      return {
        continue: true,
        systemMessage:
          `agent-diff-completion-gate: Playwright still failing after ${maxRemediationLoops} remediation loops. ` +
          'The implementation has gone wrong — report what is broken, what you tried, and stop claiming done.',
      };
    }

    return block(runtime, blockReason);
  }

  // Step 2: verification-before-completion (after Playwright)
  const verificationDone = verificationSkillDetected(sessionId, sinceId, runtimeForTelemetry);
  if (!verificationDone) {
    writeState(stateFile, {
      diffSignature,
      locTotal: loc.total,
      tier,
      remediationCycle,
      telemetryWatermark: sinceId,
      playwrightPass: true,
      verificationDone: false,
      wazaHuntDone: false,
      changedInScope,
      verificationRunDir: visualResult.artifacts?.runDir ?? null,
    });

    return block(
      runtime,
      buildChecklist({
        repoRoot,
        rule,
        changedInScope,
        loc,
        tier,
        visualResult,
        phase: 'verification-before-completion',
        remediationCycle,
        maxLoops: maxRemediationLoops,
      }),
    );
  }

  // Step 3: waza-hunt for large diffs (after verification)
  if (tier === 'large') {
    const huntDone = wazaHuntDetected(sessionId, sinceId, runtimeForTelemetry);
    if (!huntDone) {
      writeState(stateFile, {
        diffSignature,
        locTotal: loc.total,
        tier,
        remediationCycle,
        telemetryWatermark: sinceId,
        playwrightPass: true,
        verificationDone: true,
        wazaHuntDone: false,
        changedInScope,
        verificationRunDir: visualResult.artifacts?.runDir ?? null,
      });

      return block(
        runtime,
        buildChecklist({
          repoRoot,
          rule,
          changedInScope,
          loc,
          tier,
          visualResult,
          phase: 'waza-hunt',
          remediationCycle,
          maxLoops: maxRemediationLoops,
        }),
      );
    }

    // Post-hunt: if remediation cycle active and playwright had failed before this pass, check limits
    if (remediationCycle > maxRemediationLoops) {
      return {
        continue: true,
        systemMessage:
          `agent-diff-completion-gate: ${maxRemediationLoops} remediation loops exhausted. ` +
          'Report that the implementation has gone wrong with hunt findings and remaining defects.',
      };
    }
  }

  writeState(stateFile, {
    diffSignature,
    locTotal: loc.total,
    tier,
    remediationCycle,
    telemetryWatermark: sinceId,
    playwrightPass: true,
    verificationDone: true,
    wazaHuntDone: tier === 'large',
    changedInScope,
    verificationRunDir: visualResult.artifacts?.runDir ?? null,
    complete: true,
  });

  const parts = [
    `agent-diff-completion-gate: all required steps complete (${tier} tier, ${loc.total} LOC).`,
    `Screenshots: ${visualResult.artifacts?.runDir}`,
    'Cite PNG paths and verification command output in your completion message.',
  ];
  if (tier === 'large') {
    parts.push(`waza-hunt required and detected. Remediation cycles used: ${remediationCycle}/${maxRemediationLoops}.`);
  }

  return { continue: true, systemMessage: parts.join(' ') };
}

function selfTest() {
  writeJson(
    evaluate(
      { cwd: 'E:/kai-chattr', session_id: 'self-test', hook_event_name: 'Stop' },
      hookRuntime(import.meta.url, {
        maxRemediationLoops: 3,
        locSmallMax: 500,
        locLargeMin: 501,
      }),
    ),
  );
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

try {
  writeJson(
    evaluate(
      readJsonStdin(),
      hookRuntime(import.meta.url, {
        maxRemediationLoops: 3,
        locSmallMax: 500,
        locLargeMin: 501,
      }),
    ),
  );
} catch (error) {
  writeJson({ continue: true, systemMessage: `agent-diff-completion-gate skipped: ${error.message}` });
}
