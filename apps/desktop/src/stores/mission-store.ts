import { create } from 'zustand';
import { apiRequest } from '@/lib/api-client';
import { useAgentStore } from '@/stores/agent-store';

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

export interface Mission {
  id: string;
  workspaceId: string;
  title: string;
  status: MissionStatus;
  createdAt: string;
  checkpointId?: string;
  taskCount?: number;
  description?: string;
  planId?: string | null;
}

export interface TaskItem {
  id: string;
  missionId: string;
  planId?: string;
  title: string;
  description: string;
  status: string;
  assignedRole?: string | null;
  assignedAgentId?: string | null;
  worktreeId?: string | null;
}

export interface TimelineItem {
  id: string;
  type: 'user_message' | 'orchestrator_message' | 'event';
  content: string;
  timestamp: string;
  eventType?: string;
  agentRole?: string;
  metadata?: Record<string, unknown>;
}

export interface StartMissionOptions {
  model?: string;
  reasoningLevel?: string;
  teamTemplate?: string;
  trustMode?: string;
  executionMode?: string;
  targetRole?: string;
  /** Route override scope without changing which role the mission DAG starts with. */
  routeRole?: string;
  /** A selected mission route applies to every compatible child role by default. */
  routeScope?: 'mission' | 'role';
  command?: string;
}

export interface QueuedMissionTurn {
  id: string;
  missionId: string;
  request: string;
  options?: StartMissionOptions;
  queuedAt: string;
}

interface MissionState {
  missions: Mission[];
  activeMissionId: string | null;
  hydratedMissionId: string | null;
  timeline: TimelineItem[];
  activeTasks: TaskItem[];
  queuedTurns: QueuedMissionTurn[];
  loading: boolean;
  error: string | null;
  fetchMissions: (workspaceId?: string) => Promise<void>;
  fetchMissionState: (missionId: string) => Promise<void>;
  startMission: (request: string, workspaceId?: string, options?: StartMissionOptions) => Promise<void>;
  continueMission: (missionId: string, request: string, options?: StartMissionOptions, skipOptimisticUserMessage?: boolean) => Promise<void>;
  queueMissionTurn: (missionId: string, request: string, options?: StartMissionOptions) => void;
  drainQueuedTurn: (missionId: string) => Promise<void>;
  deleteMission: (id: string) => Promise<boolean>;
  addMission: (mission: Mission) => void;
  setActiveMission: (id: string) => void;
  clearActiveMission: () => void;
  updateMissionStatus: (id: string, status: MissionStatus) => void;
  addTimelineItem: (item: TimelineItem) => void;
  setTasks: (tasks: TaskItem[]) => void;
  patchTask: (id: string, updates: Partial<TaskItem>) => void;
  pauseMission: (id: string) => Promise<void>;
  stopMission: (id: string) => Promise<void>;
  retryMission: (id: string) => Promise<void>;
  missionFilter: 'all' | 'active' | 'review' | 'blocked';
  setMissionFilter: (filter: 'all' | 'active' | 'review' | 'blocked') => void;
  composerInput?: string;
  setComposerInput: (input: string) => void;
}

const TERMINAL_CONVERSATION_STATUSES = new Set<MissionStatus>(['completed', 'failed', 'cancelled']);
const AUTO_DRAIN_CONVERSATION_STATUSES = new Set<MissionStatus>(['completed', 'failed']);
const drainingQueuedMissions = new Set<string>();

function toExecutionMode(options?: StartMissionOptions): string {
  if (options?.executionMode) return options.executionMode;
  if (options?.trustMode === 'Review Driven') return 'review_driven';
  if (options?.trustMode === 'Autonomous') return 'autonomous';
  if (options?.trustMode === 'Candidate') return 'candidate';
  return 'balanced';
}

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function eventLabel(event: Record<string, any>): string {
  switch (event.type) {
    case 'user_message': return event.content || '';
    case 'mission_started': return `Mission started: ${event.title || event.missionId}`;
    case 'plan_generated': return event.summary || `Generated ${event.taskCount || 0} tasks.`;
    case 'plan_revised': return `Plan revised: ${event.reason || 'Execution evidence changed the plan.'}`;
    case 'task_created': return `Task ready: ${event.title || event.taskId}`;
    case 'task_assigned': return `Task assigned to ${event.role}: ${event.taskId}`;
    case 'task_claimed': return `Execution context prepared for ${event.taskId}.`;
    case 'task_split': return `Task split into ${event.childTaskIds?.length || 0} focused tasks: ${event.reason || ''}`;
    case 'task_merged': return `Tasks merged into ${event.mergedTaskId}: ${event.reason || ''}`;
    case 'agent_spawned': return `${event.displayName || event.role || 'Agent'} spawned: ${event.spawnReason || 'Specialized work required.'}`;
    case 'agent_started': return `${event.displayName || event.role || 'Agent'} started with ${event.model || 'a runtime-selected model'}.`;
    case 'agent_progressed': return event.progress || 'Agent progress updated.';
    case 'agent_waiting': return `Agent waiting: ${event.reason || 'Waiting for a dependency.'}`;
    case 'agent_resumed': return `Agent resumed${event.reason ? `: ${event.reason}` : '.'}`;
    case 'agent_completed': return event.summary || 'Agent completed its execution.';
    case 'agent_cancelled': return `Agent cancelled: ${event.reason || 'Mission cancelled.'}`;
    case 'agent_message_sent': return `${String(event.fromAgentId || 'agent').slice(0, 8)} → ${String(event.toAgentId || 'agent').slice(0, 8)}: ${event.content || ''}`;
    case 'agent_message_read': return `Agent message read by ${String(event.agentInstanceId || 'agent').slice(0, 8)}.`;
    case 'agent_context_attached': return `Context attached: ${event.label || event.sourceType || 'context'}`;
    case 'agent_context_compacted': return `Context compacted${event.beforeTokens && event.afterTokens ? `: ${event.beforeTokens} → ${event.afterTokens} tokens` : '.'}`;
    case 'agent_thought': return event.thought || 'Agent is reasoning.';
    case 'text_delta': return event.content || '';
    case 'tool_call_started': case 'agent_tool_call': return `Tool started: ${event.toolName || 'tool'}`;
    case 'tool_call_completed': return `${event.toolName || 'Tool'} ${event.success ? 'completed' : 'failed'}.`;
    case 'file_changed': return `${event.changeType || 'Modified'} ${event.path}`;
    case 'approval_requested': return event.description || 'Approval required.';
    case 'approval_responded': return typeof event.approved === 'boolean'
      ? `Approval ${event.approved ? 'approved' : 'rejected'} by ${event.decidedBy || 'user'}.`
      : 'Approval decision recorded.';
    case 'verification_started': return 'Verification started.';
    case 'verification_finding': return `${String(event.severity || 'finding').toUpperCase()}: ${event.title || event.description || ''}`;
    case 'verification_completed': return `${event.passed ? 'Verification passed' : 'Verification found issues'} — ${event.summary || `${event.findingCount || 0} findings`}`;
    case 'review_completed': return event.approved ? 'Review approved.' : `Review requested changes: ${event.findings || ''}`;
    case 'revision_requested': return `Revision returned to the Builder: ${event.reason || ''}`;
    case 'check_completed': return `${event.checkName || 'Check'}: ${event.passed ? 'passed' : 'failed'} — ${event.summary || ''}`;
    case 'changes_applied': return `Changes applied. ${event.filesChanged || 0} files changed.`;
    case 'task_completed': return `Task completed: ${event.taskId}`;
    case 'task_failed': return `Execution failed: ${event.error || 'Unknown runtime error'}`;
    case 'agent_error': return `Runtime diagnostic: ${event.error || 'Unknown runtime diagnostic'}`;
    case 'mission_completed': return event.summary || 'Mission completed.';
    case 'mission_failed': return `Mission failed: ${event.reason || 'Unknown error'}`;
    default: return `Event: ${event.type}`;
  }
}

function timelineFromEvent(event: Record<string, any>): TimelineItem {
  const date = event.timestamp ? new Date(event.timestamp) : new Date();
  return {
    id: event.id || crypto.randomUUID(),
    type: event.type === 'user_message'
      ? 'user_message'
      : event.type === 'text_delta' || event.type === 'mission_completed'
        ? 'orchestrator_message'
        : 'event',
    content: eventLabel(event),
    timestamp: Number.isNaN(date.getTime()) ? nowLabel() : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    eventType: event.type,
    agentRole: event.type === 'user_message'
      ? undefined
      : event.role || event.agentRole
        || (event.type?.includes('verification') || event.type?.includes('review') ? 'reviewer' : event.type?.includes('check') ? 'qa' : undefined),
    metadata: event,
  };
}

export type ApprovalDecision = 'approved' | 'rejected';

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'approved' || value === 'rejected';
}

export function approvalDecisionFor(
  eventType: string | undefined,
  metadata?: Record<string, unknown>,
): ApprovalDecision | null {
  const lifecycleStatus = metadata?.approvalStatus;
  if (isApprovalDecision(lifecycleStatus)) return lifecycleStatus;

  const persistedStatus = metadata?.status;
  if (isApprovalDecision(persistedStatus)) return persistedStatus;

  const decision = metadata?.decision;
  if (isApprovalDecision(decision)) return decision;

  if ((eventType === 'approval_requested' || eventType === 'approval_responded') && typeof metadata?.approved === 'boolean') {
    return metadata.approved ? 'approved' : 'rejected';
  }

  return null;
}

interface ApprovalResolution {
  decision: ApprovalDecision;
  decidedBy?: string;
  decidedAt?: string;
  responseEventId?: string;
}

function approvalResolutionFor(item: TimelineItem): ApprovalResolution | undefined {
  const decision = approvalDecisionFor(item.eventType, item.metadata);
  if (!decision) return undefined;

  return {
    decision,
    decidedBy: metadataString(item.metadata, 'decidedBy'),
    decidedAt: metadataString(item.metadata, 'decidedAt')
      || (item.eventType === 'approval_responded' ? metadataString(item.metadata, 'timestamp') : undefined),
    responseEventId: item.eventType === 'approval_responded' ? item.id : undefined,
  };
}

function approvalIdFor(item: TimelineItem): string | undefined {
  return metadataString(item.metadata, 'approvalId');
}

/** Links approval requests to persisted decisions without dropping either event from history. */
export function reconcileApprovalTimeline(items: TimelineItem[]): TimelineItem[] {
  const resolutions = new Map<string, ApprovalResolution>();
  const requestDetails = new Map<string, Record<string, unknown>>();

  for (const item of items) {
    const approvalId = approvalIdFor(item);
    if (!approvalId) continue;

    if (item.eventType === 'approval_requested') {
      const details: Record<string, unknown> = {};
      for (const key of ['approvalType', 'description', 'taskId', 'planId']) {
        const value = item.metadata?.[key];
        if (value !== undefined && value !== null && value !== '') details[key] = value;
      }
      if (details.description === undefined && item.content.trim()) details.description = item.content;
      requestDetails.set(approvalId, details);
    }

    const resolution = approvalResolutionFor(item);
    if (!resolution) continue;

    const existing = resolutions.get(approvalId);
    // A response event is authoritative over a request card that was already
    // reconciled during an earlier render or hydration pass.
    if (!existing || item.eventType === 'approval_responded' || !existing.responseEventId) {
      resolutions.set(approvalId, resolution);
    }
  }

  return items.map((item) => {
    const approvalId = approvalIdFor(item);
    if (!approvalId) return item;

    const resolution = item.eventType === 'approval_requested'
      ? resolutions.get(approvalId)
      : approvalResolutionFor(item);
    const inheritedDetails = requestDetails.get(approvalId);
    let metadata = item.metadata;

    if (item.eventType === 'approval_requested' && !resolution && approvalDecisionFor(item.eventType, metadata) === null) {
      metadata = { ...metadata, approvalStatus: 'pending' };
    }

    if (item.eventType === 'approval_responded' && inheritedDetails) {
      const mergedDetails = { ...metadata };
      for (const key of ['approvalType', 'description', 'taskId', 'planId']) {
        if ((mergedDetails[key] === undefined || mergedDetails[key] === null || mergedDetails[key] === '') && inheritedDetails[key] !== undefined) {
          mergedDetails[key] = inheritedDetails[key];
        }
      }
      metadata = mergedDetails;
    }

    if (resolution) {
      metadata = {
        ...metadata,
        approvalStatus: resolution.decision,
        approved: resolution.decision === 'approved',
        ...(resolution.decidedBy ? { decidedBy: resolution.decidedBy } : {}),
        ...(resolution.decidedAt ? { decidedAt: resolution.decidedAt } : {}),
        ...(resolution.responseEventId ? { approvalResponseId: resolution.responseEventId } : {}),
      };
    }

    return metadata === item.metadata ? item : { ...item, metadata };
  });
}

function requestBody(request: string, workspaceId: string | undefined, options?: StartMissionOptions): Record<string, unknown> {
  return {
    request,
    title: request,
    workspaceId,
    modelCatalogId: options?.model || undefined,
    reasoningLevel: options?.reasoningLevel || undefined,
    teamTemplate: options?.teamTemplate,
    trustMode: options?.trustMode,
    executionMode: toExecutionMode(options),
    targetRole: options?.targetRole,
    routeRole: options?.routeRole,
    routeScope: options?.routeScope,
    command: options?.command,
  };
}

export const useMissionStore = create<MissionState>((set, get) => ({
  missions: [],
  activeMissionId: null,
  hydratedMissionId: null,
  timeline: [],
  activeTasks: [],
  queuedTurns: [],
  loading: false,
  error: null,
  missionFilter: 'all',
  composerInput: '',

  setComposerInput: (input) => set({ composerInput: input }),
  setMissionFilter: (filter) => set({ missionFilter: filter }),

  fetchMissions: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      const fetched = await apiRequest<Mission[]>(`/missions${query}`);
      const current = get().activeMissionId;
      const nextActive = current && fetched.some((mission) => mission.id === current)
        ? current
        : fetched[0]?.id || null;
      const changedMission = current !== nextActive;

      if (changedMission) useAgentStore.getState().setSelectedAgent(null);
      set({
        missions: fetched,
        activeMissionId: nextActive,
        loading: false,
        ...(changedMission ? { timeline: [], activeTasks: [], hydratedMissionId: null } : {}),
      });

      if (nextActive && get().hydratedMissionId !== nextActive) {
        void get().fetchMissionState(nextActive);
      }
      if (!nextActive) {
        useAgentStore.getState().setSelectedAgent(null);
        set({ timeline: [], activeTasks: [], hydratedMissionId: null });
      }
    } catch (error: any) {
      set({ loading: false, error: error?.message || 'Failed to fetch missions.' });
    }
  },

  fetchMissionState: async (missionId) => {
    try {
      const [state, events] = await Promise.all([
        apiRequest<{ mission?: Mission & { description?: string }; tasks?: TaskItem[] }>(`/missions/${missionId}`),
        apiRequest<Array<Record<string, any>>>(`/missions/${missionId}/events`).catch(() => []),
      ]);

      const restoredTimeline: TimelineItem[] = [];
      if (state.mission) {
        restoredTimeline.push({
          id: `request-${state.mission.id}`,
          type: 'user_message',
          content: state.mission.description || state.mission.title,
          timestamp: new Date(state.mission.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
      }
      restoredTimeline.push(...reconcileApprovalTimeline(events.map(timelineFromEvent)));

      useAgentStore.getState().hydrateMissionFromEvents(missionId, events);

      set((current) => {
        const missions = state.mission
          ? current.missions.some((mission) => mission.id === missionId)
            ? current.missions.map((mission) => mission.id === missionId ? { ...mission, ...state.mission! } : mission)
            : [state.mission!, ...current.missions]
          : current.missions;

        if (current.activeMissionId !== missionId) return { missions };
        const restoredIds = new Set(restoredTimeline.map((item) => item.id));
        // Canonical persisted turns replace normal optimistic cards. Future turns
        // that are still queued remain visible until they actually start.
        const liveOnlyItems = current.timeline.filter((item) => (
          (item.type !== 'user_message' || item.metadata?.queued === true)
          && !restoredIds.has(item.id)
        ));
        const activePlanId = state.mission?.planId;
        const activeTasks = (state.tasks || []).filter((task) => !activePlanId || !task.planId || task.planId === activePlanId);
        return {
          missions,
          activeTasks,
          timeline: reconcileApprovalTimeline([...restoredTimeline, ...liveOnlyItems]),
          hydratedMissionId: missionId,
        };
      });

      const refreshedMission = get().missions.find((mission) => mission.id === missionId);
      if (refreshedMission && AUTO_DRAIN_CONVERSATION_STATUSES.has(refreshedMission.status)) {
        void get().drainQueuedTurn(missionId);
      }
    } catch (error: any) {
      if (get().activeMissionId === missionId) set({ error: error?.message || 'Failed to load mission state.' });
    }
  },

  startMission: async (request, workspaceId, options) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    set({ loading: true, error: null });

    const userMessage: TimelineItem = {
      id: crypto.randomUUID(),
      type: 'user_message',
      content: trimmed,
      timestamp: nowLabel(),
      metadata: {
        targetRole: options?.targetRole,
        routeRole: options?.routeRole,
        routeScope: options?.routeScope,
        command: options?.command,
        modelCatalogId: options?.model,
        reasoningLevel: options?.reasoningLevel,
      },
    };
    useAgentStore.getState().setSelectedAgent(null);
    set({ timeline: [userMessage], activeTasks: [] });

    try {
      const data = await apiRequest<{ missionId: string; planId: string; tasks: TaskItem[]; status?: MissionStatus }>('/missions/start', {
        method: 'POST',
        body: JSON.stringify(requestBody(trimmed, workspaceId, options)),
      });

      const newMission: Mission = {
        id: data.missionId,
        workspaceId: workspaceId || 'default-workspace',
        title: trimmed,
        description: trimmed,
        status: data.status || 'running',
        createdAt: new Date().toISOString(),
        taskCount: data.tasks?.length || 0,
        planId: data.planId,
      };

      useAgentStore.getState().clearMissionAgents(data.missionId);
      set((state) => ({
        missions: [newMission, ...state.missions.filter((mission) => mission.id !== newMission.id)],
        activeMissionId: data.missionId,
        hydratedMissionId: data.missionId,
        activeTasks: data.tasks || [],
        loading: false,
      }));

      void get().fetchMissionState(data.missionId);
    } catch (error: any) {
      const errorCard: TimelineItem = {
        id: crypto.randomUUID(),
        type: 'event',
        content: `Mission could not start: ${error?.message || 'The local AtrisAgent service is unavailable.'}`,
        timestamp: nowLabel(),
        eventType: 'mission_failed',
        agentRole: 'orchestrator',
      };
      set((state) => ({
        timeline: [...state.timeline, errorCard],
        loading: false,
        error: error?.message || 'Mission start failed.',
      }));
    }
  },

  continueMission: async (missionId, request, options, skipOptimisticUserMessage = false) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    const mission = get().missions.find((item) => item.id === missionId);
    if (!mission) {
      set({ error: 'The selected conversation no longer exists.' });
      return;
    }
    if (!TERMINAL_CONVERSATION_STATUSES.has(mission.status)) {
      set({ error: 'The current turn is still executing. Send the request through the queued-turn path instead.' });
      return;
    }

    const userMessage: TimelineItem = {
      id: crypto.randomUUID(),
      type: 'user_message',
      content: trimmed,
      timestamp: nowLabel(),
      metadata: {
        targetRole: options?.targetRole,
        routeRole: options?.routeRole,
        routeScope: options?.routeScope,
        command: options?.command,
        modelCatalogId: options?.model,
        reasoningLevel: options?.reasoningLevel,
      },
    };

    set((state) => ({
      loading: true,
      error: null,
      activeTasks: [],
      timeline: skipOptimisticUserMessage ? state.timeline : [...state.timeline, userMessage],
      missions: state.missions.map((item) => item.id === missionId ? { ...item, status: 'planning' } : item),
    }));

    try {
      const data = await apiRequest<{ missionId: string; planId: string; tasks: TaskItem[] }>(`/missions/${missionId}/start`, {
        method: 'POST',
        body: JSON.stringify(requestBody(trimmed, mission.workspaceId, options)),
      });

      set((state) => ({
        loading: false,
        activeMissionId: missionId,
        hydratedMissionId: null,
        activeTasks: data.tasks || [],
        missions: state.missions.map((item) => item.id === missionId
          ? { ...item, status: 'running', planId: data.planId, taskCount: data.tasks?.length || 0 }
          : item),
      }));
      await get().fetchMissionState(missionId);
    } catch (error: any) {
      const errorCard: TimelineItem = {
        id: crypto.randomUUID(),
        type: 'event',
        content: `Conversation turn could not start: ${error?.message || 'The local AtrisAgent service is unavailable.'}`,
        timestamp: nowLabel(),
        eventType: 'mission_failed',
        agentRole: 'orchestrator',
      };
      set((state) => ({
        timeline: [...state.timeline, errorCard],
        missions: state.missions.map((item) => item.id === missionId ? mission : item),
        loading: false,
        error: error?.message || 'Conversation continuation failed.',
      }));
    }
  },

  queueMissionTurn: (missionId, request, options) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    const queueId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    const userMessage: TimelineItem = {
      id: `queued-user-${queueId}`,
      type: 'user_message',
      content: trimmed,
      timestamp: nowLabel(),
      metadata: {
        queued: true,
        queueId,
        targetRole: options?.targetRole,
        routeRole: options?.routeRole,
        routeScope: options?.routeScope,
        command: options?.command,
        modelCatalogId: options?.model,
        reasoningLevel: options?.reasoningLevel,
      },
    };
    const queuedCard: TimelineItem = {
      id: `queued-event-${queueId}`,
      type: 'event',
      content: 'Queued for the next conversation turn. The current agents will finish first.',
      timestamp: nowLabel(),
      eventType: 'turn_queued',
      agentRole: 'orchestrator',
      metadata: { queueId },
    };
    set((state) => ({
      error: null,
      queuedTurns: [...state.queuedTurns, { id: queueId, missionId, request: trimmed, options, queuedAt }],
      timeline: [...state.timeline, userMessage, queuedCard],
    }));
  },

  drainQueuedTurn: async (missionId) => {
    if (drainingQueuedMissions.has(missionId)) return;
    const state = get();
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission || !AUTO_DRAIN_CONVERSATION_STATUSES.has(mission.status)) return;
    const next = state.queuedTurns.find((item) => item.missionId === missionId);
    if (!next) return;

    drainingQueuedMissions.add(missionId);
    set((current) => ({
      queuedTurns: current.queuedTurns.filter((item) => item.id !== next.id),
      timeline: current.timeline.map((item) => {
        if (item.metadata?.queueId !== next.id) return item;
        if (item.type === 'user_message') {
          return { ...item, metadata: { ...item.metadata, queued: false, starting: true } };
        }
        if (item.eventType === 'turn_queued') {
          return { ...item, eventType: 'turn_started', content: 'Queued turn is starting now.' };
        }
        return item;
      }),
    }));

    try {
      await get().continueMission(missionId, next.request, next.options, true);
    } finally {
      drainingQueuedMissions.delete(missionId);
    }
  },

  deleteMission: async (id) => {
    try {
      await apiRequest(`/missions/${id}`, { method: 'DELETE' });
      useAgentStore.getState().clearMissionAgents(id);
      set((state) => {
        const wasActive = state.activeMissionId === id;
        return {
          missions: state.missions.filter((mission) => mission.id !== id),
          queuedTurns: state.queuedTurns.filter((turn) => turn.missionId !== id),
          error: null,
          ...(wasActive ? {
            activeMissionId: null,
            hydratedMissionId: null,
            timeline: [],
            activeTasks: [],
          } : {}),
        };
      });
      return true;
    } catch (error: any) {
      set({ error: error?.message || 'Conversation deletion failed.' });
      return false;
    }
  },

  addMission: (mission) => set((state) => ({ missions: [mission, ...state.missions.filter((item) => item.id !== mission.id)] })),

  setActiveMission: (id) => {
    if (!id) return;
    const sameMission = get().activeMissionId === id;
    if (!sameMission) useAgentStore.getState().setSelectedAgent(null);
    set({
      activeMissionId: id,
      error: null,
      ...(sameMission ? {} : { timeline: [], activeTasks: [], hydratedMissionId: null }),
    });
    if (!sameMission || get().hydratedMissionId !== id) void get().fetchMissionState(id);
  },

  clearActiveMission: () => {
    useAgentStore.getState().setSelectedAgent(null);
    set({ activeMissionId: null, hydratedMissionId: null, timeline: [], activeTasks: [] });
  },

  updateMissionStatus: (id, status) => set((state) => ({
    missions: state.missions.map((mission) => mission.id === id ? { ...mission, status } : mission),
  })),

  addTimelineItem: (item) => set((state) => state.timeline.some((entry) => entry.id === item.id)
    ? state
    : { timeline: reconcileApprovalTimeline([...state.timeline, item]) }),
  setTasks: (tasks) => set({ activeTasks: tasks }),
  patchTask: (id, updates) => set((state) => ({
    activeTasks: state.activeTasks.map((task) => task.id === id ? { ...task, ...updates } : task),
  })),

  pauseMission: async () => {
    set({ error: 'Pause/resume is not exposed until every configured runtime supports safe resumable cancellation. Use Stop to cancel the current mission.' });
  },

  stopMission: async (id) => {
    try {
      const mission = await apiRequest<Mission>(`/missions/${id}/cancel`, { method: 'POST' });
      set((state) => {
        const cancelledQueueIds = new Set(state.queuedTurns
          .filter((turn) => turn.missionId === id)
          .map((turn) => turn.id));
        return {
          missions: state.missions.map((item) => item.id === id ? mission : item),
          queuedTurns: state.queuedTurns.filter((turn) => turn.missionId !== id),
          timeline: state.timeline.map((item) => {
            const queueId = typeof item.metadata?.queueId === 'string' ? item.metadata.queueId : undefined;
            if (!queueId || !cancelledQueueIds.has(queueId)) return item;
            if (item.type === 'user_message') {
              return { ...item, metadata: { ...item.metadata, queued: false, cancelled: true } };
            }
            return {
              ...item,
              eventType: 'turn_cancelled',
              content: 'Queued turn cancelled with the mission.',
              metadata: { ...item.metadata, queued: false, cancelled: true },
            };
          }),
        };
      });
    } catch (error: any) {
      set({ error: error?.message || 'Mission cancellation failed.' });
    }
  },

  retryMission: async (id) => {
    try {
      await apiRequest(`/missions/${id}/retry`, { method: 'POST' });
      set((state) => ({ missions: state.missions.map((mission) => mission.id === id ? { ...mission, status: 'running' } : mission) }));
      await get().fetchMissionState(id);
    } catch (error: any) {
      set({ error: error?.message || 'Mission retry failed.' });
    }
  },
}));
