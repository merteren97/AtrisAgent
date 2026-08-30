import type BetterSqlite3 from 'better-sqlite3';

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalReconcileOutcome = 'applied' | 'not_applied';

export interface ClaimedApproval {
  id: string;
  missionId: string;
  taskId: string | null;
  runId: string | null;
  type: string;
  description: string;
  status: 'processing';
  requestedDecision: ApprovalDecision;
  claimedAt: string;
  operationId: string;
  operationType: string;
  resourceId: string;
  idempotencyKey: string;
}

interface ApprovalRow {
  id: string;
  mission_id: string;
  task_id: string | null;
  run_id: string | null;
  type: string;
  description: string;
  status: string;
  attempt_count: number;
}

interface OperationRow {
  approval_id: string;
  decision: ApprovalDecision;
  status: 'applying' | 'completed' | 'reconcile_required';
  operation_type: string;
  resource_id: string | null;
  idempotency_key: string | null;
  result: string | null;
  started_at: string;
  completed_at: string | null;
  reconciled_at: string | null;
  reconcile_attempts: number;
  error: string | null;
}

interface RunResult {
  changes: number;
}

/**
 * Durable approval state machine. The claim and operation record are committed
 * together so a restart can never leave an approval looking executable without
 * a corresponding idempotency key and reconciliation record.
 */
export class ApprovalOutbox {
  constructor(private readonly sqlite: BetterSqlite3.Database) {}

  claim(approvalId: string, decision: ApprovalDecision): ClaimedApproval | null {
    return this.sqlite.transaction(() => {
      const approval = this.sqlite.prepare(
        'SELECT id, mission_id, task_id, run_id, type, description, status, attempt_count FROM approvals WHERE id = ?',
      ).get(approvalId) as ApprovalRow | undefined;
      if (!approval || approval.status !== 'pending') return null;

      const claimedAt = new Date().toISOString();
      const update = this.sqlite.prepare(`UPDATE approvals SET status = 'processing', requested_decision = ?, claimed_at = ?,
        attempt_count = attempt_count + 1, execution_error = NULL WHERE id = ? AND status = 'pending'`)
        .run(decision, claimedAt, approvalId) as RunResult;
      if (update.changes !== 1) return null;

      const attempt = Number(approval.attempt_count || 0) + 1;
      const idempotencyKey = `approval:${approvalId}:${attempt}`;
      const operationType = approvalId.includes(':') ? 'runtime_approval' : 'orchestrator_approval';
      const resourceId = approval.task_id || approval.mission_id;
      this.sqlite.prepare(`INSERT INTO approval_operations
        (approval_id, decision, status, operation_type, resource_id, idempotency_key, result, started_at,
         completed_at, reconciled_at, reconcile_attempts, error)
        VALUES (?, ?, 'applying', ?, ?, ?, NULL, ?, NULL, NULL, 0, NULL)
        ON CONFLICT(approval_id) DO UPDATE SET decision = excluded.decision, status = 'applying',
          operation_type = excluded.operation_type, resource_id = excluded.resource_id,
          idempotency_key = excluded.idempotency_key, result = NULL, started_at = excluded.started_at,
          completed_at = NULL, reconciled_at = NULL, reconcile_attempts = 0, error = NULL`)
        .run(approvalId, decision, operationType, resourceId, idempotencyKey, claimedAt);

      return {
        id: approval.id,
        missionId: approval.mission_id,
        taskId: approval.task_id,
        runId: approval.run_id,
        type: approval.type,
        description: approval.description,
        status: 'processing' as const,
        requestedDecision: decision,
        claimedAt,
        operationId: approvalId,
        operationType,
        resourceId,
        idempotencyKey,
      };
    })();
  }

  finalize(approvalId: string, decision: ApprovalDecision): boolean {
    return this.sqlite.transaction(() => {
      const completedAt = new Date().toISOString();
      const operation = this.sqlite.prepare(`UPDATE approval_operations SET status = 'completed', completed_at = ?, error = NULL,
        result = ? WHERE approval_id = ? AND decision = ? AND status = 'applying'`)
        .run(
          completedAt,
          JSON.stringify({ outcome: 'applied', decision }),
          approvalId,
          decision,
        ) as RunResult;
      if (operation.changes !== 1) return false;

      const approval = this.sqlite.prepare(`UPDATE approvals SET status = ?, decided_by = 'user', decided_at = ?, execution_error = NULL
        WHERE id = ? AND status = 'processing' AND requested_decision = ?`)
        .run(decision, completedAt, approvalId, decision) as RunResult;
      if (approval.changes !== 1) throw new Error('Approval finalization lost its claim.');
      return true;
    })();
  }

  fail(approvalId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`UPDATE approval_operations SET status = 'reconcile_required', error = ?, reconciled_at = NULL,
        reconcile_attempts = reconcile_attempts + 1 WHERE approval_id = ? AND status = 'applying'`)
        .run(message, approvalId);
      this.sqlite.prepare(`UPDATE approvals SET status = 'reconcile_required', execution_error = ?, decided_at = NULL
        WHERE id = ? AND status = 'processing'`).run(message, approvalId);
    })();
  }

  reconcile(approvalId: string, outcome: ApprovalReconcileOutcome): { approval: Record<string, unknown>; operation: Record<string, unknown> } | null {
    return this.sqlite.transaction(() => {
      const approval = this.sqlite.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown> | undefined;
      const operation = this.sqlite.prepare(
        "SELECT * FROM approval_operations WHERE approval_id = ? AND status = 'reconcile_required'",
      ).get(approvalId) as OperationRow | undefined;
      if (!approval || !operation) return null;

      const reconciledAt = new Date().toISOString();
      const result = JSON.stringify({ outcome, decision: operation.decision, reconciledManually: true });
      const operationUpdate = this.sqlite.prepare(`UPDATE approval_operations SET status = 'completed', result = ?,
        reconciled_at = ?, completed_at = COALESCE(completed_at, ?), error = NULL
        WHERE approval_id = ? AND status = 'reconcile_required'`)
        .run(result, reconciledAt, reconciledAt, approvalId) as RunResult;
      if (operationUpdate.changes !== 1) return null;

      if (outcome === 'not_applied') {
        this.sqlite.prepare(`UPDATE approvals SET status = 'pending', requested_decision = NULL, claimed_at = NULL,
          execution_error = NULL, decided_at = NULL WHERE id = ? AND status = 'reconcile_required'`).run(approvalId);
      } else {
        const status = operation.decision === 'approved' ? 'approved' : 'rejected';
        this.sqlite.prepare(`UPDATE approvals SET status = ?, decided_by = 'user', decided_at = ?,
          execution_error = NULL WHERE id = ? AND status = 'reconcile_required'`).run(status, reconciledAt, approvalId);
      }

      const updated = this.sqlite.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown>;
      return {
        approval: updated,
        operation: { ...operation, status: 'completed', result, reconciled_at: reconciledAt },
      };
    })();
  }

  /** Mark all in-flight operations unresolved before any queue work resumes. */
  recoverInterrupted(): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`UPDATE approval_operations SET status = 'reconcile_required',
        error = COALESCE(error, 'Gateway restarted before approval side effect could be confirmed'),
        reconcile_attempts = reconcile_attempts + 1 WHERE status = 'applying'`).run();
      this.sqlite.prepare(`UPDATE approvals SET status = 'reconcile_required', decided_at = NULL,
        execution_error = COALESCE(execution_error, 'Approval outcome requires reconciliation after restart')
        WHERE status = 'processing' OR id IN (
          SELECT approval_id FROM approval_operations WHERE status = 'reconcile_required'
        )`).run();
    })();
  }

  getOperation(approvalId: string): OperationRow | undefined {
    return this.sqlite.prepare('SELECT * FROM approval_operations WHERE approval_id = ?').get(approvalId) as OperationRow | undefined;
  }
}
