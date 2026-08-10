import type { MissionStatus } from '@/stores/mission-store';

export type EffectiveTaskStatus = 'completed' | 'running' | 'failed' | 'cancelled' | 'planned';

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

export function effectiveTaskStatus(taskStatus: string, missionStatus: MissionStatus): EffectiveTaskStatus {
  if (taskStatus === 'completed' || taskStatus === 'done') return 'completed';
  if (taskStatus === 'failed' || taskStatus === 'blocked') return 'failed';
  if (missionStatus === 'cancelled') return 'cancelled';
  if (taskStatus === 'running') return 'running';
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
