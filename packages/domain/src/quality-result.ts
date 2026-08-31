export type QualityResultRole = 'reviewer' | 'qa';

/** Required machine-readable Reviewer/QA result for the normal production path. */
export interface QualityResultEnvelope {
  type: 'quality_result';
  version: 1;
  role: QualityResultRole;
  verdict: 'pass' | 'fail';
  summary: string;
  findings?: string[];
  evidence?: string[];
}

export interface PostApplyVerificationResult {
  passed: boolean;
  summary: string;
  evidence: string[];
}

export interface PostApplyVerificationContext {
  missionId: string;
  planId: string;
  runId?: string;
  builderTaskIds: string[];
}

export interface ApplyVerificationOperationContext extends PostApplyVerificationContext {
  operationId: string;
  idempotencyKey: string;
}

export interface ApplyVerificationOperationResult extends PostApplyVerificationResult {
  operationId: string;
  appliedTaskIds: string[];
}
