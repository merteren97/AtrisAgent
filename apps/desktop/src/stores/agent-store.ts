import { create } from 'zustand';

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AgentWorkspaceMode = 'shared' | 'isolated_worktree' | 'read_only';

export interface AgentInstance {
  id: string;
  missionId: string;
  role: string;
  model: string;
  status: AgentStatus;
  parentAgentId?: string | null;
  displayName?: string;
  specialty?: string;
  taskId?: string | null;
  spawnReason?: string;
  workspaceMode?: AgentWorkspaceMode;
  statusMessage?: string;
  progress?: number;
  unreadMessages?: number;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  lastActivityAt?: string;
}

interface AgentState {
  agents: AgentInstance[];
  selectedAgentId: string | null;
  addAgent: (agent: AgentInstance) => void;
  upsertAgent: (agent: AgentInstance) => void;
  patchAgent: (id: string, patch: Partial<AgentInstance>) => void;
  updateAgentStatus: (id: string, status: AgentStatus) => void;
  removeAgent: (id: string) => void;
  clearMissionAgents: (missionId: string) => void;
  hydrateMissionFromEvents: (missionId: string, events: Array<Record<string, any>>) => void;
  getAgentsByMission: (missionId: string) => AgentInstance[];
  setSelectedAgent: (id: string | null) => void;
  selectMissionDefaultAgent: (missionId: string) => void;
}

function defaultName(role?: string): string {
  if (!role) return 'Agent';
  if (role.toLowerCase() === 'qa') return 'QA Agent';
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} Agent`;
}

function mergeDefined<T extends object>(current: T, patch: Partial<T>): T {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
  return { ...current, ...defined };
}

function applyEvent(map: Map<string, AgentInstance>, missionId: string, event: Record<string, any>): void {
  const agentId = event.agentInstanceId as string | undefined;
  const existing = agentId ? map.get(agentId) : undefined;
  const timestamp = event.timestamp as string | undefined;

  // Cancellation is terminal for the local projection even if a buffered
  // runtime event is replayed after the process was asked to stop.
  if (existing?.status === 'cancelled' && event.type !== 'agent_cancelled') return;

  if (event.type === 'agent_spawned' && agentId) {
    map.set(agentId, {
      id: agentId,
      missionId,
      role: event.role || 'builder',
      model: event.model || 'Scheduler selected',
      status: 'idle',
      parentAgentId: event.parentAgentId ?? null,
      displayName: event.displayName || defaultName(event.role),
      specialty: event.specialty,
      taskId: event.taskId ?? null,
      spawnReason: event.spawnReason,
      workspaceMode: event.workspaceMode,
      progress: 0,
      unreadMessages: 0,
      createdAt: timestamp,
      lastActivityAt: timestamp,
    });
    return;
  }

  if (event.type === 'agent_started' && agentId) {
    map.set(agentId, {
      id: agentId,
      missionId,
      role: event.role || existing?.role || 'builder',
      model: event.model || existing?.model || 'Runtime selected',
      status: 'running',
      parentAgentId: event.parentAgentId ?? existing?.parentAgentId ?? null,
      displayName: event.displayName || existing?.displayName || defaultName(event.role || existing?.role),
      specialty: event.specialty || existing?.specialty,
      taskId: event.taskId ?? existing?.taskId ?? null,
      spawnReason: event.spawnReason || existing?.spawnReason,
      workspaceMode: event.workspaceMode || existing?.workspaceMode,
      statusMessage: existing?.statusMessage || 'Runtime started',
      progress: existing?.progress ?? 0,
      unreadMessages: existing?.unreadMessages ?? 0,
      createdAt: existing?.createdAt || timestamp,
      startedAt: timestamp,
      lastActivityAt: timestamp,
    });
    return;
  }

  if (event.type === 'agent_message_sent') {
    const target = map.get(event.toAgentId);
    if (target) map.set(target.id, { ...target, unreadMessages: (target.unreadMessages || 0) + 1, lastActivityAt: timestamp });
    const sender = map.get(event.fromAgentId);
    if (sender) map.set(sender.id, { ...sender, lastActivityAt: timestamp });
    return;
  }

  if (event.type === 'agent_message_read') {
    const target = agentId ? map.get(agentId) : undefined;
    if (target) map.set(target.id, { ...target, unreadMessages: Math.max(0, (target.unreadMessages || 0) - 1), lastActivityAt: timestamp });
    return;
  }

  if (!existing || !agentId) return;

  if (event.type === 'agent_progressed') {
    map.set(agentId, {
      ...existing,
      status: 'running',
      statusMessage: event.progress || existing.statusMessage,
      progress: typeof event.percentage === 'number' ? event.percentage : existing.progress,
      lastActivityAt: timestamp,
    });
  } else if (event.type === 'agent_waiting') {
    map.set(agentId, { ...existing, status: 'waiting', statusMessage: event.reason, lastActivityAt: timestamp });
  } else if (event.type === 'agent_resumed') {
    map.set(agentId, { ...existing, status: 'running', statusMessage: event.reason || 'Resumed', lastActivityAt: timestamp });
  } else if (event.type === 'agent_completed') {
    map.set(agentId, { ...existing, status: 'completed', statusMessage: event.summary || 'Completed', progress: 100, completedAt: timestamp, lastActivityAt: timestamp });
  } else if (event.type === 'agent_error') {
    map.set(agentId, { ...existing, statusMessage: event.error || 'Runtime diagnostic', lastActivityAt: timestamp });
  } else if (event.type === 'task_failed') {
    map.set(agentId, { ...existing, status: 'failed', statusMessage: event.error || 'Execution failed', completedAt: timestamp, lastActivityAt: timestamp });
  } else if (event.type === 'agent_cancelled') {
    map.set(agentId, { ...existing, status: 'cancelled', statusMessage: event.reason || 'Mission cancelled', completedAt: timestamp, lastActivityAt: timestamp });
  } else if (event.type === 'tool_call_started') {
    map.set(agentId, { ...existing, statusMessage: `Using ${event.toolName || 'tool'}`, lastActivityAt: timestamp });
  } else if (event.type === 'tool_call_completed') {
    map.set(agentId, { ...existing, statusMessage: `${event.toolName || 'Tool'} ${event.success ? 'completed' : 'failed'}`, lastActivityAt: timestamp });
  } else if (event.type === 'text_delta' || event.type === 'agent_thought') {
    map.set(agentId, { ...existing, lastActivityAt: timestamp });
  }
}

function defaultAgentForMission(agents: AgentInstance[], missionId: string): AgentInstance | undefined {
  const missionAgents = agents.filter((agent) => agent.missionId === missionId);
  return missionAgents.find((agent) => agent.role.toLowerCase() === 'orchestrator' && !agent.parentAgentId)
    || missionAgents.find((agent) => !agent.parentAgentId)
    || missionAgents[0];
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  selectedAgentId: null,

  addAgent: (agent) => set((state) => state.agents.some((item) => item.id === agent.id)
    ? state
    : { agents: [...state.agents, agent] }),

  upsertAgent: (agent) => set((state) => {
    const exists = state.agents.some((item) => item.id === agent.id);
    return {
      agents: exists
        ? state.agents.map((item) => item.id === agent.id ? mergeDefined(item, agent) : item)
        : [...state.agents, agent],
    };
  }),

  patchAgent: (id, patch) => set((state) => ({
    agents: state.agents.map((agent) => agent.id === id ? mergeDefined(agent, patch) : agent),
  })),

  updateAgentStatus: (id, status) => set((state) => ({
    agents: state.agents.map((agent) => agent.id === id ? { ...agent, status } : agent),
  })),

  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter((agent) => agent.id !== id),
    selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
  })),

  clearMissionAgents: (missionId) => set((state) => ({
    agents: state.agents.filter((agent) => agent.missionId !== missionId),
    selectedAgentId: state.agents.some((agent) => agent.id === state.selectedAgentId && agent.missionId === missionId)
      ? null
      : state.selectedAgentId,
  })),

  hydrateMissionFromEvents: (missionId, events) => set((state) => {
    const map = new Map<string, AgentInstance>();
    for (const event of events) {
      if (event.missionId && event.missionId !== missionId) continue;
      applyEvent(map, missionId, event);
    }
    const otherMissions = state.agents.filter((agent) => agent.missionId !== missionId);
    const missionAgents = [...map.values()];
    const agents = [...otherMissions, ...missionAgents];
    const selectionStillValid = missionAgents.some((agent) => agent.id === state.selectedAgentId);
    const fallback = defaultAgentForMission(agents, missionId);
    return {
      agents,
      selectedAgentId: selectionStillValid ? state.selectedAgentId : fallback?.id || state.selectedAgentId,
    };
  }),

  getAgentsByMission: (missionId) => get().agents.filter((agent) => agent.missionId === missionId),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  selectMissionDefaultAgent: (missionId) => set((state) => ({ selectedAgentId: defaultAgentForMission(state.agents, missionId)?.id || null })),
}));
