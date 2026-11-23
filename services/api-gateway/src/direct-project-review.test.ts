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

test('conversation-scoped review ignores pre-existing Git diff, aggregates multi-tab edits, clears on approve/delete, and safely undoes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-direct-conv-test-'));
  const project = path.join(root, 'project'), data = path.join(root, 'data');
  fs.mkdirSync(project); fs.mkdirSync(data);
  const db = new Database(path.join(data, 'test.db'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL)');
  db.prepare('INSERT INTO workspaces VALUES (?,?)').run('project', project);
  const runGit = (...args: string[]) => execFileSync('git', args, { cwd: project, windowsHide: true });
  runGit('init', '-q');
  fs.writeFileSync(path.join(project, 'dirty.ts'), 'pre-existing dirty\n');
  runGit('add', 'dirty.ts');
  fs.writeFileSync(path.join(project, 'dirty.ts'), 'dirty working tree\n');
  fs.writeFileSync(path.join(project, 'untracked.ts'), 'untracked before chat\n');

  let activeAttribution: { conversationId: string; agentId?: string } | undefined;
  const review = new DirectProjectReview(db, data, id => id === 'project' ? project : undefined, () => activeAttribution);
  try {
    await review.ready('project');
    // Brand-new conversation must show 0 files even with pre-existing dirty/untracked Git files.
    assert.deepEqual((await review.listForConversation('project', 'conv-a', true)).files, []);
    assert.deepEqual((await review.listForConversation('project', 'conv-b', true)).files, []);

    // External/human edit while no conversation is active must not pollute any chat.
    fs.writeFileSync(path.join(project, 'human.ts'), 'human edit\n');
    assert.deepEqual((await review.listForConversation('project', 'conv-a', true)).files, []);

    // Tab 1 and Tab 2 inside conv-a both edit dirty.ts (and Tab 2 adds tab2.ts).
    activeAttribution = { conversationId: 'conv-a', agentId: 'tab-1' };
    fs.writeFileSync(path.join(project, 'dirty.ts'), 'tab 1 edit\n');
    await review.listForConversation('project', 'conv-a', true);
    activeAttribution = { conversationId: 'conv-a', agentId: 'tab-2' };
    fs.writeFileSync(path.join(project, 'dirty.ts'), 'tab 2 edit\n');
    fs.writeFileSync(path.join(project, 'tab2.ts'), 'created by tab 2\n');

    const convAList = await review.listForConversation('project', 'conv-a', true);
    assert.deepEqual(convAList.files.map(f => f.path), ['dirty.ts', 'tab2.ts']);
    // Sibling conversation conv-b still sees 0 changes.
    assert.deepEqual((await review.listForConversation('project', 'conv-b', true)).files, []);

    // Preview for dirty.ts shows original pre-conversation dirty bytes -> latest tab 2 bytes.
    const dirtyEntry = convAList.files.find(f => f.path === 'dirty.ts')!;
    assert.deepEqual(
      await review.previewForConversation('project', 'conv-a', 'dirty.ts', dirtyEntry.revision),
      { before: 'dirty working tree\n', after: 'tab 2 edit\n' },
    );

    // Undo dirty.ts restores pre-conversation dirty bytes (NOT git HEAD) and clears it from conv-a.
    assert.deepEqual(
      await review.resolveForConversation('project', 'conv-a', 'undo', [dirtyEntry]),
      { completed: ['dirty.ts'], conflicts: [] },
    );
    assert.equal(fs.readFileSync(path.join(project, 'dirty.ts'), 'utf8'), 'dirty working tree\n');
    assert.deepEqual((await review.listForConversation('project', 'conv-a', true)).files.map(f => f.path), ['tab2.ts']);

    // Approve tab2.ts keeps file on disk and clears it from conv-a.
    const tab2Entry = (await review.listForConversation('project', 'conv-a', false)).files[0];
    assert.deepEqual(
      await review.resolveForConversation('project', 'conv-a', 'approve', [tab2Entry]),
      { completed: ['tab2.ts'], conflicts: [] },
    );
    assert.equal(fs.readFileSync(path.join(project, 'tab2.ts'), 'utf8'), 'created by tab 2\n');
    assert.deepEqual((await review.listForConversation('project', 'conv-a', false)).files, []);

    // Delete conversation clears pending tracked changes like Approve while keeping files on disk.
    activeAttribution = { conversationId: 'conv-b', agentId: 'b-tab-1' };
    fs.writeFileSync(path.join(project, 'from-b.ts'), 'keep after delete\n');
    assert.deepEqual((await review.listForConversation('project', 'conv-b', true)).files.map(f => f.path), ['from-b.ts']);
    review.clearConversation('conv-b');
    assert.deepEqual((await review.listForConversation('project', 'conv-b', false)).files, []);
    assert.equal(fs.readFileSync(path.join(project, 'from-b.ts'), 'utf8'), 'keep after delete\n');
  } finally {
    await review.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
