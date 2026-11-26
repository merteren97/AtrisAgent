import { create } from 'zustand';
import type {
  OrchestratorRoutingDefaults,
  RuntimeAdapterCapabilities,
} from '@atris-agent-code/domain';
import { apiRequest } from '@/lib/api-client';

export type CanvasViewMode = 'dag' | 'swimlane' | 'pipeline';
export type OrchestratorLayoutPreset = 'chat' | 'split' | 'canvas';

export interface GraphTaskRoutePreference {
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: string;
  fallbackCatalogIds?: string[];
  selectionMode?: string;
  modelDisplayName?: string;
  routeLabel?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface GraphTaskNode {
  id: string;
  missionId: string;
  planId: string | null;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignedAgentId: string | null;
  assignedRole: string | null;
  agentProfileId: string | null;
  specialty: string | null;
  routePreference: GraphTaskRoutePreference | null;
  requiredCapabilities: string[];
  dependsOn: string[];
  worktreeId: string | null;
  targetDescriptor: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GraphDependencyEdge {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
}

export interface GraphAttempt {
  id: string;
  taskId: string;
  missionId: string;
  agentInstanceId: string;
  agentProfileId: string | null;
  attemptNumber: number;
  status: string;
  worktreePath: string | null;
  runtimeSessionId: string | null;
  providerSessionId: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  retryable: boolean;
  claimedAt: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  resultSummary: string | null;
  routeAdapterId: string | null;
  routeProvider: string | null;
  routeAccountProfileId: string | null;
  routeModelCatalogId: string | null;
  routeRuntimeModelId: string | null;
  routeReasoningLevel: string | null;
  routeSource: string | null;
  routeSelectionMode: string | null;
}

export interface GraphAgent {
  id: string;
  missionId: string;
  role: string;
  sandboxTier: 'inspect' | 'implement' | 'verify' | string;
  profileId: string | null;
  agentProfileId: string | null;
  modelProfileId: string;
  accountProfileId: string;
  runtimeAdapterId: string;
  sessionId: string | null;
  status: string;
  taskId: string | null;
  parentAgentId: string | null;
  displayName: string | null;
  specialty: string | null;
  spawnReason: string | null;
  statusMessage: string | null;
  progress: number | null;
  workspaceMode: string | null;
  worktreeId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface GraphApproval {
  id: string;
  missionId: string;
  taskId: string | null;
  runId: string | null;
  type: string;
  description: string;
  status: string;
  decidedBy: string | null;
  requestedDecision: string | null;
  executionError: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface GraphQuestion {
  id: string;
  missionId?: string;
  question?: string;
  status?: string;
  options?: unknown[];
  [key: string]: unknown;
}

export interface GraphDirective {
  id: string;
  missionId: string;
  turnId: string | null;
  targetAgentId: string | null;
  delivery: string;
  content: string;
  attachmentIds: string[];
  status: string;
  createdAt: string;
  appliedAt: string | null;
}

export interface GraphMissionSummary {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: string;
  teamTemplateId?: string | null;
  planId: string | null;
  activeRunId: string | null;
  executionMode?: string | null;
  automationPolicy?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MissionGraphSnapshot {
  sequence: number;
  mission: GraphMissionSummary;
  activePlanId: string | null;
  plans: Array<{ id: string; isActive: boolean; taskCount: number }>;
  runs: Array<{
    id: string;
    missionId: string;
    turnId: string | null;
    commandId: string | null;
    status: string;
    planId: string | null;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    heartbeatAt: string | null;
  }>;
  turns: Array<Record<string, unknown>>;
  tasks: GraphTaskNode[];
  dependencies: GraphDependencyEdge[];
  attempts: GraphAttempt[];
  agents: GraphAgent[];
  approvals: GraphApproval[];
  questions: GraphQuestion[];
  directives: GraphDirective[];
  runtimeCapabilities?: Record<string, RuntimeAdapterCapabilities>;
  routingDefaults?: OrchestratorRoutingDefaults;
}

export const ORCHESTRATOR_NODE_ID = '__orchestrator__';
export const VERIFICATION_GATE_ID = '__verification_gate__';

export interface SchematicGraphStructure {
  activeTasks: GraphTaskNode[];
  rawEdges: Array<{ id: string; source: string; target: string }>;
  layoutNodes: Array<{ id: string; width: number; height: number }>;
  hasGate: boolean;
  builderTasks: GraphTaskNode[];
  structuralKey: string;
}

export function selectActivePlanTasks(snapshot: MissionGraphSnapshot): GraphTaskNode[] {
  return snapshot.activePlanId
    ? snapshot.tasks.filter((task) => task.planId === snapshot.activePlanId)
    : snapshot.tasks;
}

export function buildSchematicGraphStructure(
  snapshot: MissionGraphSnapshot,
): SchematicGraphStructure {
  const activeTasks = selectActivePlanTasks(snapshot);
  const taskIds = new Set(activeTasks.map((t) => t.id));
  const incomingCounts = new Map<string, number>();
  const edgeKeys = new Set<string>();
  const rawEdges: Array<{ id: string; source: string; target: string }> = [];

  for (const dep of snapshot.dependencies) {
    if (!taskIds.has(dep.taskId) || !taskIds.has(dep.dependsOnTaskId)) continue;
    if (dep.taskId === dep.dependsOnTaskId) continue;
    const key = `${dep.dependsOnTaskId}->${dep.taskId}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    rawEdges.push({
      id: dep.id || `dep:${key}`,
      source: dep.dependsOnTaskId,
      target: dep.taskId,
    });
    incomingCounts.set(dep.taskId, (incomingCounts.get(dep.taskId) || 0) + 1);
  }

  for (const task of activeTasks) {
    if ((incomingCounts.get(task.id) || 0) === 0) {
      rawEdges.push({
        id: `root->${task.id}`,
        source: ORCHESTRATOR_NODE_ID,
        target: task.id,
      });
    }
  }

  const builderTasks = activeTasks.filter((task) => {
    const agent = snapshot.agents.find((a) => a.id === task.assignedAgentId || a.taskId === task.id);
    return (agent?.role || task.assignedRole) === 'builder';
  });

  const hasGate = builderTasks.length > 0;
  if (hasGate) {
    const hasOutgoingTaskEdge = new Set(
      rawEdges
        .filter((e) => taskIds.has(e.source) && taskIds.has(e.target))
        .map((e) => e.source),
    );
    for (const task of activeTasks) {
      if (!hasOutgoingTaskEdge.has(task.id)) {
        rawEdges.push({
          id: `${task.id}->gate`,
          source: task.id,
          target: VERIFICATION_GATE_ID,
        });
      }
    }
  }

  const layoutNodes = [
    { id: ORCHESTRATOR_NODE_ID, width: 248, height: 108 },
    ...activeTasks.map((t) => ({ id: t.id, width: 272, height: 132 })),
    ...(hasGate ? [{ id: VERIFICATION_GATE_ID, width: 216, height: 76 }] : []),
  ];

  const structuralKey = `${layoutNodes.map((n) => n.id).sort().join(',')}|${rawEdges
    .map((e) => `${e.source}->${e.target}`)
    .sort()
    .join(',')}`;

  return { activeTasks, rawEdges, layoutNodes, hasGate, builderTasks, structuralKey };
}

export interface TaskRouteUpdateInput {
  modelCatalogId: string;
  reasoningLevel?: string;
  accountProfileId?: string;
}

interface OrchestrationGraphState {
  snapshotsByMission: Record<string, MissionGraphSnapshot>;
  loadingByMission: Record<string, boolean>;
  errorByMission: Record<string, string | null>;
  selectedNodeId: string | null;
  selectedAgentId: string | null;
  canvasMode: CanvasViewMode;
  layoutPreset: OrchestratorLayoutPreset;
  hydrateMissionGraph: (missionId: string) => Promise<void>;
  applyMissionEvent: (missionId: string, event: Record<string, unknown>) => void;
  selectNode: (nodeId: string | null, agentId?: string | null) => void;
  setCanvasMode: (mode: CanvasViewMode) => void;
  setLayoutPreset: (preset: OrchestratorLayoutPreset) => void;
  updateTaskRoute: (missionId: string, taskId: string, route: TaskRouteUpdateInput) => Promise<void>;
}

const HYDRATE_THROTTLE_MS = 450;
const HYDRATE_REFRESH_EVENTS = new Set([
  'stream_gap',
  'plan_generated',
  'plan_revised',
  'agent_spawned',
  'approval_requested',
  'approval_responded',
]);

const hydrateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastHydrateAt = new Map<string, number>();
const hydrateRequestCounter = new Map<string, number>();

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function roleToSandboxTier(role?: string | null): 'inspect' | 'implement' | 'verify' {
  if (role === 'builder') return 'implement';
  if (role === 'reviewer' || role === 'qa') return 'verify';
  return 'inspect';
}

function scheduleThrottledHydration(missionId: string, hydrate: (id: string) => Promise<void>): void {
  const now = Date.now();
  const prev = lastHydrateAt.get(missionId) || 0;
  const elapsed = now - prev;

  if (elapsed >= HYDRATE_THROTTLE_MS && !hydrateTimers.has(missionId)) {
    lastHydrateAt.set(missionId, now);
    void hydrate(missionId);
    return;
  }

  if (hydrateTimers.has(missionId)) return;
  const delay = Math.max(50, HYDRATE_THROTTLE_MS - elapsed);
  const timer = setTimeout(() => {
    hydrateTimers.delete(missionId);
    lastHydrateAt.set(missionId, Date.now());
    void hydrate(missionId);
  }, delay);
  hydrateTimers.set(missionId, timer);
}

export function resetOrchestrationGraphThrottle(): void {
  for (const timer of hydrateTimers.values()) clearTimeout(timer);
  hydrateTimers.clear();
  lastHydrateAt.clear();
  hydrateRequestCounter.clear();
}

function patchTaskInList(
  tasks: GraphTaskNode[],
  taskId: string | undefined,
  patch: Partial<GraphTaskNode>,
): GraphTaskNode[] {
  if (!taskId) return tasks;
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    changed = true;
    return { ...task, ...patch };
  });
  return changed ? next : tasks;
}

function upsertAgentInList(
  agents: GraphAgent[],
  event: Record<string, unknown>,
  patch: Partial<GraphAgent>,
): GraphAgent[] {
  const agentId = str(event.agentInstanceId);
  if (!agentId) return agents;
  const existing = agents.find((agent) => agent.id === agentId);
  if (existing) {
    return agents.map((agent) => (agent.id === agentId ? { ...agent, ...patch } : agent));
  }
  const role = str(event.role) || str(event.agentRole) || 'builder';
  const created: GraphAgent = {
    id: agentId,
    missionId: str(event.missionId) || '',
    role,
    sandboxTier: roleToSandboxTier(role),
    profileId: str(event.profileId) ?? null,
    agentProfileId: str(event.agentProfileId) ?? null,
    modelProfileId: str(event.model) || '',
    accountProfileId: str(event.accountProfileId) || '',
    runtimeAdapterId: str(event.runtimeAdapterId) || '',
    sessionId: str(event.sessionId) ?? null,
    status: patch.status || 'idle',
    taskId: str(event.taskId) ?? null,
    parentAgentId: str(event.parentAgentId) ?? null,
    displayName: str(event.displayName) ?? null,
    specialty: str(event.specialty) ?? null,
    spawnReason: str(event.spawnReason) ?? null,
    statusMessage: patch.statusMessage ?? null,
    progress: patch.progress ?? null,
    workspaceMode: str(event.workspaceMode) ?? null,
    worktreeId: str(event.worktreePath) ?? null,
    startedAt: patch.startedAt ?? null,
    completedAt: patch.completedAt ?? null,
    createdAt: str(event.timestamp) || new Date().toISOString(),
    ...patch,
  };
  return [...agents, created];
}

export const useOrchestrationGraphStore = create<OrchestrationGraphState>((set, get) => ({
  snapshotsByMission: {},
  loadingByMission: {},
  errorByMission: {},
  selectedNodeId: null,
  selectedAgentId: null,
  canvasMode: 'dag',
  layoutPreset: 'split',

  hydrateMissionGraph: async (missionId: string) => {
    if (!missionId) return;
    const requestToken = (hydrateRequestCounter.get(missionId) || 0) + 1;
    hydrateRequestCounter.set(missionId, requestToken);
    set((state) => ({
      loadingByMission: { ...state.loadingByMission, [missionId]: true },
      errorByMission: { ...state.errorByMission, [missionId]: null },
    }));
    try {
      const snapshot = await apiRequest<MissionGraphSnapshot>(
        `/missions/${encodeURIComponent(missionId)}/graph`,
      );
      if (hydrateRequestCounter.get(missionId) !== requestToken) {
        return;
      }
      set((state) => {
        const existing = state.snapshotsByMission[missionId];
        if (existing && snapshot.sequence < existing.sequence) {
          return {
            loadingByMission: { ...state.loadingByMission, [missionId]: false },
            errorByMission: { ...state.errorByMission, [missionId]: null },
          };
        }
        return {
          snapshotsByMission: { ...state.snapshotsByMission, [missionId]: snapshot },
          loadingByMission: { ...state.loadingByMission, [missionId]: false },
          errorByMission: { ...state.errorByMission, [missionId]: null },
        };
      });
    } catch (error) {
      if (hydrateRequestCounter.get(missionId) !== requestToken) {
        return;
      }
      set((state) => ({
        loadingByMission: { ...state.loadingByMission, [missionId]: false },
        errorByMission: {
          ...state.errorByMission,
          [missionId]: error instanceof Error ? error.message : 'Failed to load mission graph',
        },
      }));
    }
  },

  applyMissionEvent: (missionId: string, event: Record<string, unknown>) => {
    if (!missionId || !event || typeof event.type !== 'string') return;
    const eventType = event.type;
    const eventSeq = typeof event.sequence === 'number' ? event.sequence : undefined;
    const currentSnapshot = get().snapshotsByMission[missionId];

    if (currentSnapshot && eventSeq !== undefined && eventSeq <= currentSnapshot.sequence) {
      return;
    }

    if (HYDRATE_REFRESH_EVENTS.has(eventType)) {
      scheduleThrottledHydration(missionId, get().hydrateMissionGraph);
    }

    if (!currentSnapshot) return;

    const timestamp = str(event.timestamp) || new Date().toISOString();
    let nextMission = currentSnapshot.mission;
    let nextTasks = currentSnapshot.tasks;
    let nextAgents = currentSnapshot.agents;
    let nextApprovals = currentSnapshot.approvals;
    let nextDirectives = currentSnapshot.directives;

    switch (eventType) {
      case 'mission_started':
        nextMission = { ...nextMission, status: 'running', updatedAt: timestamp };
        break;
      case 'mission_completed':
        nextMission = { ...nextMission, status: 'completed', completedAt: timestamp, updatedAt: timestamp };
        break;
      case 'mission_failed':
        nextMission = { ...nextMission, status: 'failed', updatedAt: timestamp };
        break;
      case 'task_created': {
        const taskId = str(event.taskId);
        if (taskId && !nextTasks.some((t) => t.id === taskId)) {
          nextTasks = [
            ...nextTasks,
            {
              id: taskId,
              missionId,
              planId: str(event.planId) ?? nextMission.planId,
              title: str(event.title) || taskId,
              description: str(event.description) || '',
              status: 'ready',
              priority: typeof event.priority === 'number' ? event.priority : 0,
              assignedAgentId: str(event.agentInstanceId) ?? null,
              assignedRole: str(event.assignedRole) ?? null,
              agentProfileId: str(event.agentProfileId) ?? null,
              specialty: str(event.specialty) ?? null,
              routePreference: null,
              requiredCapabilities: [],
              dependsOn: Array.isArray(event.dependsOn) ? (event.dependsOn as string[]) : [],
              worktreeId: null,
              targetDescriptor: null,
              createdAt: timestamp,
              updatedAt: timestamp,
              completedAt: null,
            },
          ];
        } else {
          nextTasks = patchTaskInList(nextTasks, taskId, {
            status: 'ready',
            ...(str(event.assignedRole) ? { assignedRole: str(event.assignedRole)! } : {}),
            ...(str(event.agentInstanceId) ? { assignedAgentId: str(event.agentInstanceId)! } : {}),
            updatedAt: timestamp,
          });
        }
        break;
      }
      case 'task_assigned':
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'ready',
          ...(str(event.role) ? { assignedRole: str(event.role)! } : {}),
          ...(str(event.agentInstanceId) ? { assignedAgentId: str(event.agentInstanceId)! } : {}),
          updatedAt: timestamp,
        });
        break;
      case 'task_claimed':
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'claimed',
          ...(str(event.agentInstanceId) ? { assignedAgentId: str(event.agentInstanceId)! } : {}),
          ...(str(event.worktreePath) ? { worktreeId: str(event.worktreePath)! } : {}),
          updatedAt: timestamp,
        });
        break;
      case 'task_completed':
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'done',
          completedAt: timestamp,
          updatedAt: timestamp,
        });
        if (str(event.agentInstanceId)) {
          nextAgents = upsertAgentInList(nextAgents, event, {
            status: 'completed',
            progress: 100,
            completedAt: timestamp,
          });
        }
        break;
      case 'task_failed':
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'failed',
          updatedAt: timestamp,
        });
        if (str(event.agentInstanceId)) {
          nextAgents = upsertAgentInList(nextAgents, event, {
            status: 'failed',
            statusMessage: str(event.error) || 'Execution failed',
            completedAt: timestamp,
          });
        }
        break;
      case 'revision_requested':
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'revision_requested',
          updatedAt: timestamp,
        });
        nextMission = { ...nextMission, status: 'revising', updatedAt: timestamp };
        break;
      case 'agent_spawned':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'idle',
          progress: 0,
        });
        break;
      case 'agent_started':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'running',
          startedAt: timestamp,
        });
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'running',
          ...(str(event.agentInstanceId) ? { assignedAgentId: str(event.agentInstanceId)! } : {}),
          ...(str(event.role) ? { assignedRole: str(event.role)! } : {}),
          updatedAt: timestamp,
        });
        break;
      case 'agent_progressed':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'running',
          statusMessage: str(event.progress) ?? undefined,
          ...(typeof event.percentage === 'number' ? { progress: event.percentage } : {}),
        });
        break;
      case 'agent_waiting':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'waiting',
          statusMessage: str(event.reason) || 'Waiting',
        });
        break;
      case 'agent_resumed':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'running',
          statusMessage: str(event.reason) || 'Resumed',
        });
        break;
      case 'agent_completed':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'completed',
          progress: 100,
          statusMessage: str(event.summary) || 'Completed',
          completedAt: timestamp,
        });
        break;
      case 'agent_cancelled':
        nextAgents = upsertAgentInList(nextAgents, event, {
          status: 'cancelled',
          statusMessage: str(event.reason) || 'Cancelled',
          completedAt: timestamp,
        });
        nextTasks = patchTaskInList(nextTasks, str(event.taskId), {
          status: 'cancelled',
          updatedAt: timestamp,
        });
        break;
      case 'agent_tool_call':
      case 'tool_call_started':
        if (str(event.agentInstanceId)) {
          nextAgents = upsertAgentInList(nextAgents, event, {
            statusMessage: `Using ${str(event.toolName) || 'tool'}`,
          });
        }
        break;
      case 'tool_call_completed':
        if (str(event.agentInstanceId)) {
          nextAgents = upsertAgentInList(nextAgents, event, {
            statusMessage: `${str(event.toolName) || 'Tool'} ${event.success ? 'completed' : 'failed'}`,
          });
        }
        break;
      case 'file_changed':
        if (str(event.agentInstanceId)) {
          nextAgents = upsertAgentInList(nextAgents, event, {
            statusMessage: `${str(event.changeType) || 'Modified'} ${str(event.path) || ''}`.trim(),
          });
        }
        break;
      case 'approval_requested': {
        const approvalId = str(event.approvalId) || str(event.id);
        nextMission = { ...nextMission, status: 'waiting_for_approval', updatedAt: timestamp };
        if (approvalId && !nextApprovals.some((a) => a.id === approvalId)) {
          nextApprovals = [
            ...nextApprovals,
            {
              id: approvalId,
              missionId,
              taskId: str(event.taskId) ?? null,
              runId: str(event.runId) ?? null,
              type: str(event.approvalType) || 'action',
              description: str(event.description) || 'Approval required',
              status: 'pending',
              decidedBy: null,
              requestedDecision: null,
              executionError: null,
              createdAt: timestamp,
              decidedAt: null,
            },
          ];
        }
        break;
      }
      case 'approval_responded': {
        const approvalId = str(event.approvalId);
        const approved = typeof event.approved === 'boolean' ? event.approved : undefined;
        if (approvalId) {
          nextApprovals = nextApprovals.map((approval) => (
            approval.id === approvalId
              ? {
                  ...approval,
                  status: approved === undefined ? approval.status : approved ? 'approved' : 'rejected',
                  decidedBy: str(event.decidedBy) ?? approval.decidedBy,
                  decidedAt: timestamp,
                }
              : approval
          ));
        }
        break;
      }
      case 'turn_steered': {
        const directiveId = str(event.directiveId) || str(event.id);
        if (directiveId && !nextDirectives.some((d) => d.id === directiveId)) {
          nextDirectives = [
            ...nextDirectives,
            {
              id: directiveId,
              missionId,
              turnId: str(event.turnId) ?? null,
              targetAgentId: str(event.targetAgentId) ?? null,
              delivery: str(event.delivery) || 'steer',
              content: str(event.content) || '',
              attachmentIds: Array.isArray(event.attachmentIds) ? (event.attachmentIds as string[]) : [],
              status: 'queued',
              createdAt: timestamp,
              appliedAt: null,
            },
          ];
        }
        break;
      }
      case 'verification_started':
        nextMission = { ...nextMission, status: 'verifying', updatedAt: timestamp };
        break;
      default:
        break;
    }

    const nextSequence = eventSeq !== undefined && eventSeq > currentSnapshot.sequence
      ? eventSeq
      : currentSnapshot.sequence;

    set((state) => ({
      snapshotsByMission: {
        ...state.snapshotsByMission,
        [missionId]: {
          ...currentSnapshot,
          sequence: nextSequence,
          mission: nextMission,
          tasks: nextTasks,
          agents: nextAgents,
          approvals: nextApprovals,
          directives: nextDirectives,
        },
      },
    }));
  },

  selectNode: (nodeId, agentId = null) => {
    set({ selectedNodeId: nodeId, selectedAgentId: agentId ?? null });
  },

  setCanvasMode: (mode) => {
    set({ canvasMode: mode });
  },

  setLayoutPreset: (preset) => {
    set({ layoutPreset: preset });
  },

  updateTaskRoute: async (missionId, taskId, route) => {
    await apiRequest(`/missions/${encodeURIComponent(missionId)}/tasks/${encodeURIComponent(taskId)}/route`, {
      method: 'PATCH',
      body: JSON.stringify(route),
    });
    await get().hydrateMissionGraph(missionId);
  },
}));
