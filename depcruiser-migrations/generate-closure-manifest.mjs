#!/usr/bin/env node
// Generate a closure manifest from a dependency-cruiser donor trace.
// Usage: node generate-closure-manifest.mjs <donor.depcruise.json> <out.manifest.json> [--entry <src/path>]
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const inPath = args[0], outPath = args[1];
const entryArg = (() => { const i = args.indexOf('--entry'); return i > -1 ? args[i + 1] : null; })();
if (!inPath || !outPath) { console.error('usage: generate-closure-manifest <donor.depcruise.json> <out.manifest.json> [--entry <path>]'); process.exit(2); }

const dc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const isLocal = (s) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(s) && !s.startsWith('node_modules/');

const importedBy = {}, edgeKind = {}, dependsOn = {};
const dynamicEdges = [], typeOnlyEdges = [], unresolved = [], external = new Set();

for (const m of dc.modules) {
  if (!isLocal(m.source)) continue;
  dependsOn[m.source] = [];
  for (const dep of m.dependencies) {
    if (dep.couldNotResolve) { unresolved.push({ from: m.source, spec: dep.resolved }); continue; }
    if (dep.dependencyTypes.includes('npm')) { external.add(dep.resolved.replace(/^node_modules\//, '').split('/')[0]); continue; }
    if (!isLocal(dep.resolved)) continue;
    dependsOn[m.source].push(dep.resolved);
    (importedBy[dep.resolved] ??= []).push(m.source);
    const kind = dep.dynamic ? 'dynamic' : dep.dependencyTypes.includes('type-only') ? 'type-only' : 'value';
    (edgeKind[dep.resolved] ??= new Set()).add(kind);
    if (dep.dynamic) dynamicEdges.push([m.source, dep.resolved]);
    if (dep.dependencyTypes.includes('type-only')) typeOnlyEdges.push([m.source, dep.resolved]);
  }
}

const local = Object.keys(dependsOn);
const entry = entryArg || local.find((s) => !(importedBy[s]?.length)) || local[0];

const order = [], placed = new Set();
while (order.length < local.length) {
  const next = local.filter((s) => !placed.has(s) && dependsOn[s].every((d) => placed.has(d)));
  if (!next.length) { order.push(...local.filter((s) => !placed.has(s))); break; }
  next.forEach((s) => { order.push(s); placed.add(s); });
}

const manifest = {
  donor_entry: entry,
  generated_from: path.basename(inPath),
  generated_at: new Date().toISOString(),
  node_count: local.length,
  port_order: order,
  external_deps: [...external],
  unresolved,
  dynamic_edges: dynamicEdges,
  type_only_edges: typeOnlyEdges,
  modules: local.map((s) => ({
    source: s,
    imported_by: importedBy[s] || [],
    reachable_via: [...(edgeKind[s] || ['(entry)'])],
    depends_on: dependsOn[s],
    verdict: 'TBD',        // port | adapter | cut   <- worker fills this
    target_path: null      // worker fills for port/adapter (enables reconcile)
  }))
};
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`manifest: ${local.length} nodes, ${unresolved.length} unresolved, entry=${entry} -> ${outPath}`);
