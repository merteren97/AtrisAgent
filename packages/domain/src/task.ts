import type { AgentRole } from './agent';

export type TaskStatus =
  | 'planned'
  | 'ready'
  | 'claimed'
  | 'running'
  | 'review'
  | 'revision_requested'
  | 'blocked'
  | 'verified'
  | 'applied'
  | 'done'
  | 'rejected'
  | 'cancelled'
  | 'superseded';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  missionId: string;
  planId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  assignedRole: AgentRole | null;
  requiredCapabilities: string[];
  dependsOn: string[]; // task IDs
  worktreeId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  missionId: string;
  agentInstanceId: string;
  attemptNumber: number;
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'reviewing' | 'verified' | 'applied';
  worktreePath?: string | null;
  runtimeSessionId?: string | null;
  heartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
  retryable: boolean;
  claimedAt: string;
  startedAt: string;
  completedAt?: string | null;
  error?: string | null;
  resultSummary?: string | null;
  reviewPack?: Record<string, unknown> | null;
}
