import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { LiveProjectChanges, liveGitBase, liveUndoSelection, type LiveScope } from './live-project-changes';

const eventually = async (predicate: () => boolean) => {
  for (let tries = 0; tries < 100; tries++) { if (predicate()) return; await sleep(35); }
  assert.ok(predicate(), 'Expected the watcher to deliver the changed files');
};

async function fixture(run: (directory: string, scope: LiveScope, db: Database.Database, service: LiveProjectChanges) => Promise<void>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-project-')));
  const scope: LiveScope = { id: 'manual:chat', kind: 'manual', owner: 'chat', workspaceId: 'ws',
    target: path.join(directory, 'project'), source: path.join(directory, 'source'), baseline: path.join(directory, 'baseline') };
  for (const root of [scope.target, scope.source, scope.baseline]) {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'edit.ts'), 'original\n');
    fs.writeFileSync(path.join(root, 'delete.ts'), 'restore me\n');
  }
  const db = new Database(path.join(directory, 'state.db'));
  const service = new LiveProjectChanges(db);
  try { await run(directory, scope, db, service); }
  finally { await service.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

test('automatically publishes edits, additions and deletions; undo works after process restart', () => fixture(async (_dir, scope, db, service) => {
  service.start(scope);
  fs.writeFileSync(path.join(scope.source, 'edit.ts'), 'agent edit\n');
  fs.writeFileSync(path.join(scope.source, 'new.ts'), 'new file\n');
  fs.unlinkSync(path.join(scope.source, 'delete.ts'));
  await eventually(() => service.list(scope.id)?.files.length === 3);
  assert.equal(fs.readFileSync(path.join(scope.target, 'edit.ts'), 'utf8'), 'agent edit\n');
  assert.equal(fs.readFileSync(path.join(scope.target, 'new.ts'), 'utf8'), 'new file\n');
  assert.ok(!fs.existsSync(path.join(scope.target, 'delete.ts')));
  await service.close();

  const restored = new LiveProjectChanges(db);
  try {
    restored.resume();
    const selection = restored.list(scope.id)!.files;
    const edit = selection.find(item => item.path === 'edit.ts')!;
    assert.deepEqual(restored.preview(scope.id, edit.path, edit.revision), { before: 'original\n', after: 'agent edit\n' });
    assert.equal(restored.undo(scope.id, selection).completed.length, 3);
    assert.equal(fs.readFileSync(path.join(scope.target, 'edit.ts'), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(path.join(scope.target, 'delete.ts'), 'utf8'), 'restore me\n');
    assert.ok(!fs.existsSync(path.join(scope.target, 'new.ts')));
    fs.writeFileSync(path.join(scope.source, 'edit.ts'), 'same agent continued editing\n');
    fs.writeFileSync(path.join(scope.source, 'another.ts'), 'other file still publishes\n');
    await eventually(() => fs.existsSync(path.join(scope.target, 'another.ts')));
    assert.equal(fs.readFileSync(path.join(scope.target, 'edit.ts'), 'utf8'), 'original\n');
  } finally { await restored.close(); }
}));

test('preserves later editor changes, rejects stale revisions, and undo is partial per file', () => fixture(async (_dir, scope, _db, service) => {
  service.start(scope);
  fs.writeFileSync(path.join(scope.target, 'edit.ts'), 'editor started first\n');
  fs.writeFileSync(path.join(scope.source, 'edit.ts'), 'agent first attempt\n');
  fs.writeFileSync(path.join(scope.source, 'one.ts'), 'first\n');
  fs.writeFileSync(path.join(scope.source, 'two.ts'), 'untouched\n');
  await eventually(() => service.list(scope.id)?.files.length === 3);
  assert.equal(service.list(scope.id)?.files.find(item => item.path === 'edit.ts')?.state, 'conflict');
  assert.equal(fs.readFileSync(path.join(scope.target, 'edit.ts'), 'utf8'), 'editor started first\n');
  const first = service.list(scope.id)!.files.find(item => item.path === 'one.ts')!;
  fs.writeFileSync(path.join(scope.source, 'one.ts'), 'second\n');
  await eventually(() => service.list(scope.id)?.files.some(item => item.path === 'one.ts' && item.revision !== first.revision) ?? false);
  assert.equal(service.undo(scope.id, [first]).conflicts.length, 1);
  fs.writeFileSync(path.join(scope.target, 'one.ts'), 'editor changed it later\n');
  const result = service.undo(scope.id, service.list(scope.id)!.files.filter(item => item.revision));
  assert.deepEqual(result.completed, ['two.ts']);
  assert.equal(result.conflicts[0].path, 'one.ts');
  assert.equal(fs.readFileSync(path.join(scope.target, 'one.ts'), 'utf8'), 'editor changed it later\n');
  assert.throws(() => liveUndoSelection([{ path: '../outside', revision: first.revision }]), /Invalid file revision/);
}));

test('Git Builders publish only worktree changes; failed verification does not revert or change Git state', () => fixture(async (dir, fixtureScope, _db, service) => {
  const target = fixtureScope.target;
  const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  runGit(target, 'init');
  fs.writeFileSync(path.join(target, '.gitignore'), '*.tmp\n');
  runGit(target, 'add', '.');
  runGit(target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Fixture base');
  const base = runGit(target, 'rev-parse', 'HEAD');
  const source = path.join(dir, 'builder');
  runGit(target, 'worktree', 'add', '--detach', source);
  const gitDirectory = runGit(source, 'rev-parse', '--absolute-git-dir');
  fs.writeFileSync(path.join(gitDirectory, 'atris-review-base'), `${base}\n`);
  const scope: LiveScope = { ...fixtureScope, id: 'builder:task', kind: 'builder', owner: 'mission', source, baseline: source, gitBase: await liveGitBase(source) };
  service.start(scope);
  fs.writeFileSync(path.join(source, 'edit.ts'), 'unverified code\n');
  fs.writeFileSync(path.join(source, 'ignored.tmp'), 'ignore this');
  await eventually(() => service.list(scope.id)?.files.length === 1);
  await service.finalize(scope.id);
  service.quality(scope.id, 'failed');
  assert.equal(service.list(scope.id)?.quality, 'failed');
  assert.equal(fs.readFileSync(path.join(target, 'edit.ts'), 'utf8'), 'unverified code\n');
  assert.ok(!fs.existsSync(path.join(target, 'ignored.tmp')));
  assert.equal(runGit(target, 'rev-parse', 'HEAD'), base);
  assert.equal(runGit(target, 'diff', '--cached', '--name-only'), '');
  assert.deepEqual(service.undo(scope.id, service.list(scope.id)!.files).completed, ['edit.ts']);
  assert.equal(fs.readFileSync(path.join(target, 'edit.ts'), 'utf8'), 'original\n');
}));
