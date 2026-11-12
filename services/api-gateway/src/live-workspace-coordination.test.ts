import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveWorkspaceCoordination } from './live-workspace-coordination';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coordination-test-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coordination-other-'));
try {
  let now = 0;
  const live = new LiveWorkspaceCoordination(() => now);
  const a = live.join(root, 'a', 'Agent A', 'codex');
  const b = live.join(root, 'b', 'Agent B', 'claude');
  const c = live.join(other, 'c', 'Agent C', 'codex');
  const [claim] = live.claim('a', a, ['src'], 'edit');
  assert.throws(() => live.claim('b', b, ['other', 'src/file.ts'], 'edit'), /conflict/);
  assert.equal(live.snapshot(root).claims.length, 1, 'conflicting batches are atomic');
  assert.throws(() => live.claim('b', b, ['../outside'], 'edit'), /inside the workspace/);
  fs.symlinkSync(other, path.join(root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => live.claim('b', b, ['external-link/file.ts'], 'edit'), /inside the workspace/);
  live.claim('c', c, ['src/file.ts'], 'edit');
  live.send('a', a, 'hello', 'b');
  assert.equal(live.read('b', b)[0].body, 'hello');
  assert.equal(live.read('b', b).length, 0);
  assert.throws(() => live.send('a', a, 'no', 'c'), /workspace/);
  assert.equal(live.clear(other, claim.id), false);
  assert.equal(live.clear(root, claim.id), true);
  live.claim('b', b, ['src/file.ts'], 'edit');
  now = 90_001;
  assert.equal(live.snapshot(root).claims.length, 0);
  assert.throws(() => live.heartbeat('b', b), /expired/);
  const replacement = live.join(root, 'b', 'B', 'claude');
  assert.throws(() => live.claim('b', b, ['x'], ''), /expired/);
  live.claim('b', replacement, ['x'], 'edit');
  live.leave('b', replacement);
  assert.equal(live.snapshot(root).claims.length, 0);
  console.log('Live workspace coordination passed');
} finally {
  fs.rmSync(root, {recursive:true, force:true});
  fs.rmSync(other, {recursive:true, force:true});
}
