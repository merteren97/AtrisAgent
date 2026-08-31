import { and, desc, eq, inArray, lte, max } from 'drizzle-orm';
import {
  workspaces,
  missions,
  tasks,
  taskAttempts,
  worktrees,
  agentInstances,
  teamRoles,
  teamTemplates,
  executionPolicies,
  conversationTurns,
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
  CanonicalReasoning,
  RouteSelectionMode,
  EffectiveAttemptRoute,
  EffectiveWorkerPoolPolicy,
} from '@atris-agent-code/domain';
import { resolveWorkerPoolPolicy } from '@atris-agent-code/domain';

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
  route: {
    adapterId: string;
    provider?: string | null;
    accountProfileId?: string | null;
    modelCatalogId?: string | null;
    runtimeModelId?: string | null;
    reasoningLevel?: CanonicalReasoning | null;
    source: RoutingPreferenceSource;
    selectionMode: RouteSelectionMode;
  };
}

export interface SupervisorSessionMetadata {
  providerSessionId?: string;
  resumeCapability: 'none' | 'live' | 'restart';
  route: ClaimTaskAttemptInput['route'];
  updatedAt: string;
}

export interface ReserveAgentCapacityInput {
  id: string;
  missionId: string;
  role: AgentRole;
  modelProfileId?: string;
  parentAgentId?: string | null;
  displayName: string;
  specialty?: string | null;
  spawnReason: string;
  workspaceMode: string;
  createdAt: string;
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

  async resolveMissionWorkerPoolPolicy(missionId: string): Promise<EffectiveWorkerPoolPolicy> {
    const mission = await this.getMission(missionId);
    if (!mission?.teamTemplateId) return resolveWorkerPoolPolicy();
    const template = (await this.db.select().from(teamTemplates).where(eq(teamTemplates.id, mission.teamTemplateId)))[0];
    return resolveWorkerPoolPolicy(template ? {
      maxParallelAgents: template.maxParallelAgents ?? undefined,
      workerPools: template.workerPools ?? undefined,
    } : undefined);
  }

  async reserveAgentCapacity(input: ReserveAgentCapacityInput): Promise<void> {
    this.db.transaction((tx) => {
      const mission = (tx.select().from(missions).where(eq(missions.id, input.missionId)) as any).get() as MissionSelect | undefined;
      if (!mission) throw new Error(`Mission ${input.missionId} was not found.`);
      const template = mission.teamTemplateId
        ? (tx.select().from(teamTemplates).where(eq(teamTemplates.id, mission.teamTemplateId)) as any).get() as typeof teamTemplates.$inferSelect | undefined
        : undefined;
      const policy = resolveWorkerPoolPolicy(template ? {
        maxParallelAgents: template.maxParallelAgents ?? undefined,
        workerPools: template.workerPools ?? undefined,
      } : undefined);
      const rolePool = policy.pools.find((pool) => pool.role === input.role);
      if (!rolePool) throw new Error(`Agent role ${input.role} is not supported by the effective worker pool.`);
      const roleLimit = Math.min(rolePool.maxInstances, rolePool.maxParallel ?? rolePool.maxInstances);

      const activeQuery = tx.select({ role: agentInstances.role }).from(agentInstances)
        .where(and(eq(agentInstances.missionId, input.missionId), inArray(agentInstances.status, ['idle', 'running', 'waiting'])));
      const active = (activeQuery as any).all() as Array<{ role: AgentRole }>;
      if (active.length >= policy.maxParallelAgents) {
        throw new Error(`Mission parallel-agent limit reached (${policy.maxParallelAgents}). Wait for an active agent to complete before spawning another.`);
      }
      if (active.filter((agent) => agent.role === input.role).length >= roleLimit) {
        throw new Error(`Mission ${input.role} parallel-agent limit reached (${roleLimit}). Wait for an active ${input.role} agent to complete before spawning another.`);
      }

      tx.insert(agentInstances).values({
        id: input.id,
        missionId: input.missionId,
        role: input.role,
        modelProfileId: input.modelProfileId || '',
        accountProfileId: '',
        runtimeAdapterId: '',
        status: 'idle',
        parentAgentId: input.parentAgentId || null,
        displayName: input.displayName,
        specialty: input.specialty || null,
        spawnReason: input.spawnReason,
        workspaceMode: input.workspaceMode,
        createdAt: input.createdAt,
      }).run();
    });
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
  async listTasks(missionId: string): Promise<Array<TaskSelect & { effectiveRoute?: EffectiveAttemptRoute | null }>> {
    const missionTasks = await this.db.select().from(tasks).where(eq(tasks.missionId, missionId));
    if (!missionTasks.length) return missionTasks;
    const attempts = await this.db.select().from(taskAttempts)
      .where(inArray(taskAttempts.taskId, missionTasks.map((task) => task.id)))
      .orderBy(desc(taskAttempts.attemptNumber));
    const latestByTask = new Map<string, TaskAttemptSelect>();
    for (const attempt of attempts) if (!latestByTask.has(attempt.taskId)) latestByTask.set(attempt.taskId, attempt);
    return missionTasks.map((task) => {
      const attempt = latestByTask.get(task.id);
      if (!attempt?.routeAdapterId || !attempt.routeSource || !attempt.routeSelectionMode) return task;
      return { ...task, effectiveRoute: {
        adapterId: attempt.routeAdapterId,
        provider: attempt.routeProvider,
        accountProfileId: attempt.routeAccountProfileId,
        modelCatalogId: attempt.routeModelCatalogId,
        runtimeModelId: attempt.routeRuntimeModelId,
        reasoningLevel: attempt.routeReasoningLevel,
        source: attempt.routeSource,
        selectionMode: attempt.routeSelectionMode,
      } };
    });
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

  async saveSupervisorSessionMetadata(turnId: string, metadata: SupervisorSessionMetadata): Promise<void> {
    const rows = await this.db.select().from(conversationTurns).where(eq(conversationTurns.id, turnId));
    const turn = rows[0];
    if (!turn) return;
    await this.db.update(conversationTurns).set({
      options: { ...(turn.options || {}), supervisorSession: metadata },
    }).where(eq(conversationTurns.id, turnId));
  }

  async getLatestSupervisorSessionMetadata(missionId: string): Promise<SupervisorSessionMetadata | undefined> {
    const rows = await this.db.select().from(conversationTurns)
      .where(eq(conversationTurns.missionId, missionId)).orderBy(desc(conversationTurns.createdAt));
    for (const turn of rows) {
      const metadata = turn.options?.supervisorSession as SupervisorSessionMetadata | undefined;
      if (metadata?.route?.adapterId && metadata.resumeCapability) return metadata;
    }
    return undefined;
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
        routeAdapterId: input.route.adapterId,
        routeProvider: input.route.provider ?? null,
        routeAccountProfileId: input.route.accountProfileId ?? null,
        routeModelCatalogId: input.route.modelCatalogId ?? null,
        routeRuntimeModelId: input.route.runtimeModelId ?? null,
        routeReasoningLevel: input.route.reasoningLevel ?? null,
        routeSource: input.route.source,
        routeSelectionMode: input.route.selectionMode,
        providerSessionId: null,
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

  async markTaskAttemptRunning(attemptId: string, runtimeSessionId: string, heartbeatAt: string, leaseExpiresAt: string, providerSessionId?: string | null): Promise<boolean> {
    const result = await this.db.update(taskAttempts).set({
      status: 'running', runtimeSessionId, providerSessionId: providerSessionId ?? null, heartbeatAt, leaseExpiresAt,
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

  async removeMissionWorktrees(missionId: string): Promise<void> {
    const records = await this.db.select().from(worktrees).where(eq(worktrees.missionId, missionId));
    const missionTasks = await this.listTasks(missionId);
    const paths = new Set([
      ...records.map((record) => record.path),
      ...missionTasks.map((task) => task.worktreeId).filter((value): value is string => Boolean(value)),
    ]);
    for (const worktreePath of paths) await this.worktreeManager.removeWorktree(worktreePath);
    for (const task of missionTasks.filter((item) => item.worktreeId)) await this.updateTask(task.id, { worktreeId: null });
    await this.db.update(worktrees).set({ status: 'abandoned' }).where(eq(worktrees.missionId, missionId));
  }

  removeWorkspaceCheckpoints(workspacePath: string): void {
    this.checkpointManager.removeWorkspaceCheckpoints(workspacePath);
  }
}
