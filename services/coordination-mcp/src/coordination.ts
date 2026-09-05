import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { Orchestrator } from '@atris-agent-code/orchestration-core';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { AgentMessage, AgentRole, AgentSpawnRequest, AgentStatus, AgentWorkspaceMode } from '@atris-agent-code/domain';
import { agentInstances, agentMessages, approvals, artifacts, type AtrisDatabase } from '@atris-agent-code/database';
import { eq } from 'drizzle-orm';
import { ResourceLeaseManager } from './resource-lease-manager';

export interface CoordinationOptions {
  workspaceManager?: WorkspaceManager;
  orchestrator?: Orchestrator;
  eventBus?: LocalEventBus;
  db?: AtrisDatabase;
  workspacePath?: string;
}

interface RuntimeAgentState {
  id: string;
  missionId: string;
  role: AgentRole | string;
  /** Canonical named profile identity. */
  agentProfileId?: string;
  /** @deprecated Use agentProfileId. Kept for older MCP clients and rows. */
  profileId?: string;
  displayName: string;
  specialty?: string;
  parentAgentId?: string | null;
  taskId?: string | null;
  model?: string;
  status: AgentStatus;
  statusMessage?: string;
  progress?: number;
  workspaceMode?: AgentWorkspaceMode;
  spawnReason?: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CHILDREN = 4;
const DEFAULT_MAX_PARALLEL = 6;
const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export class CoordinationMCP {
  private workspaceManager?: WorkspaceManager;
  private orchestrator?: Orchestrator;
  private eventBus?: LocalEventBus;
  private db?: AtrisDatabase;
  private workspacePath: string;
  private leaseManager = new ResourceLeaseManager();
  private agentRegistry = new Map<string, RuntimeAgentState>();
  private mailboxes = new Map<string, AgentMessage[]>();

  private async requireTask(taskId: string) {
    const task = await this.workspaceManager?.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} was not found in the active workspace.`);
    return task;
  }

  constructor(options: CoordinationOptions = {}) {
    this.workspaceManager = options.workspaceManager;
    this.orchestrator = options.orchestrator;
    this.eventBus = options.eventBus;
    this.db = options.db;
    this.workspacePath = options.workspacePath || process.cwd();
    this.hydrateDurableState();
    this.eventBus?.on('*', (event) => this.syncAgentEvent(event));
  }

  private hydrateDurableState(): void {
    if (!this.db) return;
    try {
      let rows: Array<Record<string, any>>;
      try {
        rows = (this.db.select().from(agentInstances) as any).all() as Array<Record<string, any>>;
      } catch {
        // A standalone MCP database may be on the profile_id compatibility
        // column before the canonical agent_profile_id migration runs.
        rows = (this.db.select({
          id: agentInstances.id,
          missionId: agentInstances.missionId,
          role: agentInstances.role,
          profileId: agentInstances.profileId,
          modelProfileId: agentInstances.modelProfileId,
          status: agentInstances.status,
          taskId: agentInstances.taskId,
          parentAgentId: agentInstances.parentAgentId,
          displayName: agentInstances.displayName,
          specialty: agentInstances.specialty,
          spawnReason: agentInstances.spawnReason,
          statusMessage: agentInstances.statusMessage,
          progress: agentInstances.progress,
          workspaceMode: agentInstances.workspaceMode,
          startedAt: agentInstances.startedAt,
          completedAt: agentInstances.completedAt,
          createdAt: agentInstances.createdAt,
        }).from(agentInstances) as any).all() as Array<Record<string, any>>;
      }
      for (const row of rows) {
        this.agentRegistry.set(row.id, {
          id: row.id,
          missionId: row.missionId,
          role: row.role,
          agentProfileId: row.agentProfileId || row.profileId || undefined,
          profileId: row.agentProfileId || row.profileId || undefined,
          displayName: row.displayName || this.defaultAgentName(row.role),
          specialty: row.specialty || undefined,
          parentAgentId: row.parentAgentId || null,
          taskId: row.taskId || null,
          model: row.modelProfileId || undefined,
          status: row.status || 'idle',
          statusMessage: row.statusMessage || undefined,
          progress: row.progress ?? undefined,
          workspaceMode: row.workspaceMode || undefined,
          spawnReason: row.spawnReason || undefined,
          createdAt: row.createdAt,
          startedAt: row.startedAt || null,
          completedAt: row.completedAt || null,
        });
      }
      const messages = (this.db.select().from(agentMessages) as any).all() as Array<Record<string, any>>;
      for (const row of messages) {
        const message: AgentMessage = {
          id: row.id,
          missionId: row.missionId,
          fromAgentId: row.fromAgentId,
          toAgentId: row.toAgentId,
          content: row.content,
          createdAt: row.createdAt,
          readAt: row.readAt || null,
          kind: row.kind || 'message',
          replyToMessageId: row.replyToMessageId || null,
        };
        const mailbox = this.mailboxes.get(message.toAgentId) || [];
        mailbox.push(message);
        this.mailboxes.set(message.toAgentId, mailbox);
      }
    } catch (error) {
      // Optional coordination tables may not exist for an older standalone
      // MCP database; migrations will hydrate them on the next startup.
      console.warn('[CoordinationMCP] Durable agent state could not be hydrated:', error);
    }
  }

  private saveAgentState(agent: RuntimeAgentState): void {
    const agentProfileId = agent.agentProfileId || agent.profileId || undefined;
    const normalizedAgent = { ...agent, agentProfileId, profileId: agentProfileId };
    this.agentRegistry.set(agent.id, normalizedAgent);
    if (!this.db) return;
    const values = {
      id: agent.id,
      missionId: agent.missionId,
      role: agent.role as any,
      // profile_id is the physical compatibility column used by existing
      // coordination databases; the in-memory/API contract is canonical.
      profileId: agentProfileId || null,
      agentProfileId: agentProfileId || null,
      modelProfileId: agent.model || '',
      accountProfileId: '',
      runtimeAdapterId: '',
      sessionId: null,
      status: agent.status,
      taskId: agent.taskId || null,
      parentAgentId: agent.parentAgentId || null,
      displayName: agent.displayName,
      specialty: agent.specialty || null,
      spawnReason: agent.spawnReason || null,
      statusMessage: agent.statusMessage || null,
      progress: agent.progress ?? null,
      workspaceMode: agent.workspaceMode || null,
      startedAt: agent.startedAt || null,
      completedAt: agent.completedAt || null,
      createdAt: agent.createdAt,
    };
    const updates = {
      target: agentInstances.id,
      set: {
        missionId: agent.missionId,
        role: agent.role as any,
        profileId: agentProfileId || null,
        agentProfileId: agentProfileId || null,
        modelProfileId: agent.model || '',
        status: agent.status,
        taskId: agent.taskId || null,
        parentAgentId: agent.parentAgentId || null,
        displayName: agent.displayName,
        specialty: agent.specialty || null,
        spawnReason: agent.spawnReason || null,
        statusMessage: agent.statusMessage || null,
        progress: agent.progress ?? null,
        workspaceMode: agent.workspaceMode || null,
        startedAt: agent.startedAt || null,
        completedAt: agent.completedAt || null,
      },
    };
    try {
      (this.db.insert(agentInstances).values(values).onConflictDoUpdate(updates) as any).run();
    } catch (error) {
      // Standalone/older coordination stores may have profile_id but not the
      // canonical column yet. Preserve the durable compatibility path until
      // the next database migration instead of dropping the agent state.
      const { agentProfileId: _canonicalInsert, ...legacyValues } = values;
      const { set, ...legacyUpdates } = updates;
      const { agentProfileId: _canonicalSet, ...legacySet } = set;
      (this.db.insert(agentInstances).values(legacyValues).onConflictDoUpdate({
        ...legacyUpdates,
        set: legacySet,
      }) as any).run();
      void error;
    }
  }

  private syncAgentEvent(event: AgentEvent): void {
    const existing = 'agentInstanceId' in event && event.agentInstanceId
      ? this.agentRegistry.get(event.agentInstanceId)
      : undefined;

    if (event.type === 'agent_spawned') {
      this.saveAgentState({
        id: event.agentInstanceId,
        missionId: event.missionId,
        role: event.role,
        agentProfileId: event.agentProfileId || event.profileId,
        profileId: event.agentProfileId || event.profileId,
        displayName: event.displayName,
        specialty: event.specialty,
        parentAgentId: event.parentAgentId,
        taskId: event.taskId,
        model: event.model === 'scheduler-selected' ? existing?.model || event.model : event.model || existing?.model,
        status: 'idle',
        workspaceMode: event.workspaceMode,
        spawnReason: event.spawnReason,
        createdAt: event.timestamp,
      });
      return;
    }

    if (event.type === 'agent_started') {
      this.saveAgentState({
        id: event.agentInstanceId,
        missionId: event.missionId,
        role: event.role,
        agentProfileId: event.agentProfileId || event.profileId || existing?.agentProfileId || existing?.profileId,
        profileId: event.agentProfileId || event.profileId || existing?.agentProfileId || existing?.profileId,
        displayName: event.displayName || existing?.displayName || this.defaultAgentName(event.role),
        specialty: event.specialty || existing?.specialty,
        parentAgentId: event.parentAgentId ?? existing?.parentAgentId,
        taskId: event.taskId ?? existing?.taskId,
        model: event.model || existing?.model,
        status: 'running',
        workspaceMode: event.workspaceMode || existing?.workspaceMode,
        spawnReason: event.spawnReason || existing?.spawnReason,
        createdAt: existing?.createdAt || event.timestamp,
        startedAt: event.timestamp,
      });
      return;
    }

    if (existing && (event.type === 'task_created' || event.type === 'task_assigned' || event.type === 'task_claimed')
      && 'agentProfileId' in event && event.agentProfileId) {
      this.saveAgentState({
        ...existing,
        agentProfileId: event.agentProfileId,
        profileId: event.agentProfileId,
        taskId: 'taskId' in event ? event.taskId : existing.taskId,
      });
      return;
    }

    if (!existing) return;
    if (event.type === 'agent_progressed') {
      this.saveAgentState({
        ...existing,
        status: 'running',
        statusMessage: event.progress,
        progress: event.percentage ?? existing.progress,
      });
    } else if (event.type === 'agent_waiting') {
      this.saveAgentState({ ...existing, status: 'waiting', statusMessage: event.reason });
    } else if (event.type === 'agent_resumed') {
      this.saveAgentState({ ...existing, status: 'running', statusMessage: event.reason });
    } else if (event.type === 'agent_completed') {
      this.saveAgentState({ ...existing, status: 'completed', statusMessage: event.summary, progress: 100, completedAt: event.timestamp });
    } else if (event.type === 'agent_error' || event.type === 'task_failed') {
      this.saveAgentState({ ...existing, status: 'failed', statusMessage: event.error, completedAt: event.timestamp });
    }
  }

  private defaultAgentName(role: string): string {
    if (role === 'qa') return 'QA Agent';
    return `${role.charAt(0).toUpperCase()}${role.slice(1)} Agent`;
  }

  private depthForAgent(agentId?: string | null): number {
    if (!agentId) return -1;
    let depth = 0;
    let cursor = this.agentRegistry.get(agentId);
    const visited = new Set<string>();
    while (cursor?.parentAgentId && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      depth += 1;
      cursor = this.agentRegistry.get(cursor.parentAgentId);
    }
    return depth;
  }

  async spawnAgent(request: AgentSpawnRequest): Promise<{ agentInstanceId: string; taskId: string; status: 'scheduled' }> {
    if (!this.workspaceManager) throw new Error('Dynamic sub-agent spawning requires a WorkspaceManager.');
    if (!request.instruction?.trim()) throw new Error('Sub-agent instruction is required.');
    if (!request.spawnReason?.trim()) throw new Error('Sub-agent spawn reason is required for auditability.');

    const mission = await this.workspaceManager.getMission(request.missionId);
    if (!mission) throw new Error(`Mission ${request.missionId} was not found.`);
    if (TERMINAL_MISSION_STATUSES.has(String(mission.status))) {
      throw new Error(`Mission ${request.missionId} is ${mission.status}; terminal missions cannot spawn new sub-agents.`);
    }

    if (request.parentAgentId) {
      const parentDepth = this.depthForAgent(request.parentAgentId);
      if (parentDepth >= DEFAULT_MAX_DEPTH) {
        throw new Error(`Agent spawn depth limit reached (${DEFAULT_MAX_DEPTH}). Delegate through an existing sibling or return work to the orchestrator.`);
      }
      const childCount = [...this.agentRegistry.values()].filter((agent) => agent.parentAgentId === request.parentAgentId && agent.status !== 'failed').length;
      if (childCount >= DEFAULT_MAX_CHILDREN) {
        throw new Error(`Agent child limit reached (${DEFAULT_MAX_CHILDREN}) for parent ${request.parentAgentId}.`);
      }
    }

    const agentInstanceId = crypto.randomUUID();
    const role = request.role;
    const agentProfileId = String(request.agentProfileId || request.profileId || '').trim() || undefined;
    const displayName = request.displayName?.trim() || request.specialty?.trim() || this.defaultAgentName(role);
    const workspaceMode: AgentWorkspaceMode = request.workspaceMode
      || (role === 'builder' ? 'isolated_worktree' : role === 'orchestrator' ? 'shared' : 'read_only');
    const timestamp = new Date().toISOString();

    await this.workspaceManager.reserveAgentCapacity({
      id: agentInstanceId,
      missionId: request.missionId,
      role,
      modelProfileId: request.modelCatalogId || request.modelProfileId,
      agentProfileId,
      parentAgentId: request.parentAgentId || null,
      displayName,
      specialty: request.specialty,
      spawnReason: request.spawnReason.trim(),
      workspaceMode,
      createdAt: timestamp,
    });

    let task;
    if (request.taskId) {
      task = await this.requireTask(request.taskId);
      if (task.missionId !== request.missionId) throw new Error('Cannot assign a sub-agent to a task from another mission.');
      const taskUpdates: Parameters<WorkspaceManager['updateTask']>[1] = {
        assignedAgentId: agentInstanceId,
        assignedRole: role,
        status: 'planned',
      };
      if (agentProfileId !== undefined) taskUpdates.agentProfileId = agentProfileId;
      task = await this.workspaceManager.updateTask(task.id, taskUpdates);
    } else {
      task = await this.workspaceManager.createTask({
        missionId: request.missionId,
        title: displayName,
        description: request.instruction.trim(),
        status: 'planned',
        priority: request.priority || 'medium',
        assignedAgentId: agentInstanceId,
        assignedRole: role,
        agentProfileId,
        requiredCapabilities: request.capabilities || [],
        dependsOn: [],
      });
    }

    this.saveAgentState({
      id: agentInstanceId,
      missionId: request.missionId,
      role,
      agentProfileId,
      profileId: agentProfileId,
      displayName,
      specialty: request.specialty,
      parentAgentId: request.parentAgentId || null,
      taskId: task.id,
      model: request.modelCatalogId || request.modelProfileId,
      status: 'idle',
      workspaceMode,
      spawnReason: request.spawnReason.trim(),
      createdAt: timestamp,
    });

    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: 'agent_spawned',
      missionId: request.missionId,
      agentInstanceId,
      parentAgentId: request.parentAgentId || null,
      role,
      agentProfileId,
      profileId: agentProfileId,
      displayName,
      specialty: request.specialty,
      spawnReason: request.spawnReason.trim(),
      taskId: task.id,
      model: request.modelCatalogId || request.modelProfileId || 'scheduler-selected',
      workspaceMode,
      timestamp,
    });
    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: 'task_assigned',
      missionId: request.missionId,
      taskId: task.id,
      agentInstanceId,
      role,
      agentProfileId,
      timestamp,
    });
    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: 'task_created',
      missionId: request.missionId,
      taskId: task.id,
      title: task.title,
      assignedRole: role,
      agentInstanceId,
      parentAgentId: request.parentAgentId || null,
      agentProfileId,
      profileId: agentProfileId,
      displayName,
      specialty: request.specialty,
      spawnReason: request.spawnReason.trim(),
      workspaceMode,
      modelCatalogId: request.modelCatalogId || request.modelProfileId,
      accountProfileId: request.accountProfileId,
      reasoningLevel: request.reasoningLevel,
      fallbackCatalogIds: request.fallbackCatalogIds,
      routeSelectionMode: request.routeSelectionMode,
      timestamp,
    });

    return { agentInstanceId, taskId: task.id, status: 'scheduled' };
  }

  listAgents(missionId?: string): RuntimeAgentState[] {
    return [...this.agentRegistry.values()]
      .filter((agent) => !missionId || agent.missionId === missionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async sendAgentMessage(input: {
    missionId: string;
    fromAgentId: string;
    toAgentId: string;
    content: string;
    kind?: AgentMessage['kind'];
    replyToMessageId?: string;
  }): Promise<AgentMessage> {
    if (!input.content?.trim()) throw new Error('Agent message content is required.');
    if (!input.fromAgentId || !input.toAgentId) throw new Error('Both sender and target agent IDs are required.');
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      missionId: input.missionId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      content: input.content.trim(),
      kind: input.kind || 'message',
      replyToMessageId: input.replyToMessageId || null,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    if (this.db) {
      await this.db.insert(agentMessages).values({
        id: message.id,
        missionId: message.missionId,
        fromAgentId: message.fromAgentId,
        toAgentId: message.toAgentId,
        content: message.content,
        createdAt: message.createdAt,
        readAt: null,
        kind: message.kind || 'message',
        replyToMessageId: message.replyToMessageId || null,
      });
    }
    const mailbox = this.mailboxes.get(input.toAgentId) || [];
    mailbox.push(message);
    this.mailboxes.set(input.toAgentId, mailbox);
    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: 'agent_message_sent',
      missionId: input.missionId,
      messageId: message.id,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      content: message.content,
      kind: message.kind || 'message',
      replyToMessageId: message.replyToMessageId,
      timestamp: message.createdAt,
    });
    return message;
  }

  readAgentMessages(agentId: string, unreadOnly = true, markRead = true): AgentMessage[] {
    const mailbox = this.mailboxes.get(agentId) || [];
    const selected = mailbox.filter((message) => !unreadOnly || !message.readAt);
    if (!markRead || selected.length === 0) return selected;
    const readIds = new Set(selected.map((message) => message.id));
    const readAt = new Date().toISOString();
    if (this.db) {
      for (const message of selected) {
        (this.db.update(agentMessages).set({ readAt }).where(eq(agentMessages.id, message.id)) as any).run();
      }
    }
    this.mailboxes.set(agentId, mailbox.map((message) => readIds.has(message.id) ? { ...message, readAt } : message));
    for (const message of selected) {
      this.eventBus?.emit({
        id: crypto.randomUUID(),
        type: 'agent_message_read',
        missionId: message.missionId,
        messageId: message.id,
        agentInstanceId: agentId,
        timestamp: readAt,
      });
    }
    return selected.map((message) => ({ ...message, readAt }));
  }

  async getWorkspaceContext(workspacePath?: string, missionId?: string, taskId?: string): Promise<Record<string, unknown>> {
    let tasks: any[] = [];
    let mission: any = null;

    if (this.orchestrator && missionId) {
      const state = await this.orchestrator.getMissionState(missionId);
      mission = state.mission;
      tasks = state.tasks;
    }
    if (this.workspaceManager && missionId) {
      // The persisted mission/workspace record is authoritative for paths. In
      // packaged mode process.cwd() is the runtime data directory, not the
      // user's project, so never let it shadow the registered workspace.
      const persistedMission = await this.workspaceManager.getMission(missionId);
      if (persistedMission) {
        mission = persistedMission;
      }
      if (!tasks.length) {
        tasks = await this.workspaceManager.listTasks(missionId);
      }
    }

    let targetPath = workspacePath || this.workspacePath;
    if (missionId && this.workspaceManager && mission?.workspaceId && typeof (this.workspaceManager as any).getWorkspace === 'function') {
      const workspace = await this.workspaceManager.getWorkspace(mission.workspaceId);
      if (workspace?.path) targetPath = workspace.path;
    }

    if (missionId && taskId && this.workspaceManager) {
      const persistedTask = typeof (this.workspaceManager as any).getTask === 'function'
        ? await this.workspaceManager.getTask(taskId)
        : tasks.find((task) => task.id === taskId && task.missionId === missionId);
      if (persistedTask?.missionId === missionId && typeof persistedTask.worktreeId === 'string' && persistedTask.worktreeId.trim()) {
        targetPath = persistedTask.worktreeId;
      }
    }

    const registeredAgents = this.listAgents(missionId);
    return {
      workspacePath: targetPath,
      missionId: missionId || mission?.id || null,
      missionTitle: mission?.title || 'Active Mission Context',
      missionStatus: mission?.status || 'active',
      executionMode: mission?.executionMode || 'balanced',
      tasksCount: tasks.length,
      activeAgents: registeredAgents.length
        ? registeredAgents.filter((agent) => ['idle', 'running', 'waiting'].includes(agent.status))
        : tasks.filter((t) => t.status === 'running').map((t) => ({ taskId: t.id, role: t.assignedRole, agentId: t.assignedAgentId, title: t.title })),
      agentLimits: { maxDepth: DEFAULT_MAX_DEPTH, maxChildren: DEFAULT_MAX_CHILDREN, maxParallel: DEFAULT_MAX_PARALLEL },
    };
  }

  async getActivePlan(missionId: string): Promise<Record<string, unknown>> {
    if (this.orchestrator) {
      const state = await this.orchestrator.getMissionState(missionId);
      return { mission: state.mission, tasks: state.tasks, completedCount: state.tasks.filter((t) => t.status === 'done').length };
    }
    if (this.workspaceManager) {
      const tasks = await this.workspaceManager.listTasks(missionId);
      const mission = await this.workspaceManager.getMission(missionId);
      return { mission, tasks, completedCount: tasks.filter((t) => t.status === 'done').length };
    }
    return { missionId, tasks: [], completedCount: 0 };
  }

  async claimTask(taskId: string, agentId: string, role?: string): Promise<{ success: boolean; taskId: string }> {
    const task = await this.requireTask(taskId);
    await this.workspaceManager!.updateTask(taskId, {
      status: 'running', assignedAgentId: agentId, assignedRole: (role as any) || task.assignedRole || 'builder',
    });
    const taskProfileId = (task as any).agentProfileId || (task as any).profileId || undefined;
    this.eventBus?.emit({ id: crypto.randomUUID(), type: 'task_claimed', missionId: task.missionId, taskId, agentInstanceId: agentId, agentProfileId: taskProfileId, worktreePath: null, timestamp: new Date().toISOString() });
    return { success: true, taskId };
  }

  async reportProgress(taskId: string, progressText: string, percentage?: number, _details?: unknown): Promise<void> {
    const task = await this.requireTask(taskId);
    this.eventBus?.emit({
      id: crypto.randomUUID(), type: 'agent_progressed', missionId: task.missionId, taskId,
      agentInstanceId: task.assignedAgentId || 'unassigned-agent', progress: progressText,
      percentage: percentage === undefined ? undefined : Math.max(0, Math.min(100, percentage)), timestamp: new Date().toISOString(),
    });
  }

  async submitResult(taskId: string, resultSummary: string, _reviewPack?: unknown, _artifactsList?: string[], status: 'done' | 'failed' = 'done'): Promise<void> {
    const task = await this.requireTask(taskId);
    if (status === 'done') {
      this.eventBus?.emit({ id: crypto.randomUUID(), type: 'task_completed', missionId: task.missionId, taskId, agentInstanceId: task.assignedAgentId || undefined, agentProfileId: (task as any).agentProfileId || (task as any).profileId || undefined, result: resultSummary, timestamp: new Date().toISOString() });
    } else {
      this.eventBus?.emit({ id: crypto.randomUUID(), type: 'task_failed', missionId: task.missionId, taskId, agentInstanceId: task.assignedAgentId || undefined, agentProfileId: (task as any).agentProfileId || (task as any).profileId || undefined, error: resultSummary, timestamp: new Date().toISOString() });
    }
  }

  async requestApproval(
    missionId: string,
    type: 'command_execution' | 'file_edit' | 'dependency_install' | 'plan_step' | 'destructive_action' | 'candidate_selection',
    description: string,
    taskId?: string
  ): Promise<string> {
    const approvalId = crypto.randomUUID();
    const now = new Date().toISOString();
    if (this.db) {
      await this.db.insert(approvals).values({ id: approvalId, missionId, taskId: taskId || null, type: type as any, description, status: 'pending', createdAt: now });
    }
    this.eventBus?.emit({ id: crypto.randomUUID(), type: 'approval_requested', missionId, taskId, approvalId, approvalType: type, description, timestamp: now } as any);
    return approvalId;
  }

  async publishArtifact(
    missionId: string,
    name: string,
    type: 'diff' | 'test_report' | 'log' | 'review_pack' | 'build_output',
    content?: string,
    artifactPath?: string,
    taskId?: string
  ): Promise<{ artifactId: string; name: string }> {
    const artifactId = crypto.randomUUID();
    const now = new Date().toISOString();
    if (this.db) {
      await this.db.insert(artifacts).values({ id: artifactId, missionId, taskId: taskId || null, type: type as any, name, content: content || null, path: artifactPath || null, createdAt: now });
    }
    return { artifactId, name };
  }

  async getAgentActivity(agentId?: string, missionId?: string): Promise<Record<string, unknown>> {
    const agent = agentId ? this.agentRegistry.get(agentId) : undefined;
    if (!this.workspaceManager || !missionId) {
      return { agent: agent || null, agentId: agentId || null, missionId: missionId || null, status: agent?.status || 'unknown', tasks: [] };
    }
    const tasks = await this.workspaceManager.listTasks(missionId);
    const matching = agentId ? tasks.filter((task) => task.assignedAgentId === agentId) : tasks;
    return {
      agent: agent || null,
      agentId: agentId || null,
      missionId,
      status: agent?.status || (matching.some((task) => task.status === 'running') ? 'running' : matching.length > 0 ? 'idle' : 'unknown'),
      unreadMessages: agentId ? (this.mailboxes.get(agentId) || []).filter((message) => !message.readAt).length : 0,
      children: agentId ? this.listAgents(missionId).filter((candidate) => candidate.parentAgentId === agentId) : [],
      tasks: matching.map((task) => ({ id: task.id, title: task.title, role: task.assignedRole, status: task.status })),
    };
  }

  async getChangedFiles(taskId: string): Promise<{ taskId: string; worktreePath: string | null; files: Array<{ path: string; status: string }> }> {
    if (!this.workspaceManager) throw new Error('Changed-file inspection requires a WorkspaceManager.');
    const task = await this.requireTask(taskId);
    if (!task.worktreeId) return { taskId, worktreePath: null, files: [] };
    const files = await this.workspaceManager.getWorktreeManager().getChangedFiles(task.worktreeId);
    return { taskId, worktreePath: task.worktreeId, files };
  }

  async reserveResource(resourceType: string, heldByAgentId: string, resourceId?: string, ttlSeconds: number = 300, metadata?: Record<string, unknown>): Promise<string> {
    const result = await this.leaseManager.reserveLease(resourceType, heldByAgentId, resourceId, ttlSeconds, metadata, this.db);
    return result.leaseId;
  }
  async releaseResource(leaseId: string): Promise<void> { await this.leaseManager.releaseLease(leaseId, this.db); }
  async heartbeatLease(leaseId: string, ttlSeconds: number = 300): Promise<{ expiresAt: string }> { return await this.leaseManager.heartbeatLease(leaseId, ttlSeconds, this.db); }

  async getWorkspaceRules(workspaceId?: string): Promise<Record<string, unknown>> {
    return {
      workspaceId: workspaceId || 'current', trustMode: 'balanced', pathTraversalAllowed: false,
      commandPrefixAllowlist: ['npm', 'git', 'node', 'npx', 'cargo', 'python', 'go'],
      restrictedPaths: ['.git', 'node_modules', '.env', '.env.local'],
      agentLimits: { maxDepth: DEFAULT_MAX_DEPTH, maxChildren: DEFAULT_MAX_CHILDREN, maxParallel: DEFAULT_MAX_PARALLEL },
      writeAgentsRequireIsolation: true,
      reviewerShouldDifferFromBuilder: true,
    };
  }

  getLeaseManager(): ResourceLeaseManager { return this.leaseManager; }
}
