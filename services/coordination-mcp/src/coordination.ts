import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { Orchestrator } from '@atris-agent-code/orchestration-core';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { AgentMessage, AgentRole, AgentSpawnRequest, AgentStatus, AgentWorkspaceMode } from '@atris-agent-code/domain';
import { approvals, artifacts, type AtrisDatabase } from '@atris-agent-code/database';
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
    this.eventBus?.on('*', (event) => this.syncAgentEvent(event));
  }

  private syncAgentEvent(event: AgentEvent): void {
    const existing = 'agentInstanceId' in event && event.agentInstanceId
      ? this.agentRegistry.get(event.agentInstanceId)
      : undefined;

    if (event.type === 'agent_spawned') {
      this.agentRegistry.set(event.agentInstanceId, {
        id: event.agentInstanceId,
        missionId: event.missionId,
        role: event.role,
        displayName: event.displayName,
        specialty: event.specialty,
        parentAgentId: event.parentAgentId,
        taskId: event.taskId,
        model: event.model,
        status: 'idle',
        workspaceMode: event.workspaceMode,
        spawnReason: event.spawnReason,
        createdAt: event.timestamp,
      });
      return;
    }

    if (event.type === 'agent_started') {
      this.agentRegistry.set(event.agentInstanceId, {
        id: event.agentInstanceId,
        missionId: event.missionId,
        role: event.role,
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

    if (!existing) return;
    if (event.type === 'agent_progressed') {
      this.agentRegistry.set(existing.id, {
        ...existing,
        status: 'running',
        statusMessage: event.progress,
        progress: event.percentage ?? existing.progress,
      });
    } else if (event.type === 'agent_waiting') {
      this.agentRegistry.set(existing.id, { ...existing, status: 'waiting', statusMessage: event.reason });
    } else if (event.type === 'agent_resumed') {
      this.agentRegistry.set(existing.id, { ...existing, status: 'running', statusMessage: event.reason });
    } else if (event.type === 'agent_completed') {
      this.agentRegistry.set(existing.id, { ...existing, status: 'completed', statusMessage: event.summary, progress: 100, completedAt: event.timestamp });
    } else if (event.type === 'agent_error' || event.type === 'task_failed') {
      this.agentRegistry.set(existing.id, { ...existing, status: 'failed', statusMessage: event.error, completedAt: event.timestamp });
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

    const activeCount = [...this.agentRegistry.values()].filter((agent) =>
      agent.missionId === request.missionId && ['idle', 'running', 'waiting'].includes(agent.status)).length;
    if (activeCount >= DEFAULT_MAX_PARALLEL) {
      throw new Error(`Mission parallel-agent limit reached (${DEFAULT_MAX_PARALLEL}). Wait for an active agent to complete before spawning another.`);
    }

    const agentInstanceId = crypto.randomUUID();
    const role = request.role;
    const displayName = request.displayName?.trim() || request.specialty?.trim() || this.defaultAgentName(role);
    const workspaceMode: AgentWorkspaceMode = request.workspaceMode
      || (role === 'builder' ? 'isolated_worktree' : role === 'orchestrator' ? 'shared' : 'read_only');

    let task;
    if (request.taskId) {
      task = await this.requireTask(request.taskId);
      if (task.missionId !== request.missionId) throw new Error('Cannot assign a sub-agent to a task from another mission.');
      task = await this.workspaceManager.updateTask(task.id, {
        assignedAgentId: agentInstanceId,
        assignedRole: role,
        status: 'planned',
      });
    } else {
      task = await this.workspaceManager.createTask({
        missionId: request.missionId,
        title: displayName,
        description: request.instruction.trim(),
        status: 'planned',
        priority: request.priority || 'medium',
        assignedAgentId: agentInstanceId,
        assignedRole: role,
        requiredCapabilities: request.capabilities || [],
        dependsOn: [],
      });
    }

    const timestamp = new Date().toISOString();
    this.agentRegistry.set(agentInstanceId, {
      id: agentInstanceId,
      missionId: request.missionId,
      role,
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
    this.eventBus?.emit({ id: crypto.randomUUID(), type: 'task_claimed', missionId: task.missionId, taskId, agentInstanceId: agentId, worktreePath: null, timestamp: new Date().toISOString() });
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
    await this.workspaceManager!.updateTask(taskId, { status: status === 'done' ? 'done' : 'rejected' });
    if (status === 'done') {
      this.eventBus?.emit({ id: crypto.randomUUID(), type: 'task_completed', missionId: task.missionId, taskId, agentInstanceId: task.assignedAgentId || undefined, result: resultSummary, timestamp: new Date().toISOString() });
    } else {
      this.eventBus?.emit({ id: crypto.randomUUID(), type: 'task_failed', missionId: task.missionId, taskId, agentInstanceId: task.assignedAgentId || undefined, error: resultSummary, timestamp: new Date().toISOString() });
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
