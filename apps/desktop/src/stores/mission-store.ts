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
}

export interface TaskItem {
  id: string;
  missionId: string;
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
  command?: string;
}

interface MissionState {
  missions: Mission[];
  activeMissionId: string | null;
  hydratedMissionId: string | null;
  timeline: TimelineItem[];
  activeTasks: TaskItem[];
  loading: boolean;
  error: string | null;
  fetchMissions: (workspaceId?: string) => Promise<void>;
  fetchMissionState: (missionId: string) => Promise<void>;
  startMission: (request: string, workspaceId?: string, options?: StartMissionOptions) => Promise<void>;
  deleteMission: (id: string) => Promise<boolean>;
  addMission: (mission: Mission) => void;
  setActiveMission: (id: string) => void;
  clearActiveMission: () => void;
  updateMissionStatus: (id: string, status: MissionStatus) => void;
  addTimelineItem: (item: TimelineItem) => void;
  setTasks: (tasks: TaskItem[]) => void;
  pauseMission: (id: string) => Promise<void>;
  stopMission: (id: string) => Promise<void>;
  retryMission: (id: string) => Promise<void>;
  missionFilter: 'all' | 'active' | 'review' | 'blocked';
  setMissionFilter: (filter: 'all' | 'active' | 'review' | 'blocked') => void;
  composerInput?: string;
  setComposerInput: (input: string) => void;
}

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
    case 'mission_started': return `Mission started: ${event.title || event.missionId}`;
    case 'plan_generated': return event.summary || `Generated ${event.taskCount || 0} tasks.`;
    case 'plan_revised': return `Plan revised: ${event.reason || 'Execution evidence changed the plan.'}`;
    case 'task_created': return `Task ready: ${event.title || event.taskId}`;
    case 'task_assigned': return `Task assigned to ${event.role}: ${event.taskId}`;
    case 'task_split': return `Task split into ${event.childTaskIds?.length || 0} focused tasks: ${event.reason || ''}`;
    case 'task_merged': return `Tasks merged into ${event.mergedTaskId}: ${event.reason || ''}`;
    case 'agent_spawned': return `${event.displayName || event.role || 'Agent'} spawned: ${event.spawnReason || 'Specialized work required.'}`;
    case 'agent_started': return `${event.displayName || event.role || 'Agent'} started with ${event.model || 'a runtime-selected model'}.`;
    case 'agent_progressed': return event.progress || 'Agent progress updated.';
    case 'agent_waiting': return `Agent waiting: ${event.reason || 'Waiting for a dependency.'}`;
    case 'agent_resumed': return `Agent resumed${event.reason ? `: ${event.reason}` : '.'}`;
    case 'agent_completed': return event.summary || 'Agent completed its execution.';
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
    case 'approval_responded': return `Approval ${event.approved ? 'approved' : 'rejected'} by ${event.decidedBy || 'user'}.`;
    case 'verification_started': return 'Verification started.';
    case 'verification_finding': return `${String(event.severity || 'finding').toUpperCase()}: ${event.title || event.description || ''}`;
    case 'verification_completed': return `${event.passed ? 'Verification passed' : 'Verification found issues'} — ${event.summary || `${event.findingCount || 0} findings`}`;
    case 'review_completed': return event.approved ? 'Review approved.' : `Review requested changes: ${event.findings || ''}`;
    case 'revision_requested': return `Revision returned to the Builder: ${event.reason || ''}`;
    case 'check_completed': return `${event.checkName || 'Check'}: ${event.passed ? 'passed' : 'failed'} — ${event.summary || ''}`;
    case 'changes_applied': return `Changes applied. ${event.filesChanged || 0} files changed.`;
    case 'task_completed': return `Task completed: ${event.taskId}`;
    case 'task_failed': case 'agent_error': return `Execution failed: ${event.error || 'Unknown runtime error'}`;
    case 'mission_completed': return event.summary || 'Mission completed.';
    case 'mission_failed': return `Mission failed: ${event.reason || 'Unknown error'}`;
    default: return `Event: ${event.type}`;
  }
}

function timelineFromEvent(event: Record<string, any>): TimelineItem {
  const date = event.timestamp ? new Date(event.timestamp) : new Date();
  return {
    id: event.id || crypto.randomUUID(),
    type: event.type === 'text_delta' || event.type === 'mission_completed' ? 'orchestrator_message' : 'event',
    content: eventLabel(event),
    timestamp: Number.isNaN(date.getTime()) ? nowLabel() : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    eventType: event.type,
    agentRole: event.role || event.agentRole
      || (event.type?.includes('verification') || event.type?.includes('review') ? 'reviewer' : event.type?.includes('check') ? 'qa' : undefined),
    metadata: event,
  };
}

export const useMissionStore = create<MissionState>((set, get) => ({
  missions: [],
  activeMissionId: null,
  hydratedMissionId: null,
  timeline: [],
  activeTasks: [],
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
      restoredTimeline.push(...events.map(timelineFromEvent));

      useAgentStore.getState().hydrateMissionFromEvents(missionId, events);

      set((current) => {
        const missions = state.mission
          ? current.missions.some((mission) => mission.id === missionId)
            ? current.missions.map((mission) => mission.id === missionId ? { ...mission, ...state.mission! } : mission)
            : [state.mission!, ...current.missions]
          : current.missions;

        if (current.activeMissionId !== missionId) return { missions };
        return {
          missions,
          activeTasks: state.tasks || [],
          timeline: restoredTimeline,
          hydratedMissionId: missionId,
        };
      });
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
        body: JSON.stringify({
          request: trimmed,
          title: trimmed,
          workspaceId,
          modelCatalogId: options?.model || undefined,
          reasoningLevel: options?.reasoningLevel || undefined,
          teamTemplate: options?.teamTemplate,
          trustMode: options?.trustMode,
          executionMode: toExecutionMode(options),
          targetRole: options?.targetRole,
          routeRole: options?.routeRole,
          command: options?.command,
        }),
      });

      const newMission: Mission = {
        id: data.missionId,
        workspaceId: workspaceId || 'default-workspace',
        title: trimmed,
        description: trimmed,
        status: data.status || 'running',
        createdAt: new Date().toISOString(),
        taskCount: data.tasks?.length || 0,
      };

      useAgentStore.getState().clearMissionAgents(data.missionId);
      set((state) => ({
        missions: [newMission, ...state.missions.filter((mission) => mission.id !== newMission.id)],
        activeMissionId: data.missionId,
        hydratedMissionId: data.missionId,
        activeTasks: data.tasks || [],
        loading: false,
      }));
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

  deleteMission: async (id) => {
    try {
      await apiRequest(`/missions/${id}`, { method: 'DELETE' });
      useAgentStore.getState().clearMissionAgents(id);
      set((state) => {
        const wasActive = state.activeMissionId === id;
        return {
          missions: state.missions.filter((mission) => mission.id !== id),
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
    : { timeline: [...state.timeline, item] }),
  setTasks: (tasks) => set({ activeTasks: tasks }),

  pauseMission: async () => {
    set({ error: 'Pause/resume is not exposed until every configured runtime supports safe resumable cancellation. Use Stop to cancel the current mission.' });
  },

  stopMission: async (id) => {
    try {
      const mission = await apiRequest<Mission>(`/missions/${id}/cancel`, { method: 'POST' });
      set((state) => ({ missions: state.missions.map((item) => item.id === id ? mission : item) }));
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
