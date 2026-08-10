export interface BaseEvent {
  id: string;
  missionId: string;
  timestamp: string;
}

export interface MissionStarted extends BaseEvent {
  type: 'mission_started';
  title: string;
  workspaceId: string;
}

export interface PlanGenerated extends BaseEvent {
  type: 'plan_generated';
  planId: string;
  taskCount: number;
  summary: string;
}

export interface PlanRevised extends BaseEvent {
  type: 'plan_revised';
  planId: string;
  previousPlanId?: string | null;
  reason: string;
  changedTaskIds?: string[];
}

export interface TaskCreated extends BaseEvent {
  type: 'task_created';
  taskId: string;
  title: string;
  assignedRole: string | null;
  agentInstanceId?: string;
  parentAgentId?: string | null;
  displayName?: string;
  specialty?: string;
  spawnReason?: string;
  workspaceMode?: 'shared' | 'isolated_worktree' | 'read_only';
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: string;
  fallbackCatalogIds?: string[];
  routeSelectionMode?: 'auto' | 'prefer' | 'fixed';
}

export interface TaskAssigned extends BaseEvent {
  type: 'task_assigned';
  taskId: string;
  agentInstanceId: string;
  role: string;
}

export interface TaskClaimed extends BaseEvent {
  type: 'task_claimed';
  taskId: string;
  agentInstanceId: string;
  worktreePath?: string | null;
}

export interface TaskSplit extends BaseEvent {
  type: 'task_split';
  taskId: string;
  childTaskIds: string[];
  reason: string;
}

export interface TaskMerged extends BaseEvent {
  type: 'task_merged';
  taskIds: string[];
  mergedTaskId: string;
  reason: string;
}

export interface AgentStarted extends BaseEvent {
  type: 'agent_started';
  agentInstanceId: string;
  role: string;
  model: string;
  parentAgentId?: string | null;
  displayName?: string;
  specialty?: string;
  spawnReason?: string;
  taskId?: string | null;
  workspaceMode?: 'shared' | 'isolated_worktree' | 'read_only';
}

export interface AgentSpawned extends BaseEvent {
  type: 'agent_spawned';
  agentInstanceId: string;
  parentAgentId?: string | null;
  role: string;
  displayName: string;
  specialty?: string;
  spawnReason: string;
  taskId?: string | null;
  model?: string;
  workspaceMode?: 'shared' | 'isolated_worktree' | 'read_only';
}

export interface AgentProgressed extends BaseEvent {
  type: 'agent_progressed';
  agentInstanceId: string;
  taskId?: string;
  progress: string;
  percentage?: number;
}

export interface AgentWaiting extends BaseEvent {
  type: 'agent_waiting';
  agentInstanceId: string;
  reason: string;
  waitingForAgentId?: string;
}

export interface AgentResumed extends BaseEvent {
  type: 'agent_resumed';
  agentInstanceId: string;
  reason?: string;
}

export interface AgentMessageSent extends BaseEvent {
  type: 'agent_message_sent';
  messageId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  kind: 'message' | 'handoff' | 'review_request' | 'summary';
  replyToMessageId?: string | null;
}

export interface AgentMessageRead extends BaseEvent {
  type: 'agent_message_read';
  messageId: string;
  agentInstanceId: string;
}

export interface AgentContextAttached extends BaseEvent {
  type: 'agent_context_attached';
  agentInstanceId: string;
  label: string;
  sourceType: string;
  sourceId?: string;
  tokenEstimate?: number;
}

export interface AgentContextCompacted extends BaseEvent {
  type: 'agent_context_compacted';
  agentInstanceId: string;
  beforeTokens?: number;
  afterTokens?: number;
  summaryArtifactId?: string;
}

export interface AgentCompleted extends BaseEvent {
  type: 'agent_completed';
  agentInstanceId: string;
  summary?: string;
}

export interface TextDelta extends BaseEvent {
  type: 'text_delta';
  agentInstanceId: string;
  content: string;
}

export interface ToolCallStarted extends BaseEvent {
  type: 'tool_call_started';
  agentInstanceId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCallCompleted extends BaseEvent {
  type: 'tool_call_completed';
  agentInstanceId: string;
  toolName: string;
  result: string;
  success: boolean;
}

export interface FileChanged extends BaseEvent {
  type: 'file_changed';
  taskId: string;
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  agentInstanceId?: string;
}

export interface ApprovalRequested extends BaseEvent {
  type: 'approval_requested';
  approvalId: string;
  approvalType: string;
  description: string;
}

export interface ApprovalResponded extends BaseEvent {
  type: 'approval_responded';
  approvalId: string;
  approved: boolean;
  decidedBy: string;
}

export interface CheckCompleted extends BaseEvent {
  type: 'check_completed';
  taskId: string;
  checkName: string;
  passed: boolean;
  summary: string;
}

export interface ReviewCompleted extends BaseEvent {
  type: 'review_completed';
  taskId: string;
  reviewerAgentId: string;
  approved: boolean;
  findings: string;
}

export interface VerificationStarted extends BaseEvent {
  type: 'verification_started';
  taskId: string;
  reviewerAgentId?: string;
}

export interface VerificationFinding extends BaseEvent {
  type: 'verification_finding';
  taskId: string;
  reviewerAgentId?: string;
  findingId: string;
  severity: 'critical' | 'major' | 'minor';
  title: string;
  description: string;
  path?: string;
}

export interface VerificationCompleted extends BaseEvent {
  type: 'verification_completed';
  taskId: string;
  reviewerAgentId?: string;
  passed: boolean;
  findingCount: number;
  summary: string;
}

export interface RevisionRequested extends BaseEvent {
  type: 'revision_requested';
  taskId: string;
  reason: string;
  builderAgentId: string;
}

export interface CandidateSelected extends BaseEvent {
  type: 'candidate_selected';
  taskId: string;
  selectedCandidateId: string;
  reason: string;
}

export interface ChangesApplied extends BaseEvent {
  type: 'changes_applied';
  taskId: string;
  filesChanged: number;
  checkpointId: string;
}

export interface MissionCompleted extends BaseEvent {
  type: 'mission_completed';
  summary: string;
  tasksCompleted: number;
  totalTasks: number;
}

export interface MissionFailed extends BaseEvent {
  type: 'mission_failed';
  reason: string;
  failedTaskId: string | null;
}

export interface TaskCompleted extends BaseEvent {
  type: 'task_completed';
  taskId: string;
  result?: string;
  agentInstanceId?: string;
}

export interface TaskFailed extends BaseEvent {
  type: 'task_failed';
  taskId: string;
  error: string;
  exitCode?: number | null;
  agentInstanceId?: string;
}

export interface AgentThought extends BaseEvent {
  type: 'agent_thought';
  taskId: string;
  thought: string;
  agentInstanceId?: string;
}

export interface AgentToolCall extends BaseEvent {
  type: 'agent_tool_call';
  taskId: string;
  toolName: string;
  args?: Record<string, unknown>;
  agentInstanceId?: string;
}

export interface AgentError extends BaseEvent {
  type: 'agent_error';
  taskId: string;
  error: string;
  agentInstanceId?: string;
}

export type AgentEvent =
  | MissionStarted
  | PlanGenerated
  | PlanRevised
  | TaskCreated
  | TaskAssigned
  | TaskClaimed
  | TaskSplit
  | TaskMerged
  | TaskCompleted
  | TaskFailed
  | AgentStarted
  | AgentSpawned
  | AgentProgressed
  | AgentWaiting
  | AgentResumed
  | AgentMessageSent
  | AgentMessageRead
  | AgentContextAttached
  | AgentContextCompacted
  | AgentCompleted
  | AgentThought
  | AgentToolCall
  | AgentError
  | TextDelta
  | ToolCallStarted
  | ToolCallCompleted
  | FileChanged
  | ApprovalRequested
  | ApprovalResponded
  | CheckCompleted
  | ReviewCompleted
  | VerificationStarted
  | VerificationFinding
  | VerificationCompleted
  | RevisionRequested
  | CandidateSelected
  | ChangesApplied
  | MissionCompleted
  | MissionFailed;

export type AgentEventType = AgentEvent['type'];
export type EventCategory = 'lifecycle' | 'execution' | 'governance' | 'agent_stream' | 'coordination' | 'context';
