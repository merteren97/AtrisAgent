import type { Provider, RuntimeType } from './account-profile';
import type { CanonicalReasoning } from './model-profile';

export interface Run {
  id: string;
  taskId: string;
  agentInstanceId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  resultSummary: string | null;
}

export interface ResolvedRunConfig {
  runtimeId: RuntimeType;
  runtimeVersion: string;
  accountProfileId: string;
  providerId: Provider;
  modelId: string;
  reasoningOrVariant: CanonicalReasoning | string;
  permissionProfileId: string;
  workspaceId: string;
  worktreePath: string;
  resolvedAt: string;
}
