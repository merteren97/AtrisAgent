import { and, eq, inArray, lte, max } from 'drizzle-orm';
import {
  workspaces,
  missions,
  tasks,
  taskAttempts,
  worktrees,
  teamRoles,
  executionPolicies,
  type WorkspaceSelect,
  type WorkspaceInsert,
  type MissionSelect,
  type MissionInsert,
  type TaskSelect,
  type TaskInsert,
  type TaskAttemptSelect,
  type TaskAttemptInsert,
  type WorktreeSelect,
  type WorktreeInsert,
  type ExecutionPolicyScope,
  type AtrisDatabase,
} from '@atris-agent-code/database';
import path from 'path';
import { WorktreeManager } from './worktree-manager';
import { CheckpointManager } from './checkpoint-manager';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type {
  ExecutionMode,
  MissionStatus,
  TaskStatus,
  TaskPriority,
  AgentRole,
  RoleExecutionPolicy,
  EffectiveRoutingPreference,
  RoutingPreferenceSource,
  MissionAutomationPolicy,
} from '@atris-agent-code/domain';

export interface CreateWorkspaceInput {
  name: string;
  path: string;
  gitInitialized?: boolean;
  id?: string;
  lastOpenedAt?: string | null;
  lastTeamTemplateId?: string | null;
}

export interface CreateMissionInput {
  workspaceId: string;
  title: string;
  description?: string;
  teamTemplateId?: string;
  planId?: string | null;
  executionMode?: ExecutionMode;
  status?: MissionStatus;
  id?: string;
  automationPolicy?: MissionAutomationPolicy;
}

export interface CreateTaskInput {
  missionId: string;
  planId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgentId?: string | null;
  assignedRole?: AgentRole | null;
  requiredCapabilities?: string[];
  dependsOn?: string[];
  worktreeId?: string | null;
  id?: string;
}

export interface ClaimTaskAttemptInput {
  taskId: string;
  missionId: string;
  agentInstanceId: string;
  worktreePath?: string | null;
  leaseExpiresAt: string;
  now?: string;
  id?: string;
}

export class WorkspaceManager {
  private worktreeManager = new WorktreeManager();
  private checkpointManager: CheckpointManager;

  constructor(
    private db: AtrisDatabase,
    _eventBus?: LocalEventBus
  ) {
    this.checkpointManager = new CheckpointManager(db);
  }

  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  /** Create a new workspace record. */
  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSelect> {
    const now = new Date().toISOString();
    const newWorkspace: WorkspaceInsert = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      path: input.path,
      gitInitialized: input.gitInitialized ?? false,
      lastOpenedAt: input.lastOpenedAt ?? now,
      lastTeamTemplateId: input.lastTeamTemplateId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(workspaces).values(newWorkspace);
    const result = await this.getWorkspace(newWorkspace.id);
    if (!result) throw new Error(`Failed to retrieve newly created workspace "${newWorkspace.id}"`);
    return result;
  }

  /** Get workspace by ID. */
  async getWorkspace(id: string | string[]): Promise<WorkspaceSelect | null> {
    const workspaceId = Array.isArray(id) ? id[0] : id;
    if (!workspaceId) return null;
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    return rows[0] ?? null;
  }

  /** List all workspaces. */
  async listWorkspaces(): Promise<WorkspaceSelect[]> {
    return await this.db.select().from(workspaces);
  }

  /**
   * Create a mission record only. Runtime lifecycle events are emitted by the
   * Orchestrator when execution actually transitions into Running; persistence
   * must not impersonate that transition or every mission gets two starts.
   */
  async createMission(input: CreateMissionInput): Promise<MissionSelect> {
    const now = new Date().toISOString();
    const newMission: MissionInsert = {
      id: input.id ?? crypto.randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'draft',
      teamTemplateId: input.teamTemplateId ?? '',
      planId: input.planId ?? null,
      executionMode: input.executionMode ?? 'balanced',
      automationPolicy: input.automationPolicy,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(missions).values(newMission);
    const result = await this.getMission(newMission.id);
    if (!result) throw new Error(`Failed to retrieve newly created mission "${newMission.id}"`);
    return result;
  }

  /** Get mission by ID. */
  async getMission(id: string): Promise<MissionSelect | null> {
    const rows = await this.db.select().from(missions).where(eq(missions.id, id));
    return rows[0] ?? null;
  }

  /** Update mission fields by ID. */
  async updateMission(id: string, updates: Partial<MissionInsert>): Promise<MissionSelect> {
    const now = new Date().toISOString();
    await this.db.update(missions).set({ ...updates, updatedAt: now }).where(eq(missions.id, id));
    const updated = await this.getMission(id);
    if (!updated) throw new Error(`Failed to retrieve updated mission "${id}"`);
    return updated;
  }

  /** List missions, optionally filtered by workspaceId. */
  async listMissions(workspaceId?: string): Promise<MissionSelect[]> {
    if (workspaceId) return await this.db.select().from(missions).where(eq(missions.workspaceId, workspaceId));
    return await this.db.select().from(missions);
  }

  async upsertRoleExecutionPolicy(
    scopeType: ExecutionPolicyScope,
    scopeId: string,
    policy: RoleExecutionPolicy,
    source?: RoutingPreferenceSource,
  ): Promise<void> {
    const existing = await this.db.select().from(executionPolicies).where(and(
      eq(executionPolicies.scopeType, scopeType),
      eq(executionPolicies.scopeId, scopeId),
      eq(executionPolicies.role, policy.role),
    ));
    const values = {
      scopeType,
      scopeId,
      role: policy.role,
      modelCatalogId: policy.modelCatalogId ?? null,
      accountProfileId: policy.accountProfileId ?? null,
      reasoningLevel: policy.reasoningLevel ?? null,
      fallbackCatalogIds: policy.fallbackCatalogIds || [],
      selectionMode: policy.selectionMode,
      source: source || (scopeType === 'team_template' ? 'team_template' : scopeType),
      updatedAt: new Date().toISOString(),
    } as const;
    if (existing[0]) {
      await this.db.update(executionPolicies).set(values).where(eq(executionPolicies.id, existing[0].id));
    } else {
      await this.db.insert(executionPolicies).values({ id: crypto.randomUUID(), ...values });
    }
  }

  async deleteRoleExecutionPolicies(scopeType: ExecutionPolicyScope, scopeId: string): Promise<void> {
    await this.db.delete(executionPolicies).where(and(
      eq(executionPolicies.scopeType, scopeType),
      eq(executionPolicies.scopeId, scopeId),
    ));
  }

  async listRoleExecutionPolicies(scopeType: ExecutionPolicyScope, scopeId: string): Promise<RoleExecutionPolicy[]> {
    const rows = await this.db.select().from(executionPolicies).where(and(
      eq(executionPolicies.scopeType, scopeType),
      eq(executionPolicies.scopeId, scopeId),
    ));
    return rows.map((row) => ({
      role: row.role,
      selectionMode: row.selectionMode,
      modelCatalogId: row.modelCatalogId || undefined,
      accountProfileId: row.accountProfileId || undefined,
      reasoningLevel: row.reasoningLevel || undefined,
      fallbackCatalogIds: row.fallbackCatalogIds || [],
    }));
  }

  /** Resolve route policy with deterministic precedence: mission > workspace > team > scheduler. */
  async resolveRoleExecutionPolicy(missionId: string, role: AgentRole): Promise<EffectiveRoutingPreference | undefined> {
    const mission = await this.getMission(missionId);
    if (!mission) return undefined;

    const scopedCandidates: Array<{ scopeType: ExecutionPolicyScope; scopeId: string; source: RoutingPreferenceSource }> = [
      { scopeType: 'mission', scopeId: mission.id, source: 'mission' },
      { scopeType: 'workspace', scopeId: mission.workspaceId, source: 'workspace' },
    ];
    if (mission.teamTemplateId) scopedCandidates.push({ scopeType: 'team_template', scopeId: mission.teamTemplateId, source: 'team_template' });

    for (const candidate of scopedCandidates) {
      const rows = await this.db.select().from(executionPolicies).where(and(
        eq(executionPolicies.scopeType, candidate.scopeType),
        eq(executionPolicies.scopeId, candidate.scopeId),
        eq(executionPolicies.role, role),
      ));
      const row = rows[0];
      if (!row) continue;
      return {
        modelCatalogId: row.modelCatalogId || undefined,
        accountProfileId: row.accountProfileId || undefined,
        reasoningLevel: row.reasoningLevel || undefined,
        fallbackCatalogIds: row.fallbackCatalogIds || [],
        selectionMode: row.selectionMode,
        source: candidate.source,
      };
    }

    if (mission.teamTemplateId) {
      const legacyRows = await this.db.select().from(teamRoles).where(and(
        eq(teamRoles.templateId, mission.teamTemplateId),
        eq(teamRoles.role, role),
      ));
      const legacy = legacyRows[0];
      if (legacy && (legacy.modelProfileId || legacy.accountProfileId)) {
        return {
          modelCatalogId: legacy.modelProfileId || undefined,
          accountProfileId: legacy.accountProfileId || undefined,
          fallbackCatalogIds: [],
          selectionMode: 'prefer',
          source: 'team_template',
        };
      }
    }
    return undefined;
  }

  /** Create a new task record under a mission. */
  async createTask(input: CreateTaskInput): Promise<TaskSelect> {
    const now = new Date().toISOString();
    const newTask: TaskInsert = {
      id: input.id ?? crypto.randomUUID(),
      missionId: input.missionId,
      planId: input.planId ?? '',
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'planned',
      priority: input.priority ?? 'medium',
      assignedAgentId: input.assignedAgentId ?? null,
      assignedRole: input.assignedRole ?? null,
      requiredCapabilities: input.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? [],
      worktreeId: input.worktreeId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(tasks).values(newTask);
    const result = await this.getTask(newTask.id);
    if (!result) throw new Error(`Failed to retrieve newly created task "${newTask.id}"`);
    return result;
  }

  /** Get task by ID. */
  async getTask(id: string): Promise<TaskSelect | null> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return rows[0] ?? null;
  }

  /** List all tasks for a mission. */
  async listTasks(missionId: string): Promise<TaskSelect[]> {
    return await this.db.select().from(tasks).where(eq(tasks.missionId, missionId));
  }

  async cancelMissionTasks(missionId: string): Promise<void> {
    const activeStatuses = new Set(['planned', 'ready', 'claimed', 'running', 'review', 'revision_requested', 'blocked']);
    const missionTasks = await this.listTasks(missionId);
    for (const task of missionTasks) {
      if (activeStatuses.has(String(task.status))) {
        await this.updateTask(task.id, { status: 'cancelled' });
      }
    }
  }

  /** Update task fields by ID. */
  async updateTask(id: string, updates: Partial<TaskInsert>): Promise<TaskSelect> {
    const now = new Date().toISOString();
    await this.db.update(tasks).set({ ...updates, updatedAt: now }).where(eq(tasks.id, id));
    const updated = await this.getTask(id);
    if (!updated) throw new Error(`Failed to retrieve updated task "${id}"`);
    return updated;
  }

  async claimTaskAttempt(input: ClaimTaskAttemptInput): Promise<TaskAttemptSelect> {
    const claimed = this.db.transaction((tx) => {
      const rows = tx.select({ value: max(taskAttempts.attemptNumber) })
        .from(taskAttempts).where(eq(taskAttempts.taskId, input.taskId)).all() as Array<{ value: number | null }>;
      const now = input.now ?? new Date().toISOString();
      const attempt: TaskAttemptInsert = {
        id: input.id ?? crypto.randomUUID(),
        taskId: input.taskId,
        missionId: input.missionId,
        agentInstanceId: input.agentInstanceId,
        attemptNumber: Number(rows[0]?.value || 0) + 1,
        status: 'claimed',
        worktreePath: input.worktreePath ?? null,
        runtimeSessionId: null,
        heartbeatAt: now,
        leaseExpiresAt: input.leaseExpiresAt,
        retryable: false,
        claimedAt: now,
        startedAt: now,
      };
      tx.insert(taskAttempts).values(attempt).run();
      const created = tx.select().from(taskAttempts).where(eq(taskAttempts.id, attempt.id)).get();
      if (!created) throw new Error(`Failed to retrieve claimed task attempt "${attempt.id}"`);
      return created;
    }) as TaskAttemptSelect | undefined;
    if (!claimed) throw new Error(`Failed to claim task attempt for task "${input.taskId}"`);
    return claimed;
  }

  async markTaskAttemptRunning(attemptId: string, runtimeSessionId: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean> {
    const result = await this.db.update(taskAttempts).set({
      status: 'running', runtimeSessionId, heartbeatAt, leaseExpiresAt,
    }).where(and(eq(taskAttempts.id, attemptId), eq(taskAttempts.status, 'claimed'))).returning({ id: taskAttempts.id });
    return result.length === 1;
  }

  async heartbeatTaskAttempt(attemptId: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean> {
    const result = await this.db.update(taskAttempts).set({ heartbeatAt, leaseExpiresAt })
      .where(and(eq(taskAttempts.id, attemptId), inArray(taskAttempts.status, ['claimed', 'running'])))
      .returning({ id: taskAttempts.id });
    return result.length === 1;
  }

  async finishTaskAttempt(
    attemptId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'expired',
    options: { completedAt?: string; error?: string | null; resultSummary?: string | null; retryable?: boolean } = {},
  ): Promise<boolean> {
    const completedAt = options.completedAt ?? new Date().toISOString();
    const result = await this.db.update(taskAttempts).set({
      status,
      completedAt,
      heartbeatAt: completedAt,
      leaseExpiresAt: completedAt,
      error: options.error,
      resultSummary: options.resultSummary,
      retryable: options.retryable ?? false,
    }).where(and(eq(taskAttempts.id, attemptId), inArray(taskAttempts.status, ['claimed', 'running'])))
      .returning({ id: taskAttempts.id });
    return result.length === 1;
  }

  async expireStaleTaskAttempts(cutoff: string, completedAt = new Date().toISOString()): Promise<TaskAttemptSelect[]> {
    return this.db.update(taskAttempts).set({
      status: 'expired', completedAt, heartbeatAt: completedAt, leaseExpiresAt: completedAt,
      retryable: true, error: 'Runtime session lease expired before completion was confirmed',
    }).where(and(
      inArray(taskAttempts.status, ['claimed', 'running']),
      lte(taskAttempts.leaseExpiresAt, cutoff),
    )).returning();
  }

  async expireOrphanedTaskAttempts(completedAt = new Date().toISOString()): Promise<TaskAttemptSelect[]> {
    return this.db.update(taskAttempts).set({
      status: 'expired', completedAt, heartbeatAt: completedAt, leaseExpiresAt: completedAt,
      retryable: true, error: 'Runtime host restarted before session completion was confirmed',
    }).where(inArray(taskAttempts.status, ['claimed', 'running'])).returning();
  }

  async listTaskAttempts(taskId: string): Promise<TaskAttemptSelect[]> {
    return this.db.select().from(taskAttempts).where(eq(taskAttempts.taskId, taskId));
  }

  /**
   * Create a project-aware isolated worktree for a task.
   * Parent workspaces can contain several repositories; task title/description is
   * used only as a deterministic project hint, never as a shell command.
   */
  async createWorktreeForTask(taskId: string, baseBranch: string = 'HEAD', candidateSuffix?: string): Promise<string> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task with ID "${taskId}" not found`);

    const mission = await this.getMission(task.missionId);
    let workspacePath = process.cwd();
    if (mission?.workspaceId) {
      const workspace = await this.getWorkspace(mission.workspaceId);
      if (workspace?.path) workspacePath = workspace.path;
    }

    const projectHint = `${task.title}\n${task.description}`;
    const isolationBase = await this.worktreeManager.resolveIsolationBase(workspacePath, projectHint);
    const projectBasePath = isolationBase.path;
    const branchName = candidateSuffix
      ? `atris/mission-${task.missionId}/task-${taskId}-${candidateSuffix}`
      : `atris/mission-${task.missionId}/task-${taskId}`;
    const worktreeSubDir = candidateSuffix ? `task-${taskId}-${candidateSuffix}` : `task-${taskId}`;
    const worktreeDir = path.join(projectBasePath, '.atris-worktrees', `mission-${task.missionId}`, worktreeSubDir);

    const createdPath = await this.worktreeManager.createWorktree(
      projectBasePath,
      branchName,
      worktreeDir,
      baseBranch,
      projectHint,
    );

    const now = new Date().toISOString();
    const worktreeRecord: WorktreeInsert = {
      id: crypto.randomUUID(),
      missionId: task.missionId,
      taskId,
      branchName,
      path: createdPath,
      status: 'active',
      createdAt: now,
    };

    try {
      await this.db.insert(worktrees).values(worktreeRecord);
    } catch {
      // A resumed/revision attempt may already have a persisted worktree row.
    }

    await this.updateTask(taskId, { worktreeId: createdPath });
    return createdPath;
  }

  /** Remove worktree for task. */
  async removeWorktreeForTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || !task.worktreeId) return;

    await this.worktreeManager.removeWorktree(task.worktreeId);
    await this.updateTask(taskId, { worktreeId: null });
    await this.db.update(worktrees).set({ status: 'abandoned' }).where(eq(worktrees.taskId, taskId));
  }
}
