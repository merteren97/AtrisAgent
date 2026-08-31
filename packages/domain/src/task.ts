import type { AgentRole } from './agent';
import type { CanonicalReasoning } from './model-profile';
import type { RouteSelectionMode, RoutingPreferenceSource } from './execution-policy';

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
  effectiveRoute?: EffectiveAttemptRoute | null;
}

export interface EffectiveAttemptRoute {
  adapterId: string;
  provider?: string | null;
  accountProfileId?: string | null;
  modelCatalogId?: string | null;
  runtimeModelId?: string | null;
  reasoningLevel?: CanonicalReasoning | null;
  source: RoutingPreferenceSource;
  selectionMode: RouteSelectionMode;
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
  routeAdapterId?: string | null;
  routeProvider?: string | null;
  routeAccountProfileId?: string | null;
  routeModelCatalogId?: string | null;
  routeRuntimeModelId?: string | null;
  routeReasoningLevel?: CanonicalReasoning | null;
  routeSource?: RoutingPreferenceSource | null;
  routeSelectionMode?: RouteSelectionMode | null;
  providerSessionId?: string | null;
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
