export type MissionStatus =
  | 'draft'
  | 'planning'
  | 'ready'
  | 'running'
  | 'waiting_for_approval'
  | 'blocked'
  | 'reviewing'
  | 'revising'
  | 'applying'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionMode = 'review_driven' | 'balanced' | 'autonomous' | 'candidate';

export interface Mission {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: MissionStatus;
  teamTemplateId: string;
  planId: string | null;
  executionMode: ExecutionMode;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
