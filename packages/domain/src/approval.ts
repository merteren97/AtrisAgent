export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalType =
  | 'plan'
  | 'plan_step'
  | 'tool_call'
  | 'file_write'
  | 'file_edit'
  | 'git_commit'
  | 'apply'
  | 'merge'
  | 'delete'
  | 'destructive_action'
  | 'package_install'
  | 'dependency_install'
  | 'git_push'
  | 'pull_request'
  | 'database_migration'
  | 'command_execution'
  | 'candidate_selection';

export interface Approval {
  id: string;
  missionId: string;
  taskId: string | null;
  runId: string | null;
  type: ApprovalType;
  description: string;
  status: ApprovalStatus;
  decidedBy: 'user' | 'orchestrator' | null;
  createdAt: string;
  decidedAt: string | null;
}
