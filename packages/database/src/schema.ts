import { sqliteTable, text, integer, real, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
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
  status: text('status').$type<import('@atris-agent-code/domain').TaskAttempt['status']>().notNull().default('running'),
  worktreePath: text('worktree_path'),
  runtimeSessionId: text('runtime_session_id'),
  routeAdapterId: text('route_adapter_id'),
  routeProvider: text('route_provider'),
  routeAccountProfileId: text('route_account_profile_id'),
  routeModelCatalogId: text('route_model_catalog_id'),
  routeRuntimeModelId: text('route_runtime_model_id'),
  routeReasoningLevel: text('route_reasoning_level').$type<CanonicalReasoning>(),
  routeSource: text('route_source').$type<import('@atris-agent-code/domain').RoutingPreferenceSource>(),
  routeSelectionMode: text('route_selection_mode').$type<import('@atris-agent-code/domain').RouteSelectionMode>(),
  providerSessionId: text('provider_session_id'),
  heartbeatAt: text('heartbeat_at'),
  leaseExpiresAt: text('lease_expires_at'),
  retryable: integer('retryable', { mode: 'boolean' }).notNull().default(false),
  claimedAt: text('claimed_at').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  error: text('error'),
  resultSummary: text('result_summary'),
  reviewPack: text('review_pack', { mode: 'json' }).$type<Record<string, unknown>>(),
}, (table) => ({
  taskAttemptNumber: uniqueIndex('idx_task_attempts_task_number').on(table.taskId, table.attemptNumber),
}));

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
  taskId: text('task_id'),
  parentAgentId: text('parent_agent_id'),
  displayName: text('display_name'),
  specialty: text('specialty'),
  spawnReason: text('spawn_reason'),
  statusMessage: text('status_message'),
  progress: integer('progress'),
  workspaceMode: text('workspace_mode'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
});

export const agentMessages = sqliteTable('agent_messages', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
  readAt: text('read_at'),
  kind: text('kind').$type<'message' | 'handoff' | 'review_request' | 'summary'>().notNull().default('message'),
  replyToMessageId: text('reply_to_message_id'),
});

export const teamTemplates = sqliteTable('team_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  maxParallelAgents: integer('max_parallel_agents'),
  workerPools: text('worker_pools', { mode: 'json' }).$type<import('@atris-agent-code/domain').WorkerPoolPolicy[]>(),
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
}, (table) => ({
  activeResource: uniqueIndex('idx_resource_leases_active_resource')
    .on(table.resourceType, table.resourceId)
    .where(sql`${table.status} = 'active'`),
}));

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
  requestedDecision: text('requested_decision').$type<'approved' | 'rejected'>(),
  claimedAt: text('claimed_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  executionError: text('execution_error'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
});

export const approvalOperations = sqliteTable('approval_operations', {
  approvalId: text('approval_id').primaryKey().references(() => approvals.id, { onDelete: 'cascade' }),
  decision: text('decision').$type<'approved' | 'rejected'>().notNull(),
  status: text('status').$type<'applying' | 'completed' | 'reconcile_required'>().notNull(),
  operationType: text('operation_type').notNull().default('approval'),
  resourceId: text('resource_id'),
  idempotencyKey: text('idempotency_key'),
  result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  reconciledAt: text('reconciled_at'),
  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  error: text('error'),
});

export const missionCompletions = sqliteTable('mission_completions', {
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  planId: text('plan_id').notNull(),
  runId: text('run_id'),
  turnId: text('turn_id'),
  status: text('status').$type<'synthesis_pending' | 'event_pending' | 'completed'>().notNull(),
  summary: text('summary'),
  tasksCompleted: integer('tasks_completed').notNull(),
  totalTasks: integer('total_tasks').notNull(),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [primaryKey({ columns: [table.missionId, table.planId] })]);

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

export const runtimeTelemetry = sqliteTable('runtime_telemetry', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  agentInstanceId: text('agent_instance_id').notNull(),
  adapterId: text('adapter_id').notNull(),
  accountProfileId: text('account_profile_id'),
  attemptId: text('attempt_id'),
  outcome: text('outcome').$type<'completed' | 'failed'>().notNull(),
  usageAvailable: integer('usage_available', { mode: 'boolean' }).notNull().default(false),
  usageSource: text('usage_source').$type<'provider_reported' | 'unavailable'>().notNull().default('unavailable'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cost: real('cost'),
  currency: text('currency'),
  queueWaitMs: integer('queue_wait_ms').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(1),
  workerUtilization: real('worker_utilization').notNull().default(0),
  recordedAt: text('recorded_at').notNull(),
});

export const applyVerificationOperations = sqliteTable('apply_verification_operations', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  planId: text('plan_id').notNull(),
  runId: text('run_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  applyPhase: text('apply_phase').$type<'pending' | 'in_progress' | 'applied' | 'blocked'>().notNull().default('pending'),
  verificationPhase: text('verification_phase').$type<'pending' | 'running' | 'blocked' | 'completed'>().notNull().default('pending'),
  builderTaskIds: text('builder_task_ids', { mode: 'json' }).$type<string[]>().notNull(),
  appliedTaskIds: text('applied_task_ids', { mode: 'json' }).$type<string[]>().notNull(),
  verificationPassed: integer('verification_passed', { mode: 'boolean' }),
  summary: text('summary'),
  evidence: text('evidence', { mode: 'json' }).$type<string[]>(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => ({
  missionPlan: uniqueIndex('idx_apply_verification_mission_plan').on(table.missionId, table.planId),
  idempotency: uniqueIndex('idx_apply_verification_idempotency').on(table.idempotencyKey),
}));

export const deletionOperations = sqliteTable('deletion_operations', {
  id: text('id').primaryKey(),
  targetType: text('target_type').$type<'mission' | 'workspace'>().notNull(),
  targetId: text('target_id').notNull(),
  removeMemory: integer('remove_memory', { mode: 'boolean' }).notNull().default(false),
  phase: text('phase').notNull().default('stop'),
  status: text('status').$type<'pending' | 'running' | 'retryable' | 'completed'>().notNull().default('pending'),
  manifest: text('manifest', { mode: 'json' }).$type<string[]>().notNull(),
  progress: text('progress', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  error: text('error'),
  ownerToken: text('owner_token'),
  leaseExpiresAt: text('lease_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => ({
  target: uniqueIndex('idx_deletion_operations_target').on(table.targetType, table.targetId),
}));

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
export type AgentMessageSelect = typeof agentMessages.$inferSelect;
export type AgentMessageInsert = typeof agentMessages.$inferInsert;

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
export type ApprovalOperationSelect = typeof approvalOperations.$inferSelect;
export type ApprovalOperationInsert = typeof approvalOperations.$inferInsert;
export type MissionCompletionSelect = typeof missionCompletions.$inferSelect;
export type MissionCompletionInsert = typeof missionCompletions.$inferInsert;

export type ArtifactSelect = typeof artifacts.$inferSelect;
export type ArtifactInsert = typeof artifacts.$inferInsert;

export type UsageSnapshotSelect = typeof usageSnapshots.$inferSelect;
export type UsageSnapshotInsert = typeof usageSnapshots.$inferInsert;
export type RuntimeTelemetrySelect = typeof runtimeTelemetry.$inferSelect;
export type RuntimeTelemetryInsert = typeof runtimeTelemetry.$inferInsert;
export type ApplyVerificationOperationSelect = typeof applyVerificationOperations.$inferSelect;
export type ApplyVerificationOperationInsert = typeof applyVerificationOperations.$inferInsert;
export type DeletionOperationSelect = typeof deletionOperations.$inferSelect;
export type DeletionOperationInsert = typeof deletionOperations.$inferInsert;

export type WorktreeSelect = typeof worktrees.$inferSelect;
export type WorktreeInsert = typeof worktrees.$inferInsert;

export type CheckpointSelect = typeof checkpoints.$inferSelect;
export type CheckpointInsert = typeof checkpoints.$inferInsert;
