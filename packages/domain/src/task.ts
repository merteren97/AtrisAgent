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

export type BuilderTargetDescriptor =
  | { kind: 'workspace_root' }
  | { kind: 'existing_project'; projectName: string }
  | { kind: 'new_sibling_project'; projectName: string };

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validateDirectChildProjectName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Project target name is required.');
  if (value !== value.trim()) throw new Error('Project target name cannot have leading or trailing whitespace.');
  if (value === '.' || value === '..') throw new Error('Project target name must be one direct child.');
  if (value.includes('\0') || /[\/\\:]/.test(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error('Project target name must not contain a path, drive, UNC, or alternate data stream.');
  }
  if (/[\x00-\x1f]/.test(value)) throw new Error('Project target name contains control characters.');
  if (/[. ]$/.test(value)) throw new Error('Project target name cannot end with a dot or space.');
  if (WINDOWS_RESERVED_NAMES.test(value)) throw new Error('Project target name is reserved by Windows.');
  return value;
}

export function parseBuilderTargetDescriptor(value: unknown): BuilderTargetDescriptor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'workspace_root') return { kind: 'workspace_root' };
  if (record.kind === 'existing_project' || record.kind === 'new_sibling_project') {
    try {
      return { kind: record.kind, projectName: validateDirectChildProjectName(record.projectName) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

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
  targetDescriptor?: BuilderTargetDescriptor | null;
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
