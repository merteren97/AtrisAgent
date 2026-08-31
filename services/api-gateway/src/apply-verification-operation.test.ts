import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ApplyVerificationOperationStore, executeApplyVerificationOperation } from './apply-verification-operation';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE apply_verification_operations (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, plan_id TEXT NOT NULL, run_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE, apply_phase TEXT NOT NULL, verification_phase TEXT NOT NULL,
    builder_task_ids TEXT NOT NULL, applied_task_ids TEXT NOT NULL, verification_passed INTEGER,
    summary TEXT, evidence TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    UNIQUE(mission_id, plan_id));`);
  return db;
}

async function main(): Promise<void> {
  const context = { missionId: 'mission', planId: 'plan', runId: 'run', builderTaskIds: ['builder'] };
  {
    const db = database();
    const store = new ApplyVerificationOperationStore(db);
    let applies = 0;
    let verifies = 0;
    const execute = () => executeApplyVerificationOperation(store, context,
      async () => { applies += 1; return { success: true }; },
      async () => { verifies += 1; return { passed: true, summary: 'passed', evidence: ['check'] }; });
    const first = await execute();
    const duplicate = await execute();
    assert.equal(first.operationId, duplicate.operationId);
    assert.equal(applies, 1, 'duplicate retry never reapplies');
    assert.equal(verifies, 1, 'completed verification is idempotent');
    db.close();
  }
  {
    const db = database();
    const store = new ApplyVerificationOperationStore(db);
    const operation = store.ensure(context);
    assert.equal(store.claimApply(operation.operationId), true);
    store.recoverInterrupted();
    let applies = 0;
    await assert.rejects(() => executeApplyVerificationOperation(store, context,
      async () => { applies += 1; return { success: true }; }, async () => ({ passed: true, summary: 'x', evidence: ['x'] })), /reconciliation/);
    assert.equal(applies, 0, 'apply-before-record crash is blocked and never replayed');
    db.close();
  }
  {
    const db = database();
    const store = new ApplyVerificationOperationStore(db);
    const operation = store.ensure(context);
    assert(store.claimApply(operation.operationId));
    store.recordApplied(operation.operationId, ['builder']);
    assert.equal(store.claimVerification(operation.operationId), true);
    assert.equal(store.claimVerification(operation.operationId), false, 'verification has one atomic claimant');
    store.recoverInterrupted();
    assert.equal(store.claimVerification(operation.operationId), true, 'restart converts running verification to retryable blocked');
    db.close();
  }
  console.log('apply-verification-operation tests passed');
}

void main();
