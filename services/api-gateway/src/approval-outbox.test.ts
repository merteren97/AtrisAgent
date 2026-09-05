import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ApprovalOutbox } from './approval-outbox';

const sqlite = new Database(':memory:');
sqlite.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE missions (id TEXT PRIMARY KEY);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT,
    run_id TEXT,
    type TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'pending',
    decided_by TEXT,
    requested_decision TEXT,
    claimed_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    execution_error TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE approval_operations (
    approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,
    status TEXT NOT NULL,
    operation_type TEXT NOT NULL DEFAULT 'approval',
    resource_id TEXT,
    idempotency_key TEXT,
    result TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    reconciled_at TEXT,
    reconcile_attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
`);
sqlite.prepare('INSERT INTO missions (id) VALUES (?)').run('mission-1');

const outbox = new ApprovalOutbox(sqlite);
const addApproval = (id: string) => sqlite.prepare(`INSERT INTO approvals
  (id, mission_id, type, description, status, created_at) VALUES (?, 'mission-1', 'apply', 'Apply changes', 'pending', ?)`)
  .run(id, new Date().toISOString());

addApproval('approval-1');
const claimed = outbox.claim('approval-1', 'approved');
assert.equal(claimed?.status, 'processing');
assert.equal(claimed?.operationId, 'approval-1');
assert.match(claimed?.idempotencyKey || '', /^approval:approval-1:1$/);
assert.equal(outbox.claim('approval-1', 'approved'), null, 'a second worker cannot claim the same approval');
assert.equal(outbox.getOperation('approval-1')?.status, 'applying');
assert.equal(outbox.finalize('approval-1', 'approved'), true);
assert.equal(outbox.getOperation('approval-1')?.status, 'completed');
assert.equal((sqlite.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-1') as { status: string }).status, 'approved');

addApproval('approval-2');
const failedClaim = outbox.claim('approval-2', 'approved');
assert.ok(failedClaim?.idempotencyKey);
outbox.fail('approval-2', new Error('external side effect interrupted'));
assert.equal(outbox.getOperation('approval-2')?.status, 'reconcile_required');
assert.equal((sqlite.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-2') as { status: string }).status, 'reconcile_required');
const notApplied = outbox.reconcile('approval-2', 'not_applied');
assert.equal(notApplied?.approval.status, 'pending');
const retriedClaim = outbox.claim('approval-2', 'approved');
assert.match(retriedClaim?.idempotencyKey || '', /^approval:approval-2:2$/);

addApproval('approval-3');
assert.ok(outbox.claim('approval-3', 'approved'));
outbox.recoverInterrupted();
assert.equal(outbox.getOperation('approval-3')?.status, 'reconcile_required');
assert.equal((sqlite.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-3') as { status: string }).status, 'reconcile_required');

sqlite.close();
console.log('[PASS] approval outbox claims, idempotency keys, crash recovery, and reconciliation atomically');
