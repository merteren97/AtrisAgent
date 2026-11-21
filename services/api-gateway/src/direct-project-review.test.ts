import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { DirectProjectReview } from './direct-project-review';

async function fixture(run: (review: DirectProjectReview, project: string, data: string, db: Database.Database, fence: () => void) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-direct-test-'));
  const project = path.join(root, 'project'), data = path.join(root, 'data');
  fs.mkdirSync(project); fs.mkdirSync(data);
  const db = new Database(path.join(data, 'test.db'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL)');
  db.prepare('INSERT INTO workspaces VALUES (?,?)').run('project', project);
  let fenced = false;
  const review = new DirectProjectReview(db, data, id => id === 'project' && !fenced ? project : undefined);
  try { await run(review, project, data, db, () => { fenced = true; }); }
  finally { await review.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('approval only marks the revision; approved files can be restored after restart to their dirty starting bytes', () => fixture(async (review, project, data, db) => {
  const filename = path.join(project, 'login.ts');
  fs.writeFileSync(filename, 'saved before agent\r\n');
  await review.ready('project');
  fs.writeFileSync(filename, 'agent saved directly\r\n');
  const change = (await review.list('project', true)).files[0];
  assert.equal(change.state, 'pending');
  assert.deepEqual(await review.preview('project', change.path, change.revision), { before: 'saved before agent\r\n', after: 'agent saved directly\r\n' });
  const beforeApproval = fs.statSync(filename, { bigint: true }).mtimeNs;
  assert.deepEqual(await review.resolve('project', 'approve', [change]), { completed: ['login.ts'], conflicts: [] });
  assert.equal(fs.statSync(filename, { bigint: true }).mtimeNs, beforeApproval);
  assert.equal((await review.preview('project', change.path, change.revision) as {after: string}).after, 'agent saved directly\r\n');
  await review.close();
  const reopened = new DirectProjectReview(db, data, () => project);
  try {
    assert.equal((await reopened.list('project', true)).files[0].state, 'approved');
    assert.deepEqual(await reopened.resolve('project', 'undo', [change]), { completed: ['login.ts'], conflicts: [] });
    assert.equal(fs.readFileSync(path.join(project, 'login.ts'), 'utf8'), 'saved before agent\r\n');
    assert.equal((await reopened.list('project', true)).files[0].state, 'reverted');
  } finally { await reopened.close(); }
}));

test('undo is partial by file, rejects stale saves and supports added and deleted files', () => fixture(async (review, project, _data, _db, fence) => {
  const a = path.join(project, 'a.ts'), b = path.join(project, 'b.ts'), c = path.join(project, 'c.ts');
  fs.writeFileSync(a, 'old a'); fs.writeFileSync(b, 'old b');
  await review.ready('project');
  fs.writeFileSync(a, 'agent'); fs.unlinkSync(b); fs.writeFileSync(c, 'new c');
  const snapshot = await review.list('project', true);
  assert.deepEqual(snapshot.files.map(item => item.status), ['modified', 'deleted', 'added']);
  fs.writeFileSync(a, 'human');
  const undo = await review.resolve('project', 'undo', snapshot.files);
  assert.deepEqual(undo.completed, ['b.ts', 'c.ts']);
  assert.equal(undo.conflicts[0].path, 'a.ts');
  assert.equal(fs.readFileSync(a, 'utf8'), 'human');
  assert.equal(fs.readFileSync(b, 'utf8'), 'old b');
  assert.equal(fs.existsSync(c), false);
  const latest = (await review.list('project', true)).files.find(item => item.path === 'a.ts')!;
  assert.notEqual(latest.revision, snapshot.files[0].revision);
  assert.equal((await review.resolve('project', 'approve', [snapshot.files[0]])).conflicts.length, 1);
  fence();
  await assert.rejects(review.resolve('project', 'undo', [latest]), /no longer available/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'human');
}));

test('shows pre-existing Git changes without making them undoable or touching the index', () => fixture(async (review, project) => {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: project, windowsHide: true });
  run('init', '-q');
  fs.writeFileSync(path.join(project, 'stage.ts'), 'staged');
  run('add', 'stage.ts');
  fs.writeFileSync(path.join(project, 'stage.ts'), 'working tree');
  const index = fs.readFileSync(path.join(project, '.git', 'index'));
  const copy = await review.list('project', true);
  assert.ok(copy.files.some(file => file.path === 'stage.ts' && !file.restorable));
  assert.deepEqual(fs.readFileSync(path.join(project, '.git', 'index')), index);
}));

test('undoing a later edit reveals the preceding approved version', () => fixture(async (review, project) => {
  const filename = path.join(project, 'main.ts');
  fs.writeFileSync(filename, 'starting version');
  await review.ready('project');
  fs.writeFileSync(filename, 'approved version');
  const first = (await review.list('project', true)).files[0];
  await review.resolve('project', 'approve', [first]);
  fs.writeFileSync(filename, 'another save');
  const second = (await review.list('project', true)).files[0];
  assert.equal(second.state, 'pending');
  assert.deepEqual((await review.resolve('project', 'undo', [second])).completed, ['main.ts']);
  const visible = (await review.list('project', true)).files[0];
  assert.equal(visible.revision, first.revision);
  assert.equal(visible.state, 'approved');
  assert.deepEqual((await review.resolve('project', 'undo', [visible])).completed, ['main.ts']);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'starting version');
}));
