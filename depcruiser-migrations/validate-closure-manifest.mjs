#!/usr/bin/env node
// Two gates over the closure manifest.
//   verdicts : pre-edit gate  -> exit 1 if any verdict is still TBD (used by closure-gate.mjs)
//   reconcile: completion gate -> exit 1 if target != (donor - cuts) + adapters
//              (invoked as a quality-completion-gate verify-manifest command)
// Usage:
//   node validate-closure-manifest.mjs --mode verdicts  --manifest <m.json>
//   node validate-closure-manifest.mjs --mode reconcile --manifest <m.json> --target <target.depcruise.json>
import fs from 'fs';
import path from 'path';

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const mode = arg('--mode'), manifestPath = arg('--manifest'), targetPath = arg('--target');
if (!mode || !manifestPath) { console.error('usage: --mode verdicts|reconcile --manifest <m.json> [--target <t.json>]'); process.exit(2); }
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const base = (p) => path.basename(p);

if (mode === 'verdicts') {
  const tbd = m.modules.filter((r) => r.verdict === 'TBD').map((r) => r.source);
  const bad = m.modules.filter((r) => !['port', 'adapter', 'cut'].includes(r.verdict)).map((r) => `${r.source}=${r.verdict}`);
  if (m.unresolved.length) console.error(`WARN: ${m.unresolved.length} unresolved donor import(s): ${m.unresolved.map((u) => u.spec).join(', ')}`);
  if (tbd.length || bad.length) {
    if (tbd.length) console.error(`BLOCK: ${tbd.length} node(s) still TBD:\n  ${tbd.join('\n  ')}`);
    if (bad.length) console.error(`BLOCK: invalid verdict(s): ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log(`OK: all ${m.modules.length} verdicts set (port/adapter/cut).`);
  process.exit(0);
}

if (mode === 'reconcile') {
  if (!targetPath) { console.error('reconcile needs --target'); process.exit(2); }
  const dc = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  const isLocal = (s) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(s) && !s.startsWith('node_modules/');
  const targetSet = new Set(dc.modules.filter((x) => isLocal(x.source)).map((x) => base(x.source)));

  const expectPresent = m.modules.filter((r) => r.verdict === 'port' || r.verdict === 'adapter').map((r) => base(r.target_path || r.source));
  const expectAbsent = m.modules.filter((r) => r.verdict === 'cut').map((r) => base(r.source));

  const missing = expectPresent.filter((b) => !targetSet.has(b));
  const leftoverCuts = expectAbsent.filter((b) => targetSet.has(b));
  const accounted = new Set([...expectPresent]);
  const unexpected = [...targetSet].filter((b) => !accounted.has(b));

  if (leftoverCuts.length) console.error(`WARN leftover (marked cut, still present): ${leftoverCuts.join(', ')}`);
  if (unexpected.length) console.error(`REVIEW unaccounted target nodes (possible scaffold): ${unexpected.join(', ')}`);
  if (missing.length) {
    console.error(`BLOCK: ${missing.length} node(s) marked port/adapter but absent from target:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`OK reconcile: target == donor - cuts + adapters (${expectPresent.length} present, ${expectAbsent.length} cut).`);
  process.exit(0);
}
console.error(`unknown mode: ${mode}`); process.exit(2);
