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
  const operation = store.begin('mission', 'lost-owner', false, []);
  sqlite.exec(`CREATE TRIGGER steal_phase_owner AFTER UPDATE OF phase ON deletion_operations
    WHEN NEW.phase = 'runtime' BEGIN
      UPDATE deletion_operations SET owner_token = 'replacement-owner',
        lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = NEW.id;
    END;`);
  const calls: string[] = [];
  const lost = await store.execute(operation, handlers(calls));
  assert.equal(lost.status, 'running', 'lost owner does not report a false completion');
  assert.equal(lost.phase, 'runtime', 'lost owner leaves the next phase for its replacement');
  assert.deepEqual(calls, ['stop'], 'lost owner cannot execute a phase after its CAS is replaced');
  const resumedCalls: string[] = [];
  const resumed = await store.execute(lost, handlers(resumedCalls));
  assert.equal(resumed.status, 'completed', 'replacement owner safely resumes the operation');
  assert.equal(resumedCalls[0], 'runtime', 'replacement resumes at the durable next phase');
  sqlite.close();
}

{
  const sqlite = database();
  const store = new DeletionOperationStore(sqlite);
  const operation = store.begin('mission', 'safe-error', false, []);
  sqlite.prepare("UPDATE deletion_operations SET status = 'running', owner_token = 'other-owner' WHERE id = ?").run(operation.id);
  store.markRetryable(operation.id, new Error('stale runner failure'));
  assert.equal(store.get('mission', 'safe-error')?.status, 'running', 'unexpected failure cannot clobber another owner');
  sqlite.close();
}

{
  const sqlite = database();
  const store = new DeletionOperationStore(sqlite, 20);
  const operation = store.begin('mission', 'expired-lease', false, []);
  sqlite.prepare(`UPDATE deletion_operations SET status = 'running', owner_token = 'expired-owner',
    lease_expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1).toISOString(), operation.id);
  const calls: string[] = [];
  const recovered = await store.execute(store.get('mission', 'expired-lease')!, handlers(calls));
  assert.equal(recovered.status, 'completed', 'expired leases are reclaimed safely');
  assert.equal(calls[0], 'stop', 'expired lease resumes at its durable phase');
  sqlite.close();
}

{
  const sqlite = database();
  const store = new DeletionOperationStore(sqlite, 100);
  const operation = store.begin('mission', 'heartbeat', false, []);
  let calls = 0;
  const delayedHandlers = Object.fromEntries(DELETION_PHASES.map((phase) => [phase, async () => {
    calls++;
    if (phase === 'stop') await new Promise((resolve) => setTimeout(resolve, 300));
  }])) as unknown as DeletionHandlers;
  const running = store.execute(operation, delayedHandlers);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const concurrent = await store.execute(store.get('mission', 'heartbeat')!, delayedHandlers);
  assert(['running', 'completed'].includes(concurrent.status), 'heartbeat keeps a long-running phase owned');
  await running;
  assert.equal(calls, DELETION_PHASES.length, 'long-running phase is not duplicated after lease renewal');
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
