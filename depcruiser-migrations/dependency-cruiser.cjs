// Per-target-repo dependency-cruiser config for the closure completion checks.
// Copy into the target repo root (or point the verify-manifest command at this path with --config).
// Runs as a quality-completion-gate verify command; the default reporter exits non-zero on
// any error-severity rule, which is what the exit-code gate keys on.
module.exports = {
  forbidden: [
    { name: 'no-circular',     severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-unresolvable', severity: 'error', from: {}, to: { couldNotResolve: true } },
    // migration scaffold ban — point at the donor/lookalike the target must not import:
    { name: 'no-old-scaffold', severity: 'error', from: {}, to: { path: '(ReferencePrototype|legacy/old-app)' } }
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },   // resolves #/ and @/ aliases
    tsPreCompilationDeps: true,                // keeps type-only edges in the closure
    doNotFollow: { path: 'node_modules' }      // npm shown as boundary, not traversed
  }
};
