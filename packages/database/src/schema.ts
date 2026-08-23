import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  MissionStatus,
  ExecutionMode,
  TaskStatus,
  TaskPriority,
  AgentRole,
  Provider,
  RuntimeType,
  AccountProfileStatus,
  ApprovalType,
  ApprovalStatus,
  ArtifactType,
  CanonicalReasoning,
} from '@atris-agent-code/domain';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  gitInitialized: integer('git_initialized', { mode: 'boolean' }).notNull().default(false),
  lastOpenedAt: text('last_opened_at'),
  lastTeamTemplateId: text('last_team_template_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const missions = sqliteTable('missions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').$type<MissionStatus>().notNull().default('draft'),
  teamTemplateId: text('team_template_id').notNull().default(''),
  planId: text('plan_id'),
  executionMode: text('execution_mode').$type<ExecutionMode>().notNull().default('balanced'),
  automationPolicy: text('automation_policy', { mode: 'json' }).$type<import('@atris-agent-code/domain').MissionAutomationPolicy>(),
  activeRunId: text('active_run_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

export const missionEvents = sqliteTable('mission_events', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  taskId: text('task_id'),
  agentInstanceId: text('agent_instance_id'),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  sequence: integer('sequence'),
  schemaVersion: integer('schema_version'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  missionSequence: uniqueIndex('idx_mission_events_mission_sequence').on(table.missionId, table.sequence),
}));

export const events = missionEvents;

export const conversationTurns = sqliteTable('conversation_turns', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  delivery: text('delivery').$type<'steer' | 'queue' | 'stop_and_replan'>().notNull(),
  options: text('options', { mode: 'json' }).$type<Record<string, unknown>>(),
  status: text('status').$type<'queued' | 'pending_priority' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'>().notNull().default('queued'),
  idempotencyKey: text('idempotency_key'),
  requestHash: text('request_hash'),
  commandId: text('command_id'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const missionRuns = sqliteTable('mission_runs', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').references(() => conversationTurns.id, { onDelete: 'set null' }),
  commandId: text('command_id'),
  status: text('status').$type<'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled'>().notNull().default('starting'),
  planId: text('plan_id'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  error: text('error'),
  heartbeatAt: text('heartbeat_at'),
});

export const missionCommands = sqliteTable('mission_commands', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
  type: text('type').$type<'steer' | 'queue' | 'stop_and_replan'>().notNull(),
  status: text('status').$type<'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'>().notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  createdAt: text('created_at').notNull(),
  processedAt: text('processed_at'),
  claimedAt: text('claimed_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  requestHash: text('request_hash'),
  error: text('error'),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  planId: text('plan_id').notNull().default(''),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').$type<TaskStatus>().notNull().default('planned'),
  priority: text('priority').$type<TaskPriority>().notNull().default('medium'),
  assignedAgentId: text('assigned_agent_id'),
  assignedRole: text('assigned_role').$type<AgentRole>(),
  requiredCapabilities: text('required_capabilities', { mode: 'json' }).$type<string[]>().notNull(),
  dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull(),
  worktreeId: text('worktree_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

export const taskDependencies = sqliteTable('task_dependencies', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: text('depends_on_task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
});

export const taskAttempts = sqliteTable('task_attempts', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  agentInstanceId: text('agent_instance_id').notNull(),
  attemptNumber: integer('attempt_number').notNull().default(1),
  status: text('status').notNull().default('running'),
  worktreePath: text('worktree_path'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  error: text('error'),
  resultSummary: text('result_summary'),
  reviewPack: text('review_pack', { mode: 'json' }).$type<Record<string, unknown>>(),
});

export const accountProfiles = sqliteTable('account_profiles', {
  id: text('id').primaryKey(),
  provider: text('provider').$type<Provider>().notNull(),
  runtimeType: text('runtime_type').$type<RuntimeType>().notNull(),
  profileName: text('profile_name').notNull(),
  authStatus: text('auth_status').$type<AccountProfileStatus>().notNull().default('not_installed'),
  configDir: text('config_dir').notNull().default(''),
  supportedModels: text('supported_models', { mode: 'json' }).$type<string[]>().notNull(),
  usageScope: text('usage_scope'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const modelProfiles = sqliteTable('model_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').$type<Provider>().notNull(),
  runtimeType: text('runtime_type').$type<RuntimeType>().notNull(),
  accountProfileId: text('account_profile_id').references(() => accountProfiles.id),
  suitableRoles: text('suitable_roles', { mode: 'json' }).$type<AgentRole[]>().notNull(),
  available: integer('available', { mode: 'boolean' }).default(true),
  supportsReasoning: integer('supports_reasoning', { mode: 'boolean' }).default(false),
  reasoningLevels: text('reasoning_levels', { mode: 'json' }).$type<CanonicalReasoning[]>().notNull(),
  contextClass: text('context_class').default('medium'),
  speedClass: text('speed_class').default('standard'),
  isSubscription: integer('is_subscription', { mode: 'boolean' }).default(false),
});

export const agentInstances = sqliteTable('agent_instances', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  role: text('role').$type<AgentRole>().notNull(),
  modelProfileId: text('model_profile_id').default(''),
  accountProfileId: text('account_profile_id').default(''),
  runtimeAdapterId: text('runtime_adapter_id').default(''),
  sessionId: text('session_id'),
  status: text('status').default('idle'),
  createdAt: text('created_at').notNull(),
});

export const teamTemplates = sqliteTable('team_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
});

export const teamRoles = sqliteTable('team_roles', {
  id: text('id').primaryKey(),
  templateId: text('template_id')
    .notNull()
    .references(() => teamTemplates.id, { onDelete: 'cascade' }),
  role: text('role').$type<AgentRole>().notNull(),
  modelProfileId: text('model_profile_id').default(''),
  accountProfileId: text('account_profile_id').default(''),
  defaultCapabilities: text('default_capabilities', { mode: 'json' }).$type<string[]>().notNull(),
  accessLevel: text('access_level').notNull().default('read'),
});

export const resourceLeases = sqliteTable('resource_leases', {
  id: text('id').primaryKey(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  heldByAgentId: text('held_by_agent_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  heartbeatAt: text('heartbeat_at').notNull(),
  status: text('status').default('active'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  taskId: text('task_id'),
  runId: text('run_id'),
  type: text('type').$type<ApprovalType>().notNull(),
  description: text('description').notNull().default(''),
  status: text('status').$type<ApprovalStatus>().default('pending'),
  decidedBy: text('decided_by'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  taskId: text('task_id'),
  runId: text('run_id'),
  type: text('type').$type<ArtifactType>().notNull(),
  name: text('name').notNull(),
  path: text('path'),
  content: text('content'),
  sizeBytes: integer('size_bytes'),
  createdAt: text('created_at').notNull(),
});

export const usageSnapshots = sqliteTable('usage_snapshots', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  agentInstanceId: text('agent_instance_id'),
  accountProfileId: text('account_profile_id'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cost: integer('cost'),
  currency: text('currency').default('USD'),
  recordedAt: text('recorded_at').notNull(),
});

export const worktrees = sqliteTable('worktrees', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  branchName: text('branch_name').notNull(),
  path: text('path').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
});

export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  label: text('label').notNull(),
  gitRef: text('git_ref'),
  snapshotPath: text('snapshot_path'),
  createdAt: text('created_at').notNull(),
  isRollbackTarget: integer('is_rollback_target', { mode: 'boolean' }).notNull().default(false),
});

export type WorkspaceSelect = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;

export type MissionSelect = typeof missions.$inferSelect;
export type MissionInsert = typeof missions.$inferInsert;

export type MissionEventSelect = typeof missionEvents.$inferSelect;
export type MissionEventInsert = typeof missionEvents.$inferInsert;
export type EventSelect = MissionEventSelect;
export type EventInsert = MissionEventInsert;

export type ConversationTurnSelect = typeof conversationTurns.$inferSelect;
export type ConversationTurnInsert = typeof conversationTurns.$inferInsert;
export type MissionRunSelect = typeof missionRuns.$inferSelect;
export type MissionRunInsert = typeof missionRuns.$inferInsert;
export type MissionCommandSelect = typeof missionCommands.$inferSelect;
export type MissionCommandInsert = typeof missionCommands.$inferInsert;

export type TaskSelect = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;

export type TaskDependencySelect = typeof taskDependencies.$inferSelect;
export type TaskDependencyInsert = typeof taskDependencies.$inferInsert;

export type TaskAttemptSelect = typeof taskAttempts.$inferSelect;
export type TaskAttemptInsert = typeof taskAttempts.$inferInsert;

export type AgentInstanceSelect = typeof agentInstances.$inferSelect;
export type AgentInstanceInsert = typeof agentInstances.$inferInsert;

export type AccountProfileSelect = typeof accountProfiles.$inferSelect;
export type AccountProfileInsert = typeof accountProfiles.$inferInsert;

export type ModelProfileSelect = typeof modelProfiles.$inferSelect;
export type ModelProfileInsert = typeof modelProfiles.$inferInsert;

export type TeamTemplateSelect = typeof teamTemplates.$inferSelect;
export type TeamTemplateInsert = typeof teamTemplates.$inferInsert;

export type TeamRoleSelect = typeof teamRoles.$inferSelect;
export type TeamRoleInsert = typeof teamRoles.$inferInsert;

export type ResourceLeaseSelect = typeof resourceLeases.$inferSelect;
export type ResourceLeaseInsert = typeof resourceLeases.$inferInsert;

export type ApprovalSelect = typeof approvals.$inferSelect;
export type ApprovalInsert = typeof approvals.$inferInsert;

export type ArtifactSelect = typeof artifacts.$inferSelect;
export type ArtifactInsert = typeof artifacts.$inferInsert;

export type UsageSnapshotSelect = typeof usageSnapshots.$inferSelect;
export type UsageSnapshotInsert = typeof usageSnapshots.$inferInsert;

export type WorktreeSelect = typeof worktrees.$inferSelect;
export type WorktreeInsert = typeof worktrees.$inferInsert;

export type CheckpointSelect = typeof checkpoints.$inferSelect;
export type CheckpointInsert = typeof checkpoints.$inferInsert;
