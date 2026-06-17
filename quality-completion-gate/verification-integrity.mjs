import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const VERIFICATION_FRAUD_BLOCK_HEADER = 'VERIFICATION FRAUD — STOP BLOCKED';

export const VERIFICATION_FRAUD_POLICY_TEXT = [
  'Fabricating verification is fraud — not a shortcut, not "dev smoke," not "good enough for the gate."',
  'That includes: Playwright API mocks/intercepts, citing PNGs from non-live runs, running mocked snapshot scripts as completion proof, or claiming verified/passing/done while the real stack is still broken.',
  '',
  'Consequences when you participate in this behavior:',
  '  1. Stop is blocked immediately — you cannot complete the turn with fraudulent evidence.',
  '  2. A fraud strike is recorded for this session (visible on the next Stop).',
  '  3. At 3 strikes: treat the session as integrity-violated — report honestly to the user what was faked and what remains broken; do NOT claim done or ask them to restart so you can mock again.',
  '',
  'Required instead: live verification only (run.json must contain liveApi:true). Restart dev servers after runtime changes yourself. Fix the real API/session/page — do not bypass.',
].join('\n');

export function isFraudulentVerificationCommand(command) {
  const text = String(command || '');
  if (!text.trim()) return false;
  if (/\bui-snapshot-live\.mjs\b/i.test(text)) return false;
  if (/\bverify-platform-visual-manifest-live\.mjs\b/i.test(text)) return false;
  if (/\bui-snapshot-route-live\.mjs\b/i.test(text)) return false;
  if (/\bui-snapshot-route\.mjs\b/i.test(text)) return true;
  if (/\bui-snapshot\.mjs\b/i.test(text)) return true;
  if (/\bpage\.route\s*\(/i.test(text)) return true;
  if (/\broute\.fulfill\s*\(/i.test(text) && /\bapi\//i.test(text)) return true;
  return false;
}

export function verificationFraudBlock(specificReason, strike = null) {
  const lines = [VERIFICATION_FRAUD_BLOCK_HEADER, '', VERIFICATION_FRAUD_POLICY_TEXT, '', specificReason];
  if (strike != null && Number.isFinite(strike)) {
    lines.push(
      '',
      `Session fraud strike: ${strike}/3.`,
      strike >= 3
        ? 'LIMIT REACHED — stop claiming verification. Report what was fabricated and what is still broken.'
        : 'Another fraudulent verification attempt will increment this counter.',
    );
  }
  return lines.join('\n');
}

export function readRunMeta(repoRoot, runDirRel) {
  const runMetaPath = join(repoRoot, runDirRel, 'run.json');
  if (!existsSync(runMetaPath)) {
    return { ok: false, reason: 'missing run.json', path: runMetaPath };
  }
  try {
    const meta = JSON.parse(readFileSync(runMetaPath, 'utf8'));
    if (meta.liveApi !== true) {
      return {
        ok: false,
        reason:
          `Verification folder ${runDirRel} is NOT live (run.json liveApi !== true). ` +
          'Mocked or synthetic runs cannot be cited as proof.',
        meta,
      };
    }
    if (meta.frontendLogin !== true) {
      return {
        ok: false,
        reason:
          `Verification folder ${runDirRel} did not use frontend /login (run.json frontendLogin !== true). ` +
          'Token-injected runs cannot be cited as proof.',
        meta,
      };
    }
    return { ok: true, meta };
  } catch {
    return { ok: false, reason: `Unreadable run.json in ${runDirRel}` };
  }
}

export function findRecentNonLiveVerificationRuns(repoRoot, verificationDir = 'docs/verification', maxAgeMs = 86_400_000) {
  const root = join(repoRoot, verificationDir);
  if (!existsSync(root)) return [];

  const now = Date.now();
  const hits = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const runDirRel = `${verificationDir}/${name.name}`.replaceAll('\\', '/');
    const abs = join(root, name.name);
    let ageMs = Infinity;
    try {
      ageMs = now - statSync(abs).mtimeMs;
    } catch {
      // ignore
    }
    if (ageMs > maxAgeMs) continue;
    const check = readRunMeta(repoRoot, runDirRel);
    if (!check.ok) {
      hits.push({ runDir: runDirRel, reason: check.reason, meta: check.meta ?? null });
    }
  }
  return hits.sort((a, b) => b.runDir.localeCompare(a.runDir));
}

export function detectFraudulentVerificationInTelemetry(dbPath, sessionId, sinceId = 0) {
  if (!existsSync(dbPath) || !sessionId) return { fraudulent: false, matches: [] };

  try {
    const raw = execFileSync(
      process.env.HOOKS_PYTHON || 'python',
      [
        '-c',
        `
import json, sqlite3, sys, re
db, session_id, since_id = sys.argv[1], sys.argv[2], int(sys.argv[3])
patterns = [
  re.compile(r"ui-snapshot-route\\.mjs", re.I),
  re.compile(r"ui-snapshot\\.mjs", re.I),
]
allow = re.compile(r"ui-snapshot-live\\.mjs|verify-platform-visual-manifest-live\\.mjs|ui-snapshot-route-live\\.mjs", re.I)
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute(
  "SELECT id, tool_name, target, detail FROM hook_events WHERE session_id=? AND id>? AND hook_id='hook-telemetry' ORDER BY id DESC LIMIT 400",
  (session_id, since_id),
).fetchall()
con.close()
matches = []
for row_id, tool_name, target, detail in rows:
  blob = " ".join(str(x or "") for x in (tool_name, target, detail))
  if allow.search(blob):
    continue
  for pat in patterns:
    if pat.search(blob):
      matches.append({"id": row_id, "tool_name": tool_name, "target": target, "detail": (detail or "")[:240]})
      break
print(json.dumps({"fraudulent": bool(matches), "matches": matches[:8]}))
`,
        dbPath,
        sessionId,
        String(sinceId || 0),
      ],
      { encoding: 'utf8', timeout: 8000 },
    ).trim();
    return JSON.parse(raw || '{"fraudulent":false,"matches":[]}');
  } catch {
    return { fraudulent: false, matches: [] };
  }
}

export function nextFraudStrike(current) {
  return Math.min(3, Number(current || 0) + 1);
}
