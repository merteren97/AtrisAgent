import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DELETION_PHASES, DeletionOperationStore, type DeletionHandlers } from './deletion-operation';

function database(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE deletion_operations (
    id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, remove_memory INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'stop', status TEXT NOT NULL DEFAULT 'pending', manifest TEXT NOT NULL DEFAULT '[]',
    progress TEXT NOT NULL DEFAULT '{}', error TEXT, owner_token TEXT, lease_expires_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
    CREATE UNIQUE INDEX idx_deletion_operations_target ON deletion_operations(target_type, target_id);`);
  return sqlite;
}

function handlers(calls: string[], fail?: string): DeletionHandlers {
  return Object.fromEntries(DELETION_PHASES.map((phase) => [phase, async () => {
    calls.push(phase);
    if (phase === fail) throw new Error(`injected:${phase}`);
  }])) as unknown as DeletionHandlers;
}

for (const phase of DELETION_PHASES) {
  const sqlite = database();
  const store = new DeletionOperationStore(sqlite);
  const operation = store.begin('mission', `fault-${phase}`, false, ['mission:test']);
  const failed = await store.execute(operation, handlers([], phase));
  assert.equal(failed.status, 'retryable', `${phase} failure remains retryable`);
  assert.equal(failed.phase, phase, `${phase} cursor is durable`);
  const resumedCalls: string[] = [];
  const completed = await new DeletionOperationStore(sqlite).execute(failed, handlers(resumedCalls));
  assert.equal(completed.status, 'completed', `${phase} resumes to completion`);
  assert.equal(resumedCalls[0], phase, `${phase} is safely replayed after its uncommitted side effect`);
  sqlite.close();
}

{
  const sqlite = database();
  const firstStore = new DeletionOperationStore(sqlite);
  const operation = firstStore.begin('workspace', 'restart', true, Array.from({ length: 300 }, (_, index) => `resource:${index}`));
  sqlite.prepare("UPDATE deletion_operations SET status = 'running', owner_token = 'dead-owner' WHERE id = ?").run(operation.id);
  const restarted = new DeletionOperationStore(sqlite);
  restarted.recoverInterrupted();
  const recovered = restarted.get('workspace', 'restart')!;
  assert.equal(recovered.status, 'retryable');
  assert.equal(recovered.manifest.length, 256, 'resource manifest is bounded');
  assert.equal((await restarted.execute(recovered, handlers([]))).status, 'completed', 'restart recovery resumes incomplete work');
  sqlite.close();
}

{
  const sqlite = database();
  const store = new DeletionOperationStore(sqlite);
  const first = store.begin('mission', 'concurrent', false, []);
  const repeated = store.begin('mission', 'concurrent', true, []);
  assert.equal(repeated.id, first.id, 'concurrent DELETE owns one operation');
  assert.equal(repeated.removeMemory, false, 'first CAS owner fixes deletion choices');
  sqlite.prepare("UPDATE deletion_operations SET status = 'running', owner_token = 'other' WHERE id = ?").run(first.id);
  assert.equal((await store.execute(first, handlers([]))).status, 'running', 'a concurrent runner cannot steal an active phase');
  sqlite.close();
}

console.log('[PASS] deletion operation faults, restart recovery, bounded manifests, and concurrent CAS ownership');
