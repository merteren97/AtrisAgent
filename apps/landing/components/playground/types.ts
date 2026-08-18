export type PlaygroundStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'waiting_for_approval'
  | 'completed'
  | 'rejected';

export type TrustMode = 'Review Driven' | 'Balanced' | 'Autonomous' | 'Candidate';

export type RuntimeModel = 'Codex CLI' | 'Claude Code' | 'Antigravity CLI' | 'OpenCode';

export type AgentRole = 'orchestrator' | 'builder' | 'builder_b' | 'reviewer' | 'researcher' | 'qa';

export type AgentStatus = 'idle' | 'running' | 'done' | 'waiting' | 'failed';

export interface AgentInfo {
  id: string;
  role: AgentRole;
  name: string;
  runtime: RuntimeModel;
  status: AgentStatus;
  currentTask: string;
  avatarColor: string;
  isCandidate?: boolean;
}

export type InspectorTab = 'plan' | 'agents' | 'changes' | 'checks';

export interface ScenarioTask {
  id: string;
  title: string;
  assignedRole: AgentRole;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependencies?: string[];
  summary?: string;
}

export interface ChangedFileDiff {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  diffSnippet: string;
  oldContent?: string;
  newContent?: string;
}

export interface QACheckItem {
  id: string;
  name: string;
  passed: boolean;
  summary: string;
  timestamp: string;
  category: 'security' | 'unit' | 'integration' | 'performance' | 'typecheck';
  details?: string;
}

export interface ApprovalData {
  id: string;
  type: 'plan_approval' | 'file_write' | 'terminal_command' | 'network_access' | 'security_elevation';
  title: string;
  description: string;
  command?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedFiles?: string[];
}

export interface CandidateItem {
  id: string;
  name: string;
  runtime: RuntimeModel;
  score: number;
  latency: string;
  memory: string;
  pros: string[];
  cons: string[];
  selected: boolean;
}

export interface TimelineStepEvent {
  id: string;
  type:
    | 'thought'
    | 'tool_call'
    | 'plan_generated'
    | 'approval_request'
    | 'file_change'
    | 'qa_check'
    | 'candidate_comparison'
    | 'mission_summary';
  agentRole: AgentRole;
  content: string;
  timestamp: string;
  durationMs?: number;
  toolData?: {
    name: string;
    args: Record<string, unknown>;
    output: string;
    status: 'running' | 'success' | 'failed';
    duration: string;
  };
  approvalData?: ApprovalData;
  diffData?: ChangedFileDiff;
  checkData?: QACheckItem;
  candidateData?: {
    candidates: CandidateItem[];
    summary: string;
    selectedCandidateId: string;
  };
  tokens?: number;
}

export interface PlaygroundScenario {
  id: string;
  title: {
    tr: string;
    en: string;
  };
  badge: {
    tr: string;
    en: string;
  };
  description: {
    tr: string;
    en: string;
  };
  prompt: string;
  defaultTrustMode: TrustMode;
  defaultRuntime: RuntimeModel;
  workspaceName: string;
  branchName: string;
  initialAgents: AgentInfo[];
  planTasks: ScenarioTask[];
  events: TimelineStepEvent[];
  finalDiffs: ChangedFileDiff[];
  qaChecks: QACheckItem[];
  estimatedTokens: number;
}
