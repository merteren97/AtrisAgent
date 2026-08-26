import type { MissionStatus } from '@/stores/mission-store';

export type EffectiveTaskStatus = 'completed' | 'preparing' | 'running' | 'failed' | 'cancelled' | 'planned';

const ACTIVE_MISSION_STATUSES = new Set<MissionStatus>([
  'planning',
  'running',
  'waiting_for_approval',
  'reviewing',
  'revising',
  'applying',
  'verifying',
]);

const ATTENTION_STATUSES = new Set<MissionStatus>(['waiting_for_approval', 'blocked', 'failed']);
const QUEUED_STATUSES = new Set<MissionStatus>(['draft', 'ready']);
const OUTCOME_STATUSES = new Set<MissionStatus>(['completed', 'failed', 'cancelled']);
const CANCELLABLE_STATUSES = new Set<MissionStatus>([
  'draft', 'planning', 'ready', 'running', 'waiting_for_approval', 'blocked', 'reviewing', 'revising', 'applying', 'verifying',
]);
const RETRYABLE_TASK_STATUSES = new Set(['blocked', 'rejected', 'revision_requested']);

export type MissionStage = 'queue' | 'plan' | 'execute' | 'review' | 'attention' | 'outcome';

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
  if (status === 'draft' || status === 'ready') return 'queue';
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
