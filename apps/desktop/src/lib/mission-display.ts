import type { MissionStatus } from '@/stores/mission-store';

export type EffectiveTaskStatus = 'completed' | 'preparing' | 'running' | 'failed' | 'cancelled' | 'planned';

const ACTIVE_MISSION_STATUSES = new Set<MissionStatus>([
  'planning',
  'running',
  'revising',
  'applying',
  'verifying',
]);

export function isMissionActive(status: MissionStatus): boolean {
  return ACTIVE_MISSION_STATUSES.has(status);
}

export function isMissionCancelled(status: MissionStatus): boolean {
  return status === 'cancelled';
}

export function effectiveTaskStatus(
  taskStatus: string,
  missionStatus: MissionStatus,
  assignedAgentId?: string | null,
): EffectiveTaskStatus {
  if (taskStatus === 'completed' || taskStatus === 'done' || taskStatus === 'verified' || taskStatus === 'applied') return 'completed';
  if (taskStatus === 'failed' || taskStatus === 'blocked' || taskStatus === 'rejected') return 'failed';
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
