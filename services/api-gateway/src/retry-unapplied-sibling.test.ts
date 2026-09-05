import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { claimUnappliedSiblingRetry } from './retry-unapplied-sibling';

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-retry-')));
  const staging = path.join(root, '.atris-worktrees', 'mission', 'builder');
  fs.mkdirSync(path.join(staging, '.atris-baseline'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'output.txt'), 'approved output');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE missions (id TEXT, plan_id TEXT, workspace_id TEXT, status TEXT, active_run_id TEXT, execution_mode TEXT, automation_policy TEXT, completed_at TEXT, updated_at TEXT);
    CREATE TABLE mission_events (mission_id TEXT, task_id TEXT, type TEXT, payload TEXT, sequence INTEGER);
    CREATE TABLE tasks (id TEXT, mission_id TEXT, plan_id TEXT, assigned_role TEXT, status TEXT, worktree_id TEXT);
    CREATE TABLE worktrees (task_id TEXT, isolation_kind TEXT, status TEXT, applied_operation_key TEXT, canonical_container TEXT, target_name TEXT, target_path TEXT, path TEXT);
    CREATE TABLE workspaces (id TEXT, path TEXT);
    CREATE TABLE apply_verification_operations (mission_id TEXT, plan_id TEXT);
    CREATE TABLE mission_runs (mission_id TEXT, status TEXT);
    CREATE TABLE mission_commands (mission_id TEXT, status TEXT);
    INSERT INTO missions VALUES ('mission', 'plan', 'workspace', 'blocked', NULL, 'autonomous', NULL, NULL, NULL);
    INSERT INTO tasks VALUES ('reviewer', 'mission', 'plan', 'reviewer', 'done', NULL), ('qa', 'mission', 'plan', 'qa', 'done', NULL);
    INSERT INTO mission_events VALUES ('mission', 'reviewer', 'review_completed', '{"approved":true}', 1), ('mission', 'qa', 'verification_completed', '{"passed":true}', 2);
  `);
  db.prepare('INSERT INTO mission_events VALUES (?, NULL, ?, ?, 3)').run('mission', 'mission_failed', JSON.stringify({ reason: 'New sibling apply metadata or idempotency key is missing.' }));
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)').run('builder', 'mission', 'plan', 'builder', 'done', staging);
  db.prepare('INSERT INTO workspaces VALUES (?, ?)').run('workspace', root);
  db.prepare('INSERT INTO worktrees VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run('builder', 'new-sibling', 'active', root, 'AtrisTask', path.join(root, 'AtrisTask'), staging);
  return { db, root, staging, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

{
  const f = fixture();
  try {
    let authorized = 0;
    assert.equal(claimUnappliedSiblingRetry(f.db, 'mission', () => { authorized++; }), true);
    assert.equal(claimUnappliedSiblingRetry(f.db, 'mission', () => { authorized++; }), false, 'one claimant per blocked plan');
    assert.equal(authorized, 1);
    assert.equal((f.db.prepare('SELECT status FROM missions').get() as any).status, 'applying');
    assert.equal(fs.existsSync(path.join(f.root, 'AtrisTask')), false, 'claim never copies or publishes by itself');
    assert.equal(fs.readFileSync(path.join(f.staging, 'output.txt'), 'utf8'), 'approved output');
  } finally { f.close(); }
}

const rejections: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['unpassed QA', (f) => { f.db.exec("UPDATE mission_events SET payload = '{\"passed\":false}' WHERE task_id = 'qa'"); }],
  ['missing QA', (f) => { f.db.exec("DELETE FROM tasks WHERE id = 'qa'"); }],
  ['incomplete Builder', (f) => { f.db.exec("UPDATE tasks SET status = 'running' WHERE id = 'builder'"); }],
  ['prior operation', (f) => { f.db.exec("INSERT INTO apply_verification_operations VALUES ('mission', 'plan')"); }],
  ['active run', (f) => { f.db.exec("INSERT INTO mission_runs VALUES ('mission', 'running')"); }],
  ['queued command', (f) => { f.db.exec("INSERT INTO mission_commands VALUES ('mission', 'pending')"); }],
  ['existing target', (f) => { fs.mkdirSync(path.join(f.root, 'atristask')); }],
  ['already applied', (f) => { f.db.exec("UPDATE worktrees SET applied_operation_key = 'existing'"); }],
  ['changed target', (f) => { f.db.exec("UPDATE worktrees SET target_path = 'elsewhere'"); }],
  ['changed staging', (f) => { f.db.exec("UPDATE tasks SET worktree_id = 'elsewhere' WHERE id = 'builder'"); }],
  ['old-plan approval', (f) => { f.db.exec("UPDATE tasks SET id = 'new-reviewer' WHERE id = 'reviewer'"); }],
];
for (const [name, mutate] of rejections) {
  const f = fixture();
  try {
    mutate(f);
    assert.throws(() => claimUnappliedSiblingRetry(f.db, 'mission', () => {}), Error, name);
    assert.equal((f.db.prepare('SELECT status FROM missions').get() as any).status, 'blocked', `${name}: no status mutation`);
  } finally { f.close(); }
}
{
  const f = fixture();
  try {
    assert.throws(() => claimUnappliedSiblingRetry(f.db, 'mission', () => { throw new Error('approval required'); }), /approval required/);
    assert.equal((f.db.prepare('SELECT status FROM missions').get() as any).status, 'blocked');
    f.db.exec("UPDATE mission_events SET payload = '{\"reason\":\"another failure\"}' WHERE type = 'mission_failed'");
    assert.equal(claimUnappliedSiblingRetry(f.db, 'mission', () => {}), false, 'unrelated failures are never replayed');
  } finally { f.close(); }
}
console.log('Unapplied sibling retry safety tests passed');
