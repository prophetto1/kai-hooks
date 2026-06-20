import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyMode,
  isMutatingTool,
  parseExplicitMode,
  repoRootForCwd,
  statePath,
  telemetryHighWatermark,
} from './task-mode-core.mjs';

assert.equal(parseExplicitMode('mode: refactor\nExtract module'), 'refactor');
assert.equal(classifyMode('code review this PR'), 'review');
assert.equal(classifyMode('fix the failing websocket test'), 'fix');
assert.equal(classifyMode('how does auth work'), 'explore');
assert.equal(isMutatingTool('Read'), false);
assert.equal(isMutatingTool('Write'), true);

const root = mkdtempSync(join(tmpdir(), 'task-mode-core-'));
try {
  execFileSync('git', ['-C', root, 'init'], { stdio: 'ignore' });
  mkdirSync(join(root, 'packages', 'app'), { recursive: true });
  assert.equal(repoRootForCwd(join(root, 'packages', 'app')), root.replaceAll('\\', '/'));
  assert.equal(
    statePath({ stateDir: join(root, '.state') }, 'session-1', repoRootForCwd(join(root, 'packages', 'app'))),
    statePath({ stateDir: join(root, '.state') }, 'session-1', repoRootForCwd(root)),
    'task-mode state must be keyed by canonical repo root, not raw cwd',
  );

  const db = join(root, 'hooks.db');
  execFileSync(process.env.HOOKS_PYTHON || 'python', [
    '-c',
    `
import sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(db)
con.execute("CREATE TABLE hook_events(id INTEGER PRIMARY KEY, session_id TEXT)")
con.execute("INSERT INTO hook_events(id, session_id) VALUES(7, 'session-1')")
con.execute("INSERT INTO hook_events(id, session_id) VALUES(11, 'other-session')")
con.commit()
con.close()
`,
    db,
  ]);
  assert.equal(
    telemetryHighWatermark('session-1', { shared: { paths: { hooksDb: db } } }),
    7,
    'task-mode prompt state must start after existing same-session telemetry',
  );
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
}

console.log('task-mode-core tests passed');
