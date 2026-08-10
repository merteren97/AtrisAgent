export type AgentRole = 'orchestrator' | 'builder' | 'reviewer' | 'researcher' | 'qa';
export type AgentStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';
export type AgentWorkspaceMode = 'shared' | 'isolated_worktree' | 'read_only';

/**
 * Runtime V2 keeps agent identity durable and independent from the UI surface used
 * to observe it. Parent/child lineage describes provenance only; communication
 * permissions are enforced separately by Coordination MCP and policy rules.
 */
export interface AgentInstance {
  id: string;
  missionId: string;
  role: AgentRole;
  modelProfileId: string;
  accountProfileId: string;
  runtimeAdapterId: string;
  sessionId: string | null;
  status: AgentStatus;
  createdAt: string;
  taskId?: string | null;
  parentAgentId?: string | null;
  spawnedByAgentId?: string | null;
  displayName?: string;
  specialty?: string;
  spawnReason?: string;
  statusMessage?: string;
  progress?: number;
  workspaceMode?: AgentWorkspaceMode;
  worktreeId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AgentSession {
  id: string;
  agentInstanceId: string;
  runtimeSessionId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentSpawnRequest {
  missionId: string;
  role: AgentRole;
  instruction: string;
  parentAgentId?: string;
  taskId?: string;
  displayName?: string;
  specialty?: string;
  spawnReason: string;
  capabilities?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  /** Stable live catalog route. modelProfileId is kept as a compatibility alias. */
  modelCatalogId?: string;
  modelProfileId?: string;
  accountProfileId?: string;
  reasoningLevel?: string;
  fallbackCatalogIds?: string[];
  routeSelectionMode?: 'auto' | 'prefer' | 'fixed';
  runtimeAdapterId?: string;
  workspaceMode?: AgentWorkspaceMode;
}

export interface AgentMessage {
  id: string;
  missionId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  createdAt: string;
  readAt?: string | null;
  kind?: 'message' | 'handoff' | 'review_request' | 'summary';
  replyToMessageId?: string | null;
}
