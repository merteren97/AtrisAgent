export type ProjectIdentityStatus = 'active' | 'detached' | 'archived';

export type MemoryNodeType =
  | 'project'
  | 'component'
  | 'file'
  | 'symbol'
  | 'research_finding'
  | 'decision'
  | 'change'
  | 'issue'
  | 'bug'
  | 'lesson'
  | 'mistake'
  | 'pattern'
  | 'session'
  | 'turn'
  | 'task'
  | 'agent_run'
  | 'test'
  | 'verification'
  | 'artifact'
  | 'external_source'
  | 'requirement'
  | 'user_constraint';

export type MemoryNodeStatus = 'active' | 'stale' | 'superseded' | 'disputed' | 'archived';

export type MemoryEdgeType =
  | 'related_to'
  | 'depends_on'
  | 'references'
  | 'derived_from'
  | 'produced_by'
  | 'investigated_by'
  | 'changed_by'
  | 'fixed_by'
  | 'verified_by'
  | 'contradicts'
  | 'supersedes'
  | 'implements'
  | 'affects'
  | 'belongs_to';

export type MemorySourceType =
  | 'user_message'
  | 'agent_output'
  | 'research'
  | 'git_commit'
  | 'git_diff'
  | 'test_output'
  | 'review'
  | 'artifact'
  | 'external_source'
  | 'manual';

export interface ProjectIdentity {
  id: string;
  displayName: string;
  normalizedPath?: string | null;
  repositoryFingerprint?: string | null;
  status: ProjectIdentityStatus;
  createdAt: string;
  updatedAt: string;
  detachedAt?: string | null;
}

export interface ProjectMemorySpace {
  id: string;
  projectId: string;
  status: 'active' | 'archived';
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProvenance {
  sourceType: MemorySourceType;
  sourceId?: string | null;
  missionId?: string | null;
  turnId?: string | null;
  taskId?: string | null;
  agentInstanceId?: string | null;
  path?: string | null;
  url?: string | null;
  createdBy: 'user' | 'orchestrator' | 'memory_curator' | 'worker' | 'system';
}

export interface MemoryNode {
  id: string;
  projectId: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  body?: string | null;
  status: MemoryNodeStatus;
  confidence: number;
  importance: number;
  pinned: boolean;
  tags: string[];
  provenance: MemoryProvenance[];
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string | null;
}

export interface MemoryEdge {
  id: string;
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
  type: MemoryEdgeType;
  confidence: number;
  createdAt: string;
  createdBy: MemoryProvenance['createdBy'];
}

export interface MemoryCandidate {
  projectId: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  body?: string;
  confidence: number;
  importance: number;
  tags?: string[];
  provenance: MemoryProvenance[];
  relatedNodeIds?: string[];
}

export interface MemoryQuery {
  projectId: string;
  text: string;
  nodeTypes?: MemoryNodeType[];
  statuses?: MemoryNodeStatus[];
  limit?: number;
  anchorNodeIds?: string[];
  includeArchived?: boolean;
}

export interface MemoryRetrievalHit {
  node: MemoryNode;
  score: number;
  lexicalScore: number;
  graphScore: number;
  confidenceScore: number;
  importanceScore: number;
  recencyScore: number;
}

export type OrchestratorTurnAction = 'respond' | 'clarify' | 'delegate' | 'execute' | 'plan_only';

export interface ConversationTurn {
  id: string;
  conversationId: string;
  projectId: string;
  userMessage: string;
  action?: OrchestratorTurnAction;
  planId?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

export interface OrchestratorDelegation {
  id: string;
  role: 'researcher' | 'builder' | 'reviewer' | 'qa';
  objective: string;
  requiredCapabilities: string[];
  dependsOnDelegationIds?: string[];
  preferredParallelGroup?: string | null;
}

export interface OrchestratorDecision {
  turnId: string;
  action: OrchestratorTurnAction;
  response?: string;
  clarifyingQuestions?: string[];
  delegations?: OrchestratorDelegation[];
  needsUserApproval?: boolean;
  memoryQueries?: MemoryQuery[];
}
