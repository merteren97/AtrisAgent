import type {
  ApplyVerificationOperationContext,
  ApplyVerificationOperationResult,
  PostApplyVerificationResult,
} from '@atris-agent-code/domain';

const MAX_SUMMARY_CHARS = 4_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_CHARS = 16_384;

interface OperationRow {
  id: string;
  apply_phase: 'pending' | 'in_progress' | 'applied' | 'blocked';
  verification_phase: 'pending' | 'running' | 'blocked' | 'completed';
  applied_task_ids: string;
  verification_passed: number | null;
  summary: string | null;
  evidence: string | null;
  error: string | null;
}

function boundedResult(result: PostApplyVerificationResult): PostApplyVerificationResult {
  const summary = String(result.summary || '').slice(0, MAX_SUMMARY_CHARS);
  const evidence: string[] = [];
  let remaining = MAX_EVIDENCE_CHARS;
  for (const value of Array.isArray(result.evidence) ? result.evidence.slice(0, MAX_EVIDENCE_ITEMS) : []) {
    const item = String(value).slice(0, remaining);
    if (!item) continue;
    evidence.push(item);
    remaining -= item.length;
    if (remaining <= 0) break;
  }
  return { passed: result.passed === true, summary, evidence };
}

export class ApplyVerificationOperationStore {
  constructor(private readonly sqlite: any) {}

  get(missionId: string, planId: string): OperationRow | null {
    return this.sqlite.prepare(`SELECT id, apply_phase, verification_phase, applied_task_ids,
      verification_passed, summary, evidence, error FROM apply_verification_operations
      WHERE mission_id = ? AND plan_id = ?`).get(missionId, planId) as OperationRow | undefined || null;
  }

  ensure(context: Omit<ApplyVerificationOperationContext, 'operationId' | 'idempotencyKey'>): ApplyVerificationOperationContext {
    const operationId = `apply-verify:${context.missionId}:${context.planId}`;
    const idempotencyKey = operationId;
    const now = new Date().toISOString();
    this.sqlite.prepare(`INSERT OR IGNORE INTO apply_verification_operations
      (id, mission_id, plan_id, run_id, idempotency_key, apply_phase, verification_phase,
       builder_task_ids, applied_task_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, '[]', ?, ?)`)
      .run(operationId, context.missionId, context.planId, context.runId || null, idempotencyKey,
        JSON.stringify(context.builderTaskIds), now, now);
    return { ...context, operationId, idempotencyKey };
  }

  claimApply(operationId: string): boolean {
    return this.sqlite.prepare(`UPDATE apply_verification_operations SET apply_phase = 'in_progress',
      updated_at = ? WHERE id = ? AND apply_phase = 'pending'`)
      .run(new Date().toISOString(), operationId).changes === 1;
  }

  recordApplied(operationId: string, taskIds: string[]): void {
    this.sqlite.prepare(`UPDATE apply_verification_operations SET apply_phase = 'applied',
      applied_task_ids = ?, verification_phase = 'pending', error = NULL, updated_at = ?
      WHERE id = ? AND apply_phase = 'in_progress'`)
      .run(JSON.stringify(taskIds), new Date().toISOString(), operationId);
  }

  blockApply(operationId: string, error: unknown): void {
    this.sqlite.prepare(`UPDATE apply_verification_operations SET apply_phase = 'blocked', error = ?, updated_at = ?
      WHERE id = ? AND apply_phase = 'in_progress'`)
      .run(String(error instanceof Error ? error.message : error).slice(0, MAX_SUMMARY_CHARS), new Date().toISOString(), operationId);
  }

  claimVerification(operationId: string): boolean {
    return this.sqlite.prepare(`UPDATE apply_verification_operations SET verification_phase = 'running',
      error = NULL, updated_at = ? WHERE id = ? AND apply_phase = 'applied'
      AND verification_phase IN ('pending', 'blocked')`)
      .run(new Date().toISOString(), operationId).changes === 1;
  }

  finishVerification(operationId: string, raw: PostApplyVerificationResult): PostApplyVerificationResult {
    const result = boundedResult(raw);
    const now = new Date().toISOString();
    this.sqlite.prepare(`UPDATE apply_verification_operations SET verification_phase = ?, verification_passed = ?,
      summary = ?, evidence = ?, error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND verification_phase = 'running'`)
      .run(result.passed ? 'completed' : 'blocked', result.passed ? 1 : 0, result.summary,
        JSON.stringify(result.evidence), result.passed ? null : result.summary, now, result.passed ? now : null, operationId);
    return result;
  }

  recoverInterrupted(): void {
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`UPDATE apply_verification_operations SET apply_phase = 'blocked', updated_at = ?,
        error = COALESCE(error, 'Gateway restarted during apply; external state requires reconciliation')
        WHERE apply_phase = 'in_progress'`).run(now);
      this.sqlite.prepare(`UPDATE apply_verification_operations SET verification_phase = 'blocked', updated_at = ?,
        error = COALESCE(error, 'Gateway restarted during verification; retry is safe')
        WHERE verification_phase = 'running'`).run(now);
    })();
  }

}

export async function executeApplyVerificationOperation(
  store: ApplyVerificationOperationStore,
  context: Omit<ApplyVerificationOperationContext, 'operationId' | 'idempotencyKey'>,
  apply: (taskId: string, operation: { operationId: string; idempotencyKey: string }) => Promise<{ success: boolean; output?: string }>,
  verify: (context: ApplyVerificationOperationContext) => Promise<PostApplyVerificationResult>,
): Promise<ApplyVerificationOperationResult> {
  const operation = store.ensure(context);
  let row = store.get(context.missionId, context.planId)!;
  if (row.apply_phase === 'blocked') throw new Error(row.error || 'Apply operation requires explicit reconciliation.');
  if (row.apply_phase === 'pending') {
    if (!store.claimApply(operation.operationId)) throw new Error('Apply operation is already claimed.');
    const applied: string[] = [];
    try {
      for (const taskId of context.builderTaskIds) {
        const result = await apply(taskId, { operationId: operation.operationId, idempotencyKey: `${operation.idempotencyKey}:task:${taskId}` });
        if (!result.success) throw new Error(result.output || `Applying task ${taskId} failed.`);
        applied.push(taskId);
      }
      store.recordApplied(operation.operationId, applied);
    } catch (error) {
      store.blockApply(operation.operationId, error);
      throw error;
    }
    row = store.get(context.missionId, context.planId)!;
  }
  if (row.apply_phase !== 'applied') throw new Error('Apply operation is in progress and cannot be replayed.');
  if (row.verification_phase === 'completed') {
    return { operationId: row.id, appliedTaskIds: JSON.parse(row.applied_task_ids), passed: row.verification_passed === 1,
      summary: row.summary || '', evidence: row.evidence ? JSON.parse(row.evidence) : [] };
  }
  if (!store.claimVerification(operation.operationId)) throw new Error('Verification operation is already claimed.');
  let verified: PostApplyVerificationResult;
  try { verified = await verify(operation); }
  catch (error) { verified = { passed: false, summary: String(error instanceof Error ? error.message : error), evidence: [] }; }
  const result = store.finishVerification(operation.operationId, verified);
  return { ...result, operationId: operation.operationId, appliedTaskIds: JSON.parse(store.get(context.missionId, context.planId)!.applied_task_ids) };
}
