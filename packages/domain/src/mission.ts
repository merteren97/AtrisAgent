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

export type TrustProfile = 'ask' | 'review' | 'auto';
export type ExecutionStrategy = 'standard' | 'candidate';
export type AutomationAction = 'plan' | 'fileWrite' | 'deleteFiles' | 'commandExecution' | 'packageInstall'
  | 'gitCommit' | 'databaseMigration' | 'workspaceApply' | 'gitPush' | 'pullRequest';
export type AutomationDecision = 'ask' | 'review' | 'auto' | 'deny';
export type AutomationOverrides = Partial<Record<AutomationAction, AutomationDecision>>;
export interface MissionAutomationPolicy {
  profile: TrustProfile;
  strategy: ExecutionStrategy;
  overrides: AutomationOverrides;
}

export interface Mission {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: MissionStatus;
  teamTemplateId: string;
  planId: string | null;
  executionMode: ExecutionMode;
  automationPolicy?: MissionAutomationPolicy;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
