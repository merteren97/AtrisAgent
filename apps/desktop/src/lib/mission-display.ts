import type { MissionStatus, TimelineItem } from '@/stores/mission-store';

export type EffectiveTaskStatus = 'completed' | 'preparing' | 'running' | 'failed' | 'cancelled' | 'planned';

const ACTIVE_MISSION_STATUSES = new Set<MissionStatus>([
  'starting',
  'planning',
  'running',
  'waiting_for_approval',
  'reviewing',
  'revising',
  'applying',
  'verifying',
]);

const ATTENTION_STATUSES = new Set<MissionStatus>(['waiting_for_approval', 'blocked', 'failed']);
const QUEUED_STATUSES = new Set<MissionStatus>(['draft', 'queued', 'ready']);
const OUTCOME_STATUSES = new Set<MissionStatus>(['completed', 'failed', 'cancelled']);
const CANCELLABLE_STATUSES = new Set<MissionStatus>([
  'draft', 'queued', 'starting', 'planning', 'ready', 'running', 'waiting_for_approval', 'blocked', 'reviewing', 'revising', 'applying', 'verifying',
]);
const RETRYABLE_TASK_STATUSES = new Set(['blocked', 'rejected', 'revision_requested']);

export type MissionStage = 'queue' | 'plan' | 'execute' | 'review' | 'attention' | 'outcome';

export type MissionPresentationState = 'starting' | 'queued' | 'planning' | 'running' | 'review' | 'attention' | 'completed' | 'failed' | 'cancelled';

export interface MissionLifecycleProjection {
  state: MissionPresentationState;
  label: string;
  description: string;
  stage: MissionStage;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  isPending: boolean;
  isTerminal: boolean;
}

export type MissionErrorStage = 'provider' | 'authentication' | 'model' | 'network' | 'orchestrator' | 'runtime' | 'unknown';

export interface MissionErrorProjection {
  stage: MissionErrorStage;
  stageLabel: string;
  message: string;
  action: string;
  code?: string;
}

export function isMissionActive(status: MissionStatus): boolean {
  return ACTIVE_MISSION_STATUSES.has(status);
}

export function isMissionCancelled(status: MissionStatus): boolean {
  return status === 'cancelled';
}

export function needsMissionAttention(status: MissionStatus): boolean {
  return ATTENTION_STATUSES.has(status);
}

export function isMissionQueued(status: MissionStatus): boolean {
  return QUEUED_STATUSES.has(status);
}

export function isMissionOutcome(status: MissionStatus): boolean {
  return OUTCOME_STATUSES.has(status);
}

export function isMissionCancellable(status: MissionStatus): boolean {
  return CANCELLABLE_STATUSES.has(status);
}

export function canRetryMission(status: MissionStatus, taskStatuses: string[]): boolean {
  return (status === 'blocked' || status === 'failed') && taskStatuses.some((taskStatus) => RETRYABLE_TASK_STATUSES.has(taskStatus));
}

export function missionActivityTimestamp(mission: { createdAt: string; updatedAt?: string; completedAt?: string | null }): string {
  return mission.completedAt || mission.updatedAt || mission.createdAt;
}

export function missionStage(status: MissionStatus): MissionStage {
  if (status === 'draft' || status === 'queued' || status === 'ready' || status === 'starting') return 'queue';
  if (status === 'planning') return 'plan';
  if (status === 'running' || status === 'revising' || status === 'applying') return 'execute';
  if (status === 'reviewing' || status === 'verifying') return 'review';
  if (status === 'waiting_for_approval' || status === 'blocked') return 'attention';
  return 'outcome';
}

export function effectiveTaskStatus(
  taskStatus: string,
  missionStatus: MissionStatus,
  assignedAgentId?: string | null,
): EffectiveTaskStatus {
  if (taskStatus === 'completed' || taskStatus === 'done' || taskStatus === 'verified' || taskStatus === 'applied') return 'completed';
  if (taskStatus === 'failed' || taskStatus === 'blocked' || taskStatus === 'rejected') return 'failed';
  if (taskStatus === 'cancelled') return 'cancelled';
  if (missionStatus === 'cancelled') return 'cancelled';
  if (taskStatus === 'running') return assignedAgentId ? 'running' : 'preparing';
  if (taskStatus === 'ready' || taskStatus === 'claimed' || taskStatus === 'revision_requested' || taskStatus === 'review') return 'preparing';
  return 'planned';
}

export function missionStatusLabel(status: MissionStatus): string {
  switch (status) {
    case 'starting': return 'Starting';
    case 'queued': return 'Queued';
    case 'waiting_for_approval': return 'Waiting for approval';
    case 'completed': return 'Completed';
    case 'cancelled': return 'Cancelled';
    case 'failed': return 'Failed';
    case 'blocked': return 'Blocked';
    case 'reviewing': return 'Reviewing';
    case 'revising': return 'Revising';
    case 'applying': return 'Applying';
    case 'verifying': return 'Verifying';
    case 'planning': return 'Planning';
    case 'ready': return 'Ready';
    case 'running': return 'Running';
    default: return 'Draft';
  }
}

export function projectMissionLifecycle(
  status: MissionStatus,
  options: { pending?: boolean } = {},
): MissionLifecycleProjection {
  if (options.pending || status === 'starting') {
    return {
      state: 'starting',
      label: 'Starting',
      description: 'The request was accepted and the provider is being prepared.',
      stage: 'queue',
      tone: 'info',
      isPending: true,
      isTerminal: false,
    };
  }

  if (status === 'draft' || status === 'ready' || status === 'queued') {
    return {
      state: 'queued',
      label: missionStatusLabel(status),
      description: 'The mission is waiting to begin.',
      stage: 'queue',
      tone: 'neutral',
      isPending: false,
      isTerminal: false,
    };
  }

  if (status === 'planning') {
    return {
      state: 'planning',
      label: 'Planning',
      description: 'The orchestrator is preparing the mission plan.',
      stage: 'plan',
      tone: 'info',
      isPending: true,
      isTerminal: false,
    };
  }

  if (status === 'running' || status === 'revising' || status === 'applying') {
    return {
      state: 'running',
      label: missionStatusLabel(status),
      description: 'The mission is executing its current plan.',
      stage: 'execute',
      tone: 'info',
      isPending: false,
      isTerminal: false,
    };
  }

  if (status === 'reviewing' || status === 'verifying') {
    return {
      state: 'review',
      label: missionStatusLabel(status),
      description: 'The mission is checking the work and its results.',
      stage: 'review',
      tone: 'warning',
      isPending: true,
      isTerminal: false,
    };
  }

  if (status === 'waiting_for_approval' || status === 'blocked') {
    return {
      state: 'attention',
      label: missionStatusLabel(status),
      description: status === 'blocked' ? 'The mission needs attention before it can continue.' : 'The mission is waiting for an approval decision.',
      stage: 'attention',
      tone: 'warning',
      isPending: false,
      isTerminal: false,
    };
  }

  if (status === 'failed') {
    return {
      state: 'failed',
      label: 'Failed',
      description: 'The mission stopped with an error. Review the runtime details and retry when ready.',
      stage: 'outcome',
      tone: 'danger',
      isPending: false,
      isTerminal: true,
    };
  }

  if (status === 'completed') {
    return {
      state: 'completed',
      label: 'Completed',
      description: 'The mission completed successfully.',
      stage: 'outcome',
      tone: 'success',
      isPending: false,
      isTerminal: true,
    };
  }

  return {
    state: 'cancelled',
    label: 'Cancelled',
    description: 'The mission was cancelled.',
    stage: 'outcome',
    tone: 'neutral',
    isPending: false,
    isTerminal: true,
  };
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorPayload(error: unknown): { message?: string; details?: Record<string, unknown> } {
  if (error instanceof Error) {
    const details = error as Error & { details?: unknown };
    return {
      message: error.message,
      details: details.details && typeof details.details === 'object' ? details.details as Record<string, unknown> : undefined,
    };
  }
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const details = value.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : value;
    return {
      message: textValue(value.message) || textValue(value.error) || textValue(details.error),
      details,
    };
  }
  return {};
}

function classifyMissionError(stage: string | undefined, message: string): MissionErrorStage {
  const normalized = `${stage || ''} ${message}`.toLowerCase();
  if (/auth|login|credential|sign.?in|reauth/.test(normalized)) return 'authentication';
  if (/model|catalog|route|unknown model|no model/.test(normalized)) return 'model';
  if (/network|fetch|connection|timeout|timed out|service unavailable/.test(normalized)) return 'network';
  if (/provider|antigravity|agy/.test(normalized)) return 'provider';
  if (/orchestrator|supervisor|planning/.test(normalized)) return 'orchestrator';
  if (/runtime|process|spawn|cli|executable/.test(normalized)) return 'runtime';
  return 'unknown';
}

function errorStageLabel(stage: MissionErrorStage): string {
  switch (stage) {
    case 'provider': return 'Provider';
    case 'authentication': return 'Authentication';
    case 'model': return 'Model';
    case 'network': return 'Connection';
    case 'orchestrator': return 'Orchestrator';
    case 'runtime': return 'Runtime';
    default: return 'Mission';
  }
}

function errorAction(stage: MissionErrorStage): string {
  switch (stage) {
    case 'provider': return 'Check AGY installation and authentication, then retry.';
    case 'authentication': return 'Reconnect the provider account, then retry.';
    case 'model': return 'Refresh the model catalog or choose another model.';
    case 'network': return 'Check the local service connection and retry.';
    case 'orchestrator': return 'Refresh mission state and retry.';
    case 'runtime': return 'Check provider runtime diagnostics and retry.';
    default: return 'Refresh mission state and retry.';
  }
}

export function projectMissionError(error: unknown, timeline: TimelineItem[] = []): MissionErrorProjection | null {
  let payload = errorPayload(error);
  if (!payload.message) {
    const latest = [...timeline].reverse().find((item) => (
      item.eventType === 'mission_failed'
      || item.eventType === 'process_failed'
      || item.eventType === 'task_failed'
      || item.eventType === 'agent_error'
      || item.eventType === 'runtime_error'
    ));
    if (latest) payload = errorPayload({ message: latest.content, details: latest.metadata });
  }
  if (!payload.message) return null;

  const details = payload.details || {};
  const explicitStage = textValue(details.stage) || textValue(details.errorStage) || textValue(details.providerStage);
  const stage = classifyMissionError(explicitStage, payload.message);
  const code = textValue(details.code) || textValue(details.errorCode);
  return {
    stage,
    stageLabel: errorStageLabel(stage),
    message: payload.message,
    action: textValue(details.action) || errorAction(stage),
    ...(code ? { code } : {}),
  };
}
